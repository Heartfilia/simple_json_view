/*
 * Copyright 2026 Heartfilia
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * 宽松 JSON 解析器
 *
 * 主线程（app.js）与解析 Worker（parser-worker.js）共用同一份实现，
 * 避免两处逻辑不一致导致「一边能解析、一边不能」。
 *
 * 设计要点：
 *   1. 快路径优先 —— 合法 JSON 只走一次 JSON.parse，不做任何归一化，
 *      避免旧实现里「无论是否合法都先跑一趟 normalizePythonLike」的浪费。
 *   2. 惰性候选 —— 只有解析失败时才逐级生成修复候选，代价随难度递增。
 *   3. 单趟修复 —— 注释、单引号、裸 key、数字 key、尾逗号、Python 字面量、
 *      全角标点、控制字符等在一次字符扫描里全部处理完，且全程字符串感知，
 *      不会误伤字符串内容。字符串内部按「连续段」整段搬运，不做逐字符拼接。
 *   4. 文本提取 —— 从混杂文本（日志 / 网页源码 / JSONP / 赋值语句）里
 *      按括号配对抠出 JSON 片段，解决「复制过来就是解析不了」的常见场景。
 *   5. 自动解转义 —— 整段是转义字符串时自动再解析一层。
 *   6. 精确定位 —— 自带 JSON 语法校验器定位出错行列，不依赖各版本
 *      V8 报错文案（Node 20+ 的报错已不再带 position）。
 *   7. Python 兜底 —— 标准 JSON 解析失败后才启用 Python 字面量解析，
 *      处理 tuple / set / bytes / datetime(...) 等 JSON 表达不了的结构。
 *      它排在宽松修复之前，避免 Python 写法先被修复器改坏。
 */

