const inputBox = document.getElementById('inputBox');
const treeView = document.getElementById('treeView');
const statusBar = document.getElementById('statusBar');
const clearBtn = document.getElementById('clearBtn');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const contextMenu = document.getElementById('contextMenu');
const contextUnescapeBtn = document.getElementById('contextUnescapeBtn');

let currentData = null;
let debounceTimer = null;

function setStatus(message, type = 'muted') {
  statusBar.textContent = message;
  statusBar.className = `status ${type}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePythonLike(input) {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escape = true;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      result += '"';
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      result += ch;
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

  return result.replace(/,\s*([}\]])/g, '$1');
}

function decodeEscapedJsonString(raw) {
  let text = raw.trim();
  if (!text) return text;

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  return text.replace(/\\"/g, '"');
}

function parseSmart(input) {
  const raw = input.trim();
  if (!raw) {
    currentData = null;
    treeView.textContent = '粘贴内容后会自动解析并显示在这里';
    treeView.classList.add('empty');
    setStatus('等待输入内容…', 'muted');
    return null;
  }

  const candidates = [
    raw,
    normalizePythonLike(raw)
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`解析失败：${lastError ? lastError.message : '未知错误'}`);
}

function applyUnescapeToSelection() {
  const start = inputBox.selectionStart;
  const end = inputBox.selectionEnd;
  const hasSelection = Number.isInteger(start) && Number.isInteger(end) && end > start;

  if (!hasSelection) {
    setStatus('请先选中需要处理的文本', 'error');
    return false;
  }

  const selectedText = inputBox.value.slice(start, end);
  const convertedText = decodeEscapedJsonString(selectedText);
  inputBox.value = `${inputBox.value.slice(0, start)}${convertedText}${inputBox.value.slice(end)}`;
  inputBox.focus();
  inputBox.setSelectionRange(start, start + convertedText.length);
  processInput();
  setStatus('已仅处理选中文本中的 \"，其它反斜杠保持不变。', 'success');
  return true;
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
}

function showContextMenu(x, y) {
  const menuWidth = 200;
  const menuHeight = 52;
  const left = Math.min(x, window.innerWidth - menuWidth - 12);
  const top = Math.min(y, window.innerHeight - menuHeight - 12);
  contextMenu.style.left = `${Math.max(12, left)}px`;
  contextMenu.style.top = `${Math.max(12, top)}px`;
  contextMenu.classList.remove('hidden');
}

function renderValue(value) {
  if (typeof value === 'string') {
    return `<span class="tree-string">"${escapeHtml(value)}"</span>`;
  }
  if (typeof value === 'number') {
    return `<span class="tree-number">${value}</span>`;
  }
  if (typeof value === 'boolean') {
    return `<span class="tree-boolean">${value}</span>`;
  }
  if (value === null) {
    return '<span class="tree-null">null</span>';
  }
  return `<span class="tree-meta">${Array.isArray(value) ? '[...]' : '{...}'}</span>`;
}

function buildTree(value, key = null, level = 0) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.level = String(level);

  const row = document.createElement('div');
  row.className = 'tree-row';

  const isContainer = value && typeof value === 'object';
  const toggle = document.createElement('span');
  toggle.className = `toggle ${isContainer ? '' : 'leaf'}`.trim();
  toggle.textContent = isContainer ? '▾' : '•';
  row.appendChild(toggle);

  const content = document.createElement('span');
  if (key !== null) {
    content.innerHTML = `<span class="tree-key">${escapeHtml(key)}</span>: ${renderValue(value)}`;
  } else {
    content.innerHTML = renderValue(value);
  }
  row.appendChild(content);
  node.appendChild(row);

  if (!isContainer) return node;

  const children = document.createElement('div');
  children.className = 'tree-children';

  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);

  entries.forEach(([childKey, childValue]) => {
    children.appendChild(buildTree(childValue, childKey, level + 1));
  });

  const toggleNode = () => {
    const collapsed = children.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▸' : '▾';
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleNode();
  });
  row.addEventListener('click', () => toggleNode());

  node.appendChild(children);
  return node;
}

function renderTree(data) {
  treeView.innerHTML = '';
  treeView.classList.remove('empty');
  treeView.appendChild(buildTree(data));
}

function processInput() {
  try {
    const parsed = parseSmart(inputBox.value);
    if (parsed === null) return;
    currentData = parsed;
    renderTree(parsed);
    setStatus('解析成功，已自动生成折叠树视图。', 'success');
  } catch (error) {
    currentData = null;
    treeView.textContent = '解析失败，请根据下方提示检查输入内容';
    treeView.classList.add('empty');
    setStatus(error.message, 'error');
  }
}

function setAllCollapsed(collapsed) {
  treeView.querySelectorAll('.tree-children').forEach((el) => {
    el.classList.toggle('collapsed', collapsed);
  });
  treeView.querySelectorAll('.toggle:not(.leaf)').forEach((el) => {
    el.textContent = collapsed ? '▸' : '▾';
  });
}

inputBox.addEventListener('contextmenu', (event) => {
  const start = inputBox.selectionStart;
  const end = inputBox.selectionEnd;
  const hasSelection = Number.isInteger(start) && Number.isInteger(end) && end > start;

  if (!hasSelection) {
    hideContextMenu();
    return;
  }

  event.preventDefault();
  showContextMenu(event.clientX, event.clientY);
});

contextUnescapeBtn.addEventListener('click', () => {
  applyUnescapeToSelection();
  hideContextMenu();
});

document.addEventListener('click', (event) => {
  if (!contextMenu.contains(event.target)) {
    hideContextMenu();
  }
});

document.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', hideContextMenu);
inputBox.addEventListener('blur', () => {
  setTimeout(hideContextMenu, 120);
});

inputBox.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processInput, 220);
});

clearBtn.addEventListener('click', () => {
  inputBox.value = '';
  currentData = null;
  treeView.textContent = '粘贴内容后会自动解析并显示在这里';
  treeView.classList.add('empty');
  setStatus('已清空内容', 'muted');
});

expandAllBtn.addEventListener('click', () => {
  if (!currentData) {
    setStatus('请先输入并解析成功', 'error');
    return;
  }
  setAllCollapsed(false);
  setStatus('已全部展开', 'success');
});

collapseAllBtn.addEventListener('click', () => {
  if (!currentData) {
    setStatus('请先输入并解析成功', 'error');
    return;
  }
  setAllCollapsed(true);
  setStatus('已全部折叠', 'success');
});
