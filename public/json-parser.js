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

    let lastError = null;
    let lastCandidate = { text, mode: 'raw' };

    for (const candidate of candidateStream(text)) {
      const attempt = attemptParse(candidate.text);
      if (attempt.ok) {
        const value = attempt.value;

        /* 整段解析出来是字符串，且内容看着是 JSON —— 再解析一层 */
        if (typeof value === 'string' && level < MAX_UNWRAP_DEPTH && looksLikeJsonContainer(value)) {
          const inner = tryParse(value, level + 1);
          if (inner.ok && !inner.empty && inner.value !== null && typeof inner.value === 'object') {
            return { ok: true, value: inner.value, mode: candidate.mode + '+unwrapped' };
          }
        }

        return { ok: true, value, mode: candidate.mode };
      }

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
    looksLikeJsonContainer
  };

  root.SmartJSON = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
