function normalizePythonLike(input) {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const appendEscapedControl = (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return ch;
  };

  const nextNonSpaceChar = (text, start) => {
    for (let i = start; i < text.length; i += 1) {
      if (!/\s/.test(text[i])) return text[i];
    }
    return '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escape) {
      if (inSingle && ch === '"') {
        result += '\\"';
      } else if (inSingle || inDouble) {
        result += appendEscapedControl(ch);
      } else {
        result += ch;
      }
      escape = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        const nextChar = nextNonSpaceChar(input, i + 1);
        if (!nextChar || ',:}]'.includes(nextChar)) {
          inSingle = false;
          result += '"';
        } else {
          result += "'";
        }
      } else if (ch === '"') {
        result += '\\"';
      } else {
        result += appendEscapedControl(ch);
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        result += ch;
      } else {
        result += appendEscapedControl(ch);
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      result += '"';
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      result += ch;
      continue;
    }

    if (ch === '.' && input.slice(i, i + 3) === '...') {
      result += 'null';
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && /[A-Za-z_]/.test(ch)) {
      let token = ch;
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) {
        token += input[j];
        j += 1;
      }

      if (token === 'True') {
        result += 'true';
        i = j - 1;
        continue;
      }
      if (token === 'False') {
        result += 'false';
        i = j - 1;
        continue;
      }
      if (token === 'None') {
        result += 'null';
        i = j - 1;
        continue;
      }
    }

    result += ch;
  }

  return result
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\{\s*null\s*\}/g, '{}')
    .replace(/\[\s*null\s*\]/g, '[]');
}

function parseSmart(input) {
  const raw = input.trim();
  if (!raw) {
    return { empty: true };
  }

  const candidates = [
    raw,
    normalizePythonLike(raw)
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`解析失败：${lastError ? lastError.message : '未知错误'}`);
}

self.addEventListener('message', (event) => {
  const { id, input } = event.data || {};

  try {
    const result = parseSmart(String(input || ''));
    self.postMessage({
      id,
      ok: true,
      ...result
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : '解析失败：未知错误'
    });
  }
});