(function (root) {
  'use strict';

  /* ------------------------------ 字符码常量 ------------------------------ */

  const CODE_TAB = 9;
  const CODE_LF = 10;
  const CODE_CR = 13;
  const CODE_SPACE = 32;
  const CODE_HASH = 35;
  const CODE_DOLLAR = 36;
  const CODE_PLUS = 43;
  const CODE_COMMA = 44;
  const CODE_MINUS = 45;
  const CODE_DOT = 46;
  const CODE_SLASH = 47;
  const CODE_0 = 48;
  const CODE_9 = 57;
  const CODE_COLON = 58;
  const CODE_LPAREN = 40;
  const CODE_A = 65;
  const CODE_E = 69;
  const CODE_Z = 90;
  const CODE_LBRACKET = 91;
  const CODE_BACKSLASH = 92;
  const CODE_RBRACKET = 93;
  const CODE_UNDERSCORE = 95;
  const CODE_a = 97;
  const CODE_e = 101;
  const CODE_z = 122;
  const CODE_LBRACE = 123;
  const CODE_RBRACE = 125;
  const CODE_QUOTE_D = 34;
  const CODE_QUOTE_S = 39;
  const CODE_ASTERISK = 42;

  /* 全角标点 → 半角。只在字符串外替换，字符串内部原样保留。 */
  const FULLWIDTH_TO_ASCII = {
    0x201c: CODE_QUOTE_D,
    0x201d: CODE_QUOTE_D,
    0x2018: CODE_QUOTE_S,
    0x2019: CODE_QUOTE_S,
    0xff02: CODE_QUOTE_D,
    0xff07: CODE_QUOTE_S,
    0xff0c: CODE_COMMA,
    0xff1a: CODE_COLON,
    0xff5b: CODE_LBRACE,
    0xff5d: CODE_RBRACE,
    0xff3b: CODE_LBRACKET,
    0xff3d: CODE_RBRACKET,
    0x3000: CODE_SPACE
  };

  /*
   * 全角引号的开闭不是同一个字符（“ ” / ‘ ’），需要单独记住配对，
   * 否则 “abc” 会被当成「开了引号但永远闭不上」。
   */
  const FULLWIDTH_QUOTE_CLOSER = {
    0x201c: 0x201d,
    0x201d: 0x201d,
    0x2018: 0x2019,
    0x2019: 0x2019,
    0xff02: 0xff02,
    0xff07: 0xff07
  };

  const MAX_EXTRACT_SNIPPETS = 5;
  const MAX_UNWRAP_DEPTH = 2;
  const MAX_VALIDATE_DEPTH = 400;

  /* JSON 认得的转义字符，其余反斜杠一律按字面量处理 */
  const JSON_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

  /* -------------------------------- 小工具 -------------------------------- */

  function isWhitespaceCode(code) {
    return code === CODE_SPACE || code === CODE_TAB || code === CODE_LF || code === CODE_CR;
  }

  function isDigitCode(code) {
    return code >= CODE_0 && code <= CODE_9;
  }

  function isIdentifierStartCode(code) {
    return (
      (code >= CODE_A && code <= CODE_Z) ||
      (code >= CODE_a && code <= CODE_z) ||
      code === CODE_UNDERSCORE ||
      code === CODE_DOLLAR
    );
  }

  function isIdentifierPartCode(code) {
    return isIdentifierStartCode(code) || isDigitCode(code);
  }

  function isNumberCharCode(code) {
    return (
      isDigitCode(code) ||
      code === CODE_DOT ||
      code === CODE_PLUS ||
      code === CODE_MINUS ||
      code === CODE_e ||
      code === CODE_E
    );
  }

  /* 跳过空白，返回下一个有效字符码；没有则返回 -1。 */
  function nextSignificantCode(text, from) {
    for (let i = from; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (!isWhitespaceCode(code)) return code;
    }
    return -1;
  }

  function escapeControlChar(code) {
    if (code === CODE_LF) return '\\n';
    if (code === CODE_CR) return '\\r';
    if (code === CODE_TAB) return '\\t';
    if (code === 8) return '\\b';
    if (code === 12) return '\\f';
    return '\\u' + code.toString(16).padStart(4, '0');
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function skipToLineEnd(text, from) {
    const found = text.indexOf('\n', from);
    return found === -1 ? text.length : found;
  }

  function skipBlockComment(text, from) {
    const found = text.indexOf('*/', from);
    return found === -1 ? text.length : found + 2;
  }

  /* ------------------------------ 单趟宽松修复 ------------------------------ */

  /**
   * 把「看起来像 JSON 但不是 JSON」的文本修复成合法 JSON。
   *
   * 处理内容：
   *   - // 与 星号块注释、行首 # 注释
   *   - 单引号字符串（含内部撇号、双引号、控制字符）
   *   - 双引号字符串里的裸控制字符
   *   - 裸 key（{a: 1}）与数字 key（{1: 'x'}）
   *   - 尾逗号（[1,2,] / {"a":1,}）
   *   - Python 字面量 True / False / None / Ellipsis(...)
   *   - NaN / Infinity / -Infinity / undefined → null
   *   - 全角引号、逗号、冒号、括号、空格
   *
   * 全程区分「字符串内 / 字符串外」，不会改动字符串里的内容。
   */
  function repairLooseJson(text) {
    const len = text.length;
    const stack = [];
    let out = '';
    let index = 0;

    let inString = 0;
    let stringCloser = 0;
    /* 逗号与其后的空白先挂起：遇到 } ] 直接丢弃，从而天然吃掉尾逗号。 */
    let pending = '';
    let expectingKey = false;
    let atLineStart = true;

    while (index < len) {
      /* ---------- 字符串内部 ---------- */
      if (inString) {
        /* 整段搬运，只在遇到需要特殊处理的字符时才停下 */
        let runEnd = index;
        while (runEnd < len) {
          const c = text.charCodeAt(runEnd);
          if (c === CODE_BACKSLASH || c < 0x20) break;
          if (c === inString || c === stringCloser) break;
          if (inString === CODE_QUOTE_S && c === CODE_QUOTE_D) break;
          runEnd += 1;
        }
        if (runEnd > index) {
          out += text.slice(index, runEnd);
          index = runEnd;
          continue;
        }

        const code = text.charCodeAt(index);

        /*
         * 转义序列：必须把反斜杠和后一个字符一起处理。
         * 只保留 JSON 认得的转义，其余（如 C:\path 里的 \p）按字面反斜杠转义，
         * 否则修出来的文本仍然是非法 JSON。
         */
        if (code === CODE_BACKSLASH) {
          const nextIndex = index + 1;
          if (nextIndex >= len) {
            out += '\\\\';
            index += 1;
            continue;
          }

          const nextCode = text.charCodeAt(nextIndex);
          const nextChar = text[nextIndex];

          if (JSON_ESCAPE_CHARS.has(nextChar)) {
            out += '\\' + nextChar;
            index = nextIndex + 1;
            continue;
          }
          if (nextChar === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(nextIndex + 1, nextIndex + 5))) {
            out += text.slice(index, nextIndex + 5);
            index = nextIndex + 5;
            continue;
          }
          if (nextChar === "'") {
            /* \' 不是合法 JSON 转义，单引号串里它就是想表达一个撇号 */
            out += "'";
            index = nextIndex + 1;
            continue;
          }
          if (nextCode < 0x20) {
            out += escapeControlChar(nextCode);
            index = nextIndex + 1;
            continue;
          }
          out += '\\\\' + nextChar;
          index = nextIndex + 1;
          continue;
        }

        if (code === inString || code === stringCloser) {
          if (inString === CODE_QUOTE_S && code === CODE_QUOTE_S) {
            /*
             * 单引号串里的撇号（it's）不能直接当结尾。
             * 只有当后面紧跟分隔符或文本结束时才认为是闭合。
             */
            const next = nextSignificantCode(text, index + 1);
            const isClosing =
              next === -1 ||
              next === CODE_COMMA ||
              next === CODE_COLON ||
              next === CODE_RBRACE ||
              next === CODE_RBRACKET ||
              next === CODE_SLASH;
            if (!isClosing) {
              out += "'";
              index += 1;
              continue;
            }
          }
          inString = 0;
          stringCloser = 0;
          expectingKey = false;
          out += '"';
          index += 1;
          continue;
        }

        if (inString === CODE_QUOTE_S && code === CODE_QUOTE_D) {
          out += '\\"';
          index += 1;
          continue;
        }

        out += escapeControlChar(code);
        index += 1;
        continue;
      }

      /* ---------- 字符串外 ---------- */
      const rawCode = text.charCodeAt(index);
      const mapped = FULLWIDTH_TO_ASCII[rawCode];
      const code = mapped === undefined ? rawCode : mapped;
      const ch = mapped === undefined ? text[index] : String.fromCharCode(mapped);

      /* 空白 */
      if (isWhitespaceCode(code)) {
        if (pending) pending += ch;
        else out += ch;
        if (code === CODE_LF) atLineStart = true;
        index += 1;
        continue;
      }

      /* 注释 */
      if (code === CODE_SLASH && index + 1 < len) {
        const next = text.charCodeAt(index + 1);
        if (next === CODE_SLASH) {
          index = skipToLineEnd(text, index + 2);
          continue;
        }
        if (next === CODE_ASTERISK) {
          index = skipBlockComment(text, index + 2);
          continue;
        }
      }
      if (code === CODE_HASH && atLineStart) {
        index = skipToLineEnd(text, index + 1);
        continue;
      }

      atLineStart = false;

      /* 字符串开始 */
      if (code === CODE_QUOTE_D || code === CODE_QUOTE_S) {
        out += pending;
        pending = '';
        inString = code;
        stringCloser = mapped === undefined ? 0 : FULLWIDTH_QUOTE_CLOSER[rawCode] || 0;
        out += '"';
        index += 1;
        continue;
      }

      /* 结构字符 */
      if (code === CODE_LBRACE) {
        out += pending;
        pending = '';
        out += '{';
        stack.push('o');
        expectingKey = true;
        index += 1;
        continue;
      }
      if (code === CODE_LBRACKET) {
        out += pending;
        pending = '';
        out += '[';
        stack.push('a');
        expectingKey = false;
        index += 1;
        continue;
      }
      if (code === CODE_RBRACE || code === CODE_RBRACKET) {
        pending = '';
        out += ch;
        stack.pop();
        expectingKey = false;
        index += 1;
        continue;
      }
      if (code === CODE_COMMA) {
        pending = ',';
        expectingKey = stack[stack.length - 1] === 'o';
        index += 1;
        continue;
      }
      if (code === CODE_COLON) {
        out += pending;
        pending = '';
        out += ':';
        expectingKey = false;
        index += 1;
        continue;
      }

      /* Python 省略号 */
      if (code === CODE_DOT && text.startsWith('...', index)) {
        out += pending;
        pending = '';
        out += 'null';
        expectingKey = false;
        index += 3;
        continue;
      }

      /* 数字（可能是数字 key），以及 -Infinity / +Infinity 这类符号字面量 */
      if (code === CODE_MINUS || code === CODE_PLUS || isDigitCode(code)) {
        let end = index + 1;
        while (end < len && isNumberCharCode(text.charCodeAt(end))) end += 1;

        let token = text.slice(index, end);

        if ((token === '-' || token === '+') && isIdentifierStartCode(text.charCodeAt(end))) {
          let identEnd = end + 1;
          while (identEnd < len && isIdentifierPartCode(text.charCodeAt(identEnd))) identEnd += 1;
          const ident = text.slice(end, identEnd);
          if (ident === 'Infinity' || ident === 'NaN') token = 'null';
          else token = token + ident;
          end = identEnd;
        }

        out += pending;
        pending = '';

        if (expectingKey && token !== '-' && token !== '+') {
          out += '"' + token + '"';
          expectingKey = false;
        } else {
          out += token;
          expectingKey = false;
        }
        index = end;
        continue;
      }

      /* 标识符：字面量 / 裸 key */
      if (isIdentifierStartCode(code)) {
        let end = index + 1;
        while (end < len && isIdentifierPartCode(text.charCodeAt(end))) end += 1;

        const token = text.slice(index, end);
        out += pending;
        pending = '';

        if (expectingKey) {
          /* 合法 JSON 的 key 一定是字符串，所以此处必然是裸 key */
          out += '"' + token + '"';
          expectingKey = false;
          index = end;
          continue;
        }

        if (token === 'true' || token === 'false' || token === 'null') {
          out += token;
        } else if (token === 'True' || token === 'TRUE') {
          out += 'true';
        } else if (token === 'False' || token === 'FALSE') {
          out += 'false';
        } else if (token === 'None' || token === 'NULL' || token === 'Undefined') {
          out += 'null';
        } else if (token === 'NaN' || token === 'Infinity' || token === 'undefined') {
          out += 'null';
        } else {
          /* 其余裸标识符原样保留，交给 JSON.parse 报错 */
          out += token;
        }

        expectingKey = false;
        index = end;
        continue;
      }

      /* 兜底 */
      out += pending;
      pending = '';
      out += ch;
      index += 1;
    }

    return out;
  }

  /* ------------------------------ 文本内提取 ------------------------------ */

  /**
   * 从 `start` 处的 { 或 [ 开始做括号配对，返回配对字符的下标；不配对返回 -1。
   * 字符串（单双引号）与转义都会被正确跳过。
   */
  function matchBracket(text, start) {
    const stack = [];
    let quote = 0;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const code = text.charCodeAt(i);

      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote) {
        if (code === CODE_BACKSLASH) escaped = true;
        else if (code === quote) quote = 0;
        continue;
      }

      if (code === CODE_QUOTE_D || code === CODE_QUOTE_S) {
        quote = code;
        continue;
      }
      if (code === CODE_LBRACE || code === CODE_LBRACKET) {
        stack.push(code);
        continue;
      }
      if (code === CODE_RBRACE || code === CODE_RBRACKET) {
        stack.pop();
        if (!stack.length) return i;
        continue;
      }
    }

    return -1;
  }

  /**
   * 抠出文本里的 JSON 片段，只取最外层（配对的片段内部不再重复提取）。
   */
  function extractJsonSnippets(text, limit) {
    const max = limit || MAX_EXTRACT_SNIPPETS;
    const snippets = [];

    for (let i = 0; i < text.length && snippets.length < max; i += 1) {
      const code = text.charCodeAt(i);
      if (code !== CODE_LBRACE && code !== CODE_LBRACKET) continue;

      const end = matchBracket(text, i);
      if (end === -1) continue;

      snippets.push(text.slice(i, end + 1));
      i = end;
    }

    return snippets;
  }

  function looksLikeJsonContainer(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const code = trimmed.charCodeAt(0);
    return code === CODE_LBRACE || code === CODE_LBRACKET;
  }

  /* --------------------------- Python 字面量解析 --------------------------- */

  /*
   * Python 的 repr 并不都是 JSON：
   *   - tuple / set / bytes 不是 JSON 的合法结构
   *   - datetime.datetime(...) / Decimal('1.2') / UUID('...') 是构造函数调用
   *   - {1, 2} 是集合，不是对象
   *
   * 这些靠 repairLooseJson 修不出来，所以单独实现一个 Python 字面量解析器。
   * 它只在标准 JSON 解析失败后才启用，且排在宽松修复之前——否则
   * '''...'''、'\x41'、'a' 'b' 这类 Python 写法会先被修复器改坏。
   * 属于特殊流程，不会影响合法 JSON 的快路径。
   *
   * 输出统一转成 JSON 能表达的值：
   *   dict → object（非字符串 key 用 Python 的写法转成字符串）
   *   list / tuple / set → array
   *   bytes → 尽量按 UTF-8 解码成字符串
   *   datetime / Decimal / UUID / Path 等 → 可读字符串
   *   其他未知对象 → 保留原始 repr 文本
   */

  const PYTHON_MAX_DEPTH = 400;
  const PYTHON_OPERATOR_WORDS = ['if', 'else', 'and', 'or', 'in', 'is', 'for'];
  const PYTHON_NUMBER_PATTERNS = [
    /0[xX][0-9a-fA-F_]+/y,
    /0[oO][0-7_]+/y,
    /0[bB][01_]+/y,
    /(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/y
  ];
  const PYTHON_STRING_CALLS = new Set([
    'Decimal',
    'Fraction',
    'UUID',
    'Path',
    'PurePath',
    'PosixPath',
    'WindowsPath',
    'PurePosixPath',
    'PureWindowsPath',
    'IPv4Address',
    'IPv6Address',
    'IPv4Network',
    'IPv6Network'
  ]);

  function decodePythonBytes(value) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      bytes[i] = value.charCodeAt(i) & 0xff;
    }

    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        // 不是合法 UTF-8，退回逐字节的 latin1 展示
      }
    }

    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /* dict 的 key 必须是字符串，这里把 Python 的各种 key 转成可读写法。 */
  function pythonKeyToString(value) {
    if (typeof value === 'string') return value;
    if (value === null) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number') return String(value);

    if (Array.isArray(value)) {
      const inner = value.map(pythonKeyToString).join(', ');
      return `(${inner}${value.length === 1 ? ',' : ''})`;
    }

    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function padNumber(value) {
    return String(value).padStart(2, '0');
  }

  function formatPythonDatetime(args, kind) {
    const numbers = args.map((item) => (typeof item === 'number' ? item : 0));

    if (kind === 'time') {
      const hour = padNumber(numbers[0] || 0);
      const minute = padNumber(numbers[1] || 0);
      const second = padNumber(numbers[2] || 0);
      const clock = `${hour}:${minute}:${second}`;
      return numbers[3] ? `${clock}.${String(numbers[3]).padStart(6, '0')}` : clock;
    }

    const year = numbers[0] || 0;
    const month = padNumber(numbers[1] || 1);
    const day = padNumber(numbers[2] || 1);

    if (kind === 'date') return `${year}-${month}-${day}`;

    const hour = padNumber(numbers[3] || 0);
    const minute = padNumber(numbers[4] || 0);
    const second = padNumber(numbers[5] || 0);
    const micro = numbers[6] ? `.${String(numbers[6]).padStart(6, '0')}` : '';
    return `${year}-${month}-${day} ${hour}:${minute}:${second}${micro}`;
  }

  /**
   * 解析 Python 字面量。返回 { ok:true, value } 或 { ok:false, error }。
   */
  function parsePythonLiteral(input) {
    const text = String(input == null ? '' : input);
    const len = text.length;
    let pos = 0;

    function fail(reason) {
      const error = new Error(reason);
      error.position = pos;
      error.reason = reason;
      throw error;
    }

    function isIdentifierStartAt(index) {
      if (index >= len) return false;
      const code = text.charCodeAt(index);
      return (
        (code >= CODE_A && code <= CODE_Z) ||
        (code >= CODE_a && code <= CODE_z) ||
        code === CODE_UNDERSCORE
      );
    }

    function isIdentifierPartAt(index) {
      if (index >= len) return false;
      return isIdentifierStartAt(index) || isDigitCode(text.charCodeAt(index));
    }

    function skipSpace() {
      for (;;) {
        while (pos < len && isWhitespaceCode(text.charCodeAt(pos))) pos += 1;
        if (text.charCodeAt(pos) === CODE_HASH) {
          pos = skipToLineEnd(text, pos + 1);
          continue;
        }
        return;
      }
    }

    function readIdentifier() {
      const start = pos;
      while (pos < len && isIdentifierPartAt(pos)) pos += 1;
      if (pos === start) fail('这里期待一个值');
      return text.slice(start, pos);
    }

    /* 判断当前位置是不是字符串：可能带 r / b / u / f 或组合前缀。 */
    function stringStartIndex(index) {
      let cursor = index;
      while (cursor < len && cursor - index < 3) {
        const code = text.charCodeAt(cursor);
        if (
          code === 114 || code === 82 || /* r R */
          code === 98 || code === 66 ||  /* b B */
          code === 117 || code === 85 || /* u U */
          code === 102 || code === 70    /* f F */
        ) {
          cursor += 1;
          continue;
        }
        break;
      }
      const quote = text.charCodeAt(cursor);
      return quote === CODE_QUOTE_D || quote === CODE_QUOTE_S ? cursor : -1;
    }

    function readHexDigits(count, message) {
      const chunk = text.slice(pos, pos + count);
      if (chunk.length < count || !/^[0-9a-fA-F]+$/.test(chunk)) fail(message);
      pos += count;
      return chunk;
    }

    function parseString() {
      let isRaw = false;
      let isBytes = false;

      while (pos < len) {
        const code = text.charCodeAt(pos);
        if (code === 114 || code === 82) isRaw = true;
        else if (code === 98 || code === 66) isBytes = true;
        else if (code === 117 || code === 85) { /* u */ }
        else if (code === 102 || code === 70) { /* f */ }
        else break;
        pos += 1;
      }

      const quote = text[pos];
      const triple = text.startsWith(quote + quote + quote, pos);
      const closer = triple ? quote + quote + quote : quote;
      pos += closer.length;

      let out = '';

      while (pos < len) {
        if (text.startsWith(closer, pos)) {
          pos += closer.length;
          return isBytes ? decodePythonBytes(out) : out;
        }

        const code = text.charCodeAt(pos);

        if (code === CODE_BACKSLASH) {
          if (isRaw) {
            out += '\\';
            pos += 1;
            if (pos < len) {
              out += text[pos];
              pos += 1;
            }
            continue;
          }

          pos += 1;
          if (pos >= len) fail('转义字符不完整');
          const escaped = text[pos];
          pos += 1;

          if (escaped === '\n') continue;
          if (escaped === '\r') {
            if (text[pos] === '\n') pos += 1;
            continue;
          }

          switch (escaped) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'v': out += '\v'; break;
            case 'a': out += '\x07'; break;
            case '\\': out += '\\'; break;
            case "'": out += "'"; break;
            case '"': out += '"'; break;
            case 'x': out += String.fromCharCode(parseInt(readHexDigits(2, '\\x 转义不完整'), 16)); break;
            case 'u': out += String.fromCharCode(parseInt(readHexDigits(4, '\\u 转义不完整'), 16)); break;
            case 'U': {
              const codePoint = parseInt(readHexDigits(8, '\\U 转义不完整'), 16);
              out += codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
              break;
            }
            case 'N': {
              if (text[pos] === '{') {
                const end = text.indexOf('}', pos + 1);
                if (end === -1) fail('\\N 转义不完整');
                pos = end + 1;
                out += '?';
              } else {
                out += 'N';
              }
              break;
            }
            default: {
              if (escaped >= '0' && escaped <= '7') {
                let octal = escaped;
                while (octal.length < 3 && pos < len) {
                  const next = text[pos];
                  if (next < '0' || next > '7') break;
                  octal += next;
                  pos += 1;
                }
                out += String.fromCharCode(parseInt(octal, 8) & 0xff);
              } else {
                /* Python 对不认识的转义会保留反斜杠，例如 C:\path */
                out += '\\' + escaped;
              }
            }
          }
          continue;
        }

        out += text[pos];
        pos += 1;
      }

      fail('字符串缺少结尾引号');
    }

    function parseNumber() {
      let sign = '';
      if (text[pos] === '+' || text[pos] === '-') {
        sign = text[pos];
        pos += 1;
      }

      if (text.startsWith('Infinity', pos)) {
        pos += 8;
        return null;
      }
      if (text.startsWith('inf', pos)) {
        pos += 3;
        return null;
      }
      if (text.startsWith('NaN', pos) || text.startsWith('nan', pos)) {
        pos += 3;
        return null;
      }

      let match = null;
      for (let i = 0; i < PYTHON_NUMBER_PATTERNS.length; i += 1) {
        const pattern = PYTHON_NUMBER_PATTERNS[i];
        pattern.lastIndex = pos;
        const found = pattern.exec(text);
        if (found && found.index === pos) {
          match = found;
          break;
        }
      }

      if (!match) {
        /* +True / -False 这类写法不常见，按原样返回文本 */
        if (isIdentifierStartAt(pos)) {
          const identifier = readIdentifier();
          return sign + identifier;
        }
        fail('数字格式不正确');
      }

      const literal = match[0].replace(/_/g, '');
      pos += match[0].length;

      /* Python 的虚数字面量（1j / 2.5j）JSON 表达不了，保留成字符串 */
      if (text[pos] === 'j' || text[pos] === 'J') {
        pos += 1;
        return `${sign}${literal}j`;
      }

      let value;
      if (/^0[xX]/.test(literal)) value = parseInt(literal.slice(2), 16);
      else if (/^0[oO]/.test(literal)) value = parseInt(literal.slice(2), 8);
      else if (/^0[bB]/.test(literal)) value = parseInt(literal.slice(2), 2);
      else value = Number(literal);

      if (Number.isNaN(value)) return null;
      return sign === '-' ? -value : value;
    }

    function captureBalanced(openIndex) {
      let depth = 1;
      let quote = 0;
      let escaped = false;

      for (let i = pos; i < len; i += 1) {
        const code = text.charCodeAt(i);

        if (escaped) {
          escaped = false;
          continue;
        }

        if (quote) {
          if (code === CODE_BACKSLASH) escaped = true;
          else if (code === quote) quote = 0;
          continue;
        }

        if (code === CODE_QUOTE_D || code === CODE_QUOTE_S) {
          quote = code;
          continue;
        }
        if (code === CODE_LPAREN) depth += 1;
        else if (code === 41) {
          depth -= 1;
          if (depth === 0) {
            const inner = text.slice(openIndex + 1, i);
            pos = i + 1;
            return inner;
          }
        }
      }

      fail('括号没有闭合');
    }

    function parseParen(depth) {
      const openIndex = pos;
      pos += 1;
      skipSpace();

      if (text[pos] === ')') {
        pos += 1;
        return [];
      }

      const first = parseValue(depth + 1);
      skipSpace();

      if (text[pos] === ',') {
        const items = [first];
        while (text[pos] === ',') {
          pos += 1;
          skipSpace();
          if (text[pos] === ')') break;
          items.push(parseValue(depth + 1));
          skipSpace();
        }
        if (text[pos] !== ')') fail('元组缺少右括号');
        pos += 1;
        return items;
      }

      if (text[pos] === ')') {
        pos += 1;
        return first;
      }

      /* (1+2j) 这类表达式：整体保留成字符串 */
      return captureBalanced(openIndex);
    }

    function parseList(depth) {
      pos += 1;
      const items = [];
      skipSpace();

      if (text[pos] === ']') {
        pos += 1;
        return items;
      }

      for (;;) {
        items.push(parseValue(depth + 1));
        skipSpace();

        if (text[pos] === ',') {
          pos += 1;
          skipSpace();
          if (text[pos] === ']') break;
          continue;
        }
        break;
      }

      if (text[pos] !== ']') fail('列表缺少右方括号');
      pos += 1;
      return items;
    }

    function parseDictOrSet(depth) {
      pos += 1;
      skipSpace();

      if (text[pos] === '}') {
        pos += 1;
        return {};
      }

      const first = parseValue(depth + 1);
      skipSpace();

      if (text[pos] === ':') {
        const result = {};
        pos += 1;
        result[pythonKeyToString(first)] = parseValue(depth + 1);
        skipSpace();

        while (text[pos] === ',') {
          pos += 1;
          skipSpace();
          if (text[pos] === '}') break;

          const key = parseValue(depth + 1);
          skipSpace();
          if (text[pos] !== ':') fail('字典项缺少冒号');
          pos += 1;
          result[pythonKeyToString(key)] = parseValue(depth + 1);
          skipSpace();
        }

        if (text[pos] !== '}') fail('字典缺少右花括号');
        pos += 1;
        return result;
      }

      /* 没有冒号，说明是 {1, 2} 这样的集合 */
      const items = [first];
      while (text[pos] === ',') {
        pos += 1;
        skipSpace();
        if (text[pos] === '}') break;
        items.push(parseValue(depth + 1));
        skipSpace();
      }

      if (text[pos] !== '}') fail('集合缺少右花括号');
      pos += 1;
      return items;
    }

    function buildCall(name, args, kwargs, startIndex) {
      const shortName = name.indexOf('.') === -1 ? name : name.slice(name.lastIndexOf('.') + 1);
      const rawText = () => text.slice(startIndex, pos);

      if (
        shortName === 'list' ||
        shortName === 'tuple' ||
        shortName === 'set' ||
        shortName === 'frozenset' ||
        shortName === 'deque' ||
        shortName === 'array'
      ) {
        const last = args[args.length - 1];
        return Array.isArray(last) ? last : args;
      }

      if (
        shortName === 'dict' ||
        shortName === 'OrderedDict' ||
        shortName === 'defaultdict' ||
        shortName === 'Counter' ||
        shortName === 'ChainMap'
      ) {
        for (let i = args.length - 1; i >= 0; i -= 1) {
          const item = args[i];
          if (item && typeof item === 'object' && !Array.isArray(item)) return item;
          if (
            Array.isArray(item) &&
            item.every((pair) => Array.isArray(pair) && pair.length === 2)
          ) {
            const result = {};
            item.forEach((pair) => {
              result[pythonKeyToString(pair[0])] = pair[1];
            });
            return result;
          }
        }
        return {};
      }

      if (shortName === 'range') {
        const numbers = args.filter((item) => typeof item === 'number');
        if (!numbers.length) return [];
        const startValue = numbers.length > 1 ? numbers[0] : 0;
        const stopValue = numbers.length > 1 ? numbers[1] : numbers[0];
        const stepValue = numbers.length > 2 ? numbers[2] : 1;
        if (stepValue === 0) return [];

        const result = [];
        const limit = 10000;
        if (stepValue > 0) {
          for (let value = startValue; value < stopValue && result.length < limit; value += stepValue) {
            result.push(value);
          }
        } else {
          for (let value = startValue; value > stopValue && result.length < limit; value += stepValue) {
            result.push(value);
          }
        }
        return result;
      }

      if (shortName === 'bytes' || shortName === 'bytearray') {
        const source = args[0];
        if (typeof source === 'string') return source;
        if (Array.isArray(source)) {
          let raw = '';
          for (let i = 0; i < source.length; i += 1) {
            raw += String.fromCharCode(source[i] & 0xff);
          }
          return decodePythonBytes(raw);
        }
        return '';
      }

      if (shortName === 'datetime' && name.indexOf('.') !== -1) {
        return formatPythonDatetime(args, 'datetime');
      }
      if ((shortName === 'date' || shortName === 'time') && name.indexOf('.') !== -1) {
        return formatPythonDatetime(args, shortName);
      }
      if (shortName === 'timedelta') {
        const parts = [];
        ['weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds', 'microseconds'].forEach((key) => {
          if (kwargs[key] !== undefined && kwargs[key] !== null) {
            parts.push(`${kwargs[key]} ${key}`);
          }
        });
        return parts.join(', ');
      }

      if (PYTHON_STRING_CALLS.has(shortName)) {
        if (shortName === 'Fraction') return args.map((item) => String(item)).join('/');
        return args.length ? String(args[0]) : '';
      }

      if (shortName === 'int') {
        if (!args.length) return 0;
        const source = args[0];
        if (typeof source === 'number') return Math.trunc(source);
        const base = typeof kwargs.base === 'number' ? kwargs.base : 10;
        const parsed = parseInt(String(source).replace(/_/g, ''), base);
        return Number.isNaN(parsed) ? 0 : parsed;
      }

      if (shortName === 'float') {
        if (!args.length) return 0;
        const source = args[0];
        if (typeof source === 'number') return source;
        const textValue = String(source).trim().toLowerCase();
        if (/^[+-]?(nan|inf|infinity)$/.test(textValue)) return null;
        const parsed = Number(textValue.replace(/_/g, ''));
        return Number.isNaN(parsed) ? 0 : parsed;
      }

      if (shortName === 'bool') return args.length ? Boolean(args[0]) : false;
      if (shortName === 'str') return args.length ? String(args[0]) : '';

      /* numpy / pandas 一类标量包装 */
      if (/^(np|numpy|pd|pandas)\./.test(name) && args.length) return args[0];

      /* 其他未知对象：保留原始 repr 文本，至少不会丢掉信息 */
      return rawText();
    }

    function parseCall(name, depth, startIndex) {
      pos += 1;
      const args = [];
      const kwargs = Object.create(null);
      skipSpace();

      if (text[pos] === ')') {
        pos += 1;
        return buildCall(name, args, kwargs, startIndex);
      }

      for (;;) {
        skipSpace();
        if (pos >= len || text[pos] === ')') break;

        if (text[pos] === '*' && text[pos + 1] === '*') {
          pos += 2;
          const value = parseValue(depth + 1);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(kwargs, value);
          }
        } else if (text[pos] === '*') {
          pos += 1;
          const value = parseValue(depth + 1);
          if (Array.isArray(value)) args.push(...value);
        } else {
          const save = pos;
          let isKeyword = false;
          let keyword = '';

          if (isIdentifierStartAt(pos)) {
            keyword = readIdentifier();
            skipSpace();
            if (text[pos] === '=' && text[pos + 1] !== '=') {
              pos += 1;
              isKeyword = true;
            } else {
              pos = save;
            }
          }

          if (isKeyword) {
            kwargs[keyword] = parseValue(depth + 1);
          } else {
            args.push(parseValue(depth + 1));
          }
        }

        skipSpace();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        break;
      }

      skipSpace();
      if (text[pos] !== ')') fail('函数调用缺少右括号');
      pos += 1;
      return buildCall(name, args, kwargs, startIndex);
    }

    function parseNameOrSpecial(depth) {
      const startIndex = pos;

      if (text.startsWith('...', pos)) {
        pos += 3;
        return null;
      }

      let name = readIdentifier();
      while (text[pos] === '.' && isIdentifierStartAt(pos + 1)) {
        pos += 1;
        name += '.' + readIdentifier();
      }

      skipSpace();
      if (text[pos] === '(') return parseCall(name, depth, startIndex);

      if (name === 'True') return true;
      if (name === 'False') return false;
      if (name === 'None' || name === 'Ellipsis' || name === 'NotImplemented' || name === 'undefined') {
        return null;
      }
      if (name === 'nan' || name === 'NaN' || name === 'inf' || name === 'Infinity') return null;

      /* Enum 成员（Color.RED）、类名等，保留原样 */
      return name;
    }

    function parseAngleRepr() {
      const start = pos;
      pos += 1;
      while (pos < len && text[pos] !== '>') pos += 1;
      if (pos >= len) fail('对象描述缺少 >');
      pos += 1;
      return text.slice(start, pos);
    }

    function isExpressionOperatorAt(index) {
      const ch = text[index];
      if (ch && '+-*/%&|^@<>=!~'.indexOf(ch) !== -1) return true;

      for (let i = 0; i < PYTHON_OPERATOR_WORDS.length; i += 1) {
        const word = PYTHON_OPERATOR_WORDS[i];
        if (text.startsWith(word, index) && !isIdentifierPartAt(index + word.length)) return true;
      }
      return false;
    }

    /* 形如 1+2j / 3 * 4 的表达式 JSON 表达不了，整体保留成字符串。 */
    function captureExpression(startIndex) {
      let depth = 0;
      let quote = 0;
      let escaped = false;
      let index = pos;

      for (; index < len; index += 1) {
        const code = text.charCodeAt(index);

        if (escaped) {
          escaped = false;
          continue;
        }
        if (quote) {
          if (code === CODE_BACKSLASH) escaped = true;
          else if (code === quote) quote = 0;
          continue;
        }
        if (code === CODE_QUOTE_D || code === CODE_QUOTE_S) {
          quote = code;
          continue;
        }
        if (code === CODE_LBRACE || code === CODE_LBRACKET || code === CODE_LPAREN) {
          depth += 1;
          continue;
        }
        if (code === CODE_RBRACE || code === CODE_RBRACKET || code === 41) {
          if (depth === 0) break;
          depth -= 1;
          continue;
        }
        if (depth === 0 && (code === CODE_COMMA || code === CODE_COLON)) break;
      }

      pos = index;
      return text.slice(startIndex, index).trim();
    }

    function parseValue(depth) {
      skipSpace();
      const startIndex = pos;
      let value = parseAtom(depth);

      /* Python 的相邻字符串会自动拼接：'a' 'b' → ab */
      if (typeof value === 'string') {
        skipSpace();
        while (stringStartIndex(pos) !== -1) {
          value += parseString();
          skipSpace();
        }
      }

      skipSpace();
      if (isExpressionOperatorAt(pos)) return captureExpression(startIndex);
      return value;
    }

    function parseAtom(depth) {
      if (depth > PYTHON_MAX_DEPTH) fail('嵌套层级过深');
      skipSpace();
      if (pos >= len) fail('内容不完整，这里还缺一个值');

      const code = text.charCodeAt(pos);

      if (text.startsWith('...', pos)) {
        pos += 3;
        return null;
      }
      if (code === CODE_LBRACE) return parseDictOrSet(depth);
      if (code === CODE_LBRACKET) return parseList(depth);
      if (code === CODE_LPAREN) return parseParen(depth);
      if (text[pos] === '<') return parseAngleRepr();
      if (stringStartIndex(pos) !== -1) return parseString();

      if (
        text[pos] === '+' ||
        text[pos] === '-' ||
        isDigitCode(code) ||
        (text[pos] === '.' && isDigitCode(text.charCodeAt(pos + 1)))
      ) {
        return parseNumber();
      }

      if (isIdentifierStartAt(pos)) return parseNameOrSpecial(depth);

      fail('这里期待一个值（字符串 / 数字 / 字典 / 列表 / 元组 / True / False / None）');
    }

    try {
      const value = parseValue(0);
      skipSpace();
      if (pos < len) fail('后面的内容无法解析');
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function looksLikePythonContainer(text) {
    if (typeof text !== 'string') return false;
    const code = nextSignificantCode(text, 0);
    if (code === CODE_LBRACE || code === CODE_LBRACKET || code === CODE_LPAREN) return true;

    /* 顶层也可能直接是 set() / OrderedDict([...]) / range(3) 这类容器构造 */
    return /^(set|frozenset|list|tuple|dict|OrderedDict|defaultdict|Counter|ChainMap|deque|range)\s*\(/.test(
      text
    );
  }

  /**
   * Python 兜底流程：只有常规解析全部失败后才会调用。
   * 只接受最外层是容器（dict / list / tuple / set）的结果，避免把普通文本误判成数据。
   */
  function tryParsePythonFallback(text) {
    if (looksLikePythonContainer(text)) {
      const direct = parsePythonLiteral(text);
      if (direct.ok && direct.value && typeof direct.value === 'object') {
        return { value: direct.value, mode: 'python-literal' };
      }
    }

    /* 前后带杂质（日志 / callback(...) / 赋值语句）时，从里面抠片段再试 */
    const snippets = extractJsonSnippets(text);
    for (let i = 0; i < snippets.length; i += 1) {
      if (snippets[i] === text) continue;
      const parsed = parsePythonLiteral(snippets[i]);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        return { value: parsed.value, mode: 'python-literal-extracted' };
      }
    }

    return null;
  }

  /**
   * 整段文本解析：只接受标准 JSON，或整段就是一个 Python 数据结构。
   *
   * 不做片段提取、不做宽松修复——用于判断「这个响应体本身是不是数据」，
   * 避免把 HTML / 日志里夹带的 JSON 片段当成接口返回值（服务端代理的安全边界）。
   */
  function parseStrictData(input) {
    const text = stripBom(String(input == null ? '' : input)).trim();
    if (!text) return { ok: false };

    try {
      return { ok: true, value: JSON.parse(text), mode: 'json' };
    } catch {
      // JSON 失败后再试 Python 字面量
    }

    const python = parsePythonLiteral(text);
    if (python.ok && python.value !== null && typeof python.value === 'object') {
      return { ok: true, value: python.value, mode: 'python-literal' };
    }

    return { ok: false };
  }

  /* ------------------------------- 候选流 ------------------------------- */

  /**
   * 按「代价递增」顺序惰性产出候选文本，命中即止。
   */
  function* candidateStream(text) {
    yield { text, mode: 'raw' };

    const firstCode = text.charCodeAt(0);
    const startsWithContainer = firstCode === CODE_LBRACE || firstCode === CODE_LBRACKET;

    const snippets = () => {
      const list = [];
      const found = extractJsonSnippets(text);
      for (let i = 0; i < found.length; i += 1) {
        if (found[i] !== text) list.push(found[i]);
      }
      return list;
    };

    if (startsWithContainer) {
      /* 整段看着就是 JSON，先修整段再退到提取 */
      const repaired = repairLooseJson(text);
      if (repaired !== text) yield { text: repaired, mode: 'repaired' };

      for (const snippet of snippets()) {
        yield { text: snippet, mode: 'extracted' };
        const repairedSnippet = repairLooseJson(snippet);
        if (repairedSnippet !== snippet) {
          yield { text: repairedSnippet, mode: 'extracted-repaired' };
        }
      }
      return;
    }

    /* 前后有明显杂质，优先提取 */
    const list = snippets();
    if (list.length) {
      for (const snippet of list) {
        yield { text: snippet, mode: 'extracted' };
        const repairedSnippet = repairLooseJson(snippet);
        if (repairedSnippet !== snippet) {
          yield { text: repairedSnippet, mode: 'extracted-repaired' };
        }
      }
      return;
    }

    const repaired = repairLooseJson(text);
    if (repaired !== text) yield { text: repaired, mode: 'repaired' };
  }

  /* ------------------------------ 语法校验定位 ------------------------------ */

  /**
   * 自带 JSON 语法校验器：返回第一个错误的位置与原因。
   *
   * 之所以不直接读 JSON.parse 的报错，是因为 Node 20+ / 新版 Chrome 的
   * V8 已把 `Unexpected token X in JSON at position N` 换成
   * `Unexpected token X, ..." is not valid JSON`，不再提供位置。
   */
  function locateJsonError(text) {
    const len = text.length;
    let i = 0;

    function fail(position, reason) {
      const error = new Error(reason);
      error.position = position;
      error.reason = reason;
      throw error;
    }

    function skipWhitespace() {
      while (i < len && isWhitespaceCode(text.charCodeAt(i))) i += 1;
    }

    function parseString() {
      i += 1;
      while (i < len) {
        const code = text.charCodeAt(i);
        if (code === CODE_QUOTE_D) {
          i += 1;
          return;
        }
        if (code === CODE_BACKSLASH) {
          const escapeStart = i;
          i += 1;
          if (i >= len) fail(escapeStart, '转义字符不完整');
          const escapeChar = text[i];
          if (JSON_ESCAPE_CHARS.has(escapeChar)) {
            i += 1;
            continue;
          }
          if (escapeChar === 'u') {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(escapeStart, 'Unicode 转义（\\uXXXX）不合法');
            i += 5;
            continue;
          }
          fail(escapeStart, '字符串里有非法的转义字符 \\' + escapeChar);
        }
        if (code < 0x20) fail(i, '字符串里有未转义的控制字符（换行 / Tab 等）');
        i += 1;
      }
      fail(len, '字符串缺少结尾引号');
    }

    function parseNumber() {
      const start = i;
      if (text.charCodeAt(i) === CODE_MINUS) i += 1;
      if (!isDigitCode(text.charCodeAt(i))) fail(start, '数字格式不正确');
      while (i < len && isDigitCode(text.charCodeAt(i))) i += 1;

      if (text.charCodeAt(i) === CODE_DOT) {
        i += 1;
        if (!isDigitCode(text.charCodeAt(i))) fail(i, '小数点后面缺少数字');
        while (i < len && isDigitCode(text.charCodeAt(i))) i += 1;
      }

      const exp = text.charCodeAt(i);
      if (exp === CODE_e || exp === CODE_E) {
        i += 1;
        const sign = text.charCodeAt(i);
        if (sign === CODE_PLUS || sign === CODE_MINUS) i += 1;
        if (!isDigitCode(text.charCodeAt(i))) fail(i, '指数部分缺少数字');
        while (i < len && isDigitCode(text.charCodeAt(i))) i += 1;
      }
    }

    function parseValue(depth) {
      if (depth > MAX_VALIDATE_DEPTH) throw new Error('depth-limit');
      skipWhitespace();
      if (i >= len) fail(i, '内容不完整，这里还缺一个值');

      const code = text.charCodeAt(i);
      if (code === CODE_LBRACE) {
        parseObject(depth + 1);
        return;
      }
      if (code === CODE_LBRACKET) {
        parseArray(depth + 1);
        return;
      }
      if (code === CODE_QUOTE_D) {
        parseString();
        return;
      }
      if (code === CODE_MINUS || isDigitCode(code)) {
        parseNumber();
        return;
      }
      if (text.startsWith('true', i)) {
        i += 4;
        return;
      }
      if (text.startsWith('false', i)) {
        i += 5;
        return;
      }
      if (text.startsWith('null', i)) {
        i += 4;
        return;
      }
      fail(i, '这里期待一个值（字符串 / 数字 / 对象 / 数组 / true / false / null）');
    }

    function parseObject(depth) {
      i += 1;
      skipWhitespace();
      if (text.charCodeAt(i) === CODE_RBRACE) {
        i += 1;
        return;
      }

      for (;;) {
        skipWhitespace();
        if (i >= len) fail(i, '内容不完整，对象没有闭合');
        if (text.charCodeAt(i) !== CODE_QUOTE_D) fail(i, '属性名必须用双引号包裹（这里也可能是多了一个逗号）');
        parseString();
        skipWhitespace();
        if (text.charCodeAt(i) !== CODE_COLON) fail(i, '属性名后面缺少冒号');
        i += 1;
        parseValue(depth);
        skipWhitespace();

        const code = text.charCodeAt(i);
        if (code === CODE_COMMA) {
          i += 1;
          continue;
        }
        if (code === CODE_RBRACE) {
          i += 1;
          return;
        }
        fail(i, i >= len ? '内容不完整，对象没有闭合' : '属性值后面缺少逗号或右花括号');
      }
    }

    function parseArray(depth) {
      i += 1;
      skipWhitespace();
      if (text.charCodeAt(i) === CODE_RBRACKET) {
        i += 1;
        return;
      }

      for (;;) {
        parseValue(depth);
        skipWhitespace();

        const code = text.charCodeAt(i);
        if (code === CODE_COMMA) {
          i += 1;
          continue;
        }
        if (code === CODE_RBRACKET) {
          i += 1;
          return;
        }
        fail(i, i >= len ? '内容不完整，数组没有闭合' : '数组元素后面缺少逗号或右方括号');
      }
    }

    try {
      parseValue(0);
      skipWhitespace();
      if (i < len) fail(i, 'JSON 结束后还有多余内容');
      return null;
    } catch (error) {
      if (error && typeof error.position === 'number') {
        return { position: error.position, reason: error.reason };
      }
      return null;
    }
  }

  /* ------------------------------- 错误信息 ------------------------------- */

  const REASON_RULES = [
    [/Unexpected end of JSON input|Unterminated/i, '内容不完整，可能有括号或引号没有闭合'],
    [/Expected property name or '}'|Expected double-quoted property name/i, '属性名必须用双引号包裹（这里也可能是多了一个逗号）'],
    [/Expected ':' after property name/i, '属性名后面缺少冒号'],
    [/Expected ',' or '}' after property value/i, '属性值后面缺少逗号或右花括号'],
    [/Expected ',' or ']' after array element/i, '数组元素后面缺少逗号或右方括号'],
    [/Bad control character in string literal/i, '字符串里有未转义的控制字符（换行 / Tab 等）'],
    [/Bad escaped character/i, '字符串里有非法的转义字符'],
    [/Bad Unicode escape/i, 'Unicode 转义（\\uXXXX）不合法'],
    [/Unterminated string/i, '字符串缺少结尾引号'],
    [/Unexpected non-whitespace character after JSON/i, 'JSON 结束后还有多余内容'],
    [/Unexpected token/i, '这里出现了不该有的字符'],
    [/Unexpected number|Unexpected string/i, '这里出现了不该有的值']
  ];

  function translateReason(message) {
    for (let i = 0; i < REASON_RULES.length; i += 1) {
      if (REASON_RULES[i][0].test(message)) return REASON_RULES[i][1];
    }
    return '存在语法错误';
  }

  function locate(text, position) {
    let line = 1;
    let column = 1;
    const limit = Math.min(Math.max(position, 0), text.length);

    for (let i = 0; i < limit; i += 1) {
      if (text.charCodeAt(i) === CODE_LF) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }

    return { line, column };
  }

  function buildCaretSnippet(text, line, column) {
    const lines = text.split('\n');
    if (line < 1 || line > lines.length) return '';

    const target = lines[line - 1];
    const maxWidth = 120;
    let start = 0;
    let shown = target;

    if (target.length > maxWidth) {
      start = Math.max(0, Math.min(column - 40, target.length - maxWidth));
      shown = target.slice(start, start + maxWidth);
    }

    const caretOffset = Math.max(0, Math.min(column - 1 - start, shown.length));
    const label = `  ${line} | `;
    const gutter = ' '.repeat(String(line).length + 3) + '| ';

    return `${label}${shown}\n${gutter}${' '.repeat(caretOffset)}^`;
  }

  function buildErrorDetail(text, position, reason, prefix) {
    const point = locate(text, position);
    const head = prefix || '';
    return {
      summary: `${head}第 ${point.line} 行第 ${point.column} 列：${reason}`,
      reason,
      line: point.line,
      column: point.column,
      position,
      snippet: buildCaretSnippet(text, point.line, point.column)
    };
  }

  /* -------------------------------- 主流程 -------------------------------- */

  function attemptParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * 解析文本，返回 { ok:true, value, mode } 或 { ok:false, error, detail }。
   */
  function tryParse(input, depth) {
    const level = depth || 0;
    const text = stripBom(String(input == null ? '' : input)).trim();

    if (!text) return { ok: true, empty: true, value: null, mode: 'empty' };

    /* 解析成功后的统一出口：整段是转义字符串时再解一层。 */
    const acceptValue = (value, mode) => {
      if (typeof value === 'string' && level < MAX_UNWRAP_DEPTH && looksLikeJsonContainer(value)) {
        const inner = tryParse(value, level + 1);
        if (inner.ok && !inner.empty && inner.value !== null && typeof inner.value === 'object') {
          return { ok: true, value: inner.value, mode: mode + '+unwrapped' };
        }
      }
      return { ok: true, value, mode };
    };

    /*
     * 默认流程：先直接 JSON.parse。
     * 失败后才进入特殊流程——按 Python 字面量解析（dict / tuple / set /
     * datetime(...) / Decimal(...) 等）。Python 解析失败才退回宽松修复，
     * 这样 '''...'''、'\x41'、'a' 'b' 这些 Python 写法不会被修复器改坏。
     */
    const rawAttempt = attemptParse(text);
    if (rawAttempt.ok) return acceptValue(rawAttempt.value, 'raw');

    const pythonAttempt = tryParsePythonFallback(text);
    if (pythonAttempt) {
      return acceptValue(pythonAttempt.value, pythonAttempt.mode);
    }

    let lastError = rawAttempt.error;
    let lastCandidate = { text, mode: 'raw' };

    for (const candidate of candidateStream(text)) {
      if (candidate.mode === 'raw') continue;

      const attempt = attemptParse(candidate.text);
      if (attempt.ok) return acceptValue(attempt.value, candidate.mode);

      lastError = attempt.error;
      lastCandidate = candidate;
    }

    /*
     * 定位用「修复后」的文本，而不是原始文本。
     * 因为尾逗号、单引号这类问题修复阶段已经处理掉了，拿原始文本去校验
     * 会报出一个其实能自动修好的假问题，把真正的错误盖住。
     */
    const target = lastCandidate.text;
    const located = locateJsonError(target);
    const extracted = lastCandidate.mode.indexOf('extracted') === 0;
    const prefix = extracted ? '在提取出的片段里，' : '';

    const detail = located
      ? buildErrorDetail(target, located.position, located.reason, prefix)
      : {
          summary: prefix + translateReason(String((lastError && lastError.message) || '')),
          reason: translateReason(String((lastError && lastError.message) || '')),
          line: -1,
          column: -1,
          position: -1,
          snippet: ''
        };

    return { ok: false, error: lastError, detail };
  }

  /* -------------------------------- 对外接口 -------------------------------- */

  const api = {
    tryParse,
    repairLooseJson,
    extractJsonSnippets,
    locateJsonError,
    looksLikeJsonContainer,
    parsePythonLiteral,
    tryParsePythonFallback,
    parseStrictData
  };

  root.SmartJSON = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
