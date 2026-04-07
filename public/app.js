const inputBox = document.getElementById('inputBox');
const treeView = document.getElementById('treeView');
const statusBar = document.getElementById('statusBar');
const clearBtn = document.getElementById('clearBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const contextMenu = document.getElementById('contextMenu');
const contextUnescapeBtn = document.getElementById('contextUnescapeBtn');

let currentData = null;
let debounceTimer = null;
const AUTO_EXPAND_DEPTH = 1;
const LARGE_INPUT_THRESHOLD = 50000;
const FRAME_BUDGET_MS = 8;

let latestRenderToken = 0;
let latestParseToken = 0;
let parseWorker = null;
const pendingWorkerJobs = new Map();

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

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

function decodeEscapedJsonString(raw) {
  let text = raw.trim();
  if (!text) return text;

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  return text.replace(/\\"/g, '"');
}

function normalizePythonLike(input) {
  const raw = input.trim();
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

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

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
        const nextChar = nextNonSpaceChar(raw, i + 1);
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

    if (ch === '.' && raw.slice(i, i + 3) === '...') {
      result += 'null';
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && /[A-Za-z_]/.test(ch)) {
      let token = ch;
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j])) {
        token += raw[j];
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

function parseSmartSync(input) {
  const raw = input.trim();
  if (!raw) return null;

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

function getParseWorker() {
  if (typeof Worker === 'undefined') return null;
  if (parseWorker) return parseWorker;

  parseWorker = new Worker('./parser-worker.js');
  parseWorker.addEventListener('message', (event) => {
    const { id, ok, value, empty, error } = event.data || {};
    const handlers = pendingWorkerJobs.get(id);
    if (!handlers) return;

    pendingWorkerJobs.delete(id);
    if (ok) {
      handlers.resolve(empty ? null : value);
      return;
    }
    handlers.reject(new Error(error || '解析失败：未知错误'));
  });

  parseWorker.addEventListener('error', () => {
    pendingWorkerJobs.forEach(({ reject }) => {
      reject(new Error('解析失败：Worker 执行异常'));
    });
    pendingWorkerJobs.clear();
    parseWorker = null;
  });

  return parseWorker;
}

function parseSmart(input) {
  const raw = input.trim();
  if (!raw) return Promise.resolve(null);

  const worker = getParseWorker();
  if (!worker) {
    return Promise.resolve(parseSmartSync(input));
  }

  const jobId = ++latestParseToken;
  return new Promise((resolve, reject) => {
    pendingWorkerJobs.set(jobId, { resolve, reject });
    worker.postMessage({ id: jobId, input });
  });
}

function applyUnescapeToSelection() {
  const start = inputBox.selectionStart;
  const end = inputBox.selectionEnd;
  const hasSelection = Number.isInteger(start) && Number.isInteger(end) && end > start;

  if (!hasSelection) {
    setStatus('请先选中要处理的内容', 'error');
    return false;
  }

  const selectedText = inputBox.value.slice(start, end);
  const convertedText = decodeEscapedJsonString(selectedText);
  inputBox.value = `${inputBox.value.slice(0, start)}${convertedText}${inputBox.value.slice(end)}`;
  inputBox.focus();
  inputBox.setSelectionRange(start, start + convertedText.length);
  processInput();
  setStatus('已处理选中内容中的引号转义', 'success');
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

  if (Array.isArray(value)) {
    return `<span class="tree-meta">[Array(${value.length})]</span>`;
  }

  return `<span class="tree-meta">{Object(${Object.keys(value).length})}</span>`;
}

function createTreeNodeShell(value, key = null, level = 0) {
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

  if (!isContainer) {
    return {
      node,
      isContainer: false
    };
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  const shouldStartCollapsed = level >= AUTO_EXPAND_DEPTH;
  let hasRenderedChildren = false;

  if (shouldStartCollapsed) {
    children.classList.add('collapsed');
    toggle.textContent = '▸';
  }

  const ensureChildrenRendered = () => {
    if (hasRenderedChildren) return;

    const entries = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : Object.entries(value);

    const fragment = document.createDocumentFragment();
    entries.forEach(([childKey, childValue]) => {
      const childShell = createTreeNodeShell(childValue, childKey, level + 1);
      fragment.appendChild(childShell.node);
    });

    children.appendChild(fragment);
    hasRenderedChildren = true;
  };

  if (!shouldStartCollapsed) {
    ensureChildrenRendered();
  }

  const toggleNode = () => {
    if (children.classList.contains('collapsed')) {
      ensureChildrenRendered();
    }
    const collapsed = children.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▸' : '▾';
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleNode();
  });
  row.addEventListener('click', () => toggleNode());

  node.appendChild(children);
  return {
    node,
    isContainer: true
  };
}

function buildTree(value, key = null, level = 0) {
  return createTreeNodeShell(value, key, level).node;
}

async function renderTreeAsync(data, renderToken) {
  treeView.innerHTML = '';
  treeView.classList.remove('empty');

  const rootShell = createTreeNodeShell(data);
  treeView.appendChild(rootShell.node);

  const queue = [];
  const rootChildren = rootShell.node.querySelector(':scope > .tree-children');
  if (rootChildren && !rootChildren.classList.contains('collapsed')) {
    Array.from(rootChildren.children).forEach((child) => queue.push(child));
  }

  while (queue.length) {
    if (renderToken !== latestRenderToken) return;

    const frameStart = performance.now();
    while (queue.length && performance.now() - frameStart < FRAME_BUDGET_MS) {
      const currentNode = queue.shift();
      const level = Number(currentNode.dataset.level || '0');
      const children = currentNode.querySelector(':scope > .tree-children');
      if (!children || level >= AUTO_EXPAND_DEPTH) continue;

      Array.from(children.children).forEach((child) => {
        queue.push(child);
      });
    }

    if (queue.length) {
      await nextFrame();
    }
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

async function processInput() {
  const renderToken = ++latestRenderToken;
  const inputValue = inputBox.value;

  if (!inputValue.trim()) {
    currentData = null;
    treeView.textContent = '粘贴后会自动解析并显示在这里';
    treeView.classList.add('empty');
    setStatus('等待粘贴内容', 'muted');
    return;
  }

  try {
    const shouldShowBusy = inputValue.length >= LARGE_INPUT_THRESHOLD;
    if (shouldShowBusy) {
      treeView.textContent = '内容较大，正在处理中…';
      treeView.classList.add('empty');
      setStatus('内容较大，正在处理中', 'muted');
      await nextFrame();
    }

    const parsed = await parseSmart(inputValue);
    if (renderToken !== latestRenderToken || parsed === null) return;

    currentData = parsed;
    const startRender = async () => {
      await renderTreeAsync(parsed, renderToken);
      if (renderToken !== latestRenderToken) return;
      setStatus('解析完成', 'success');
    };

    await startRender();
  } catch (error) {
    if (renderToken !== latestRenderToken) return;
    currentData = null;
    treeView.textContent = '解析失败，请检查内容格式';
    treeView.classList.add('empty');
    setStatus(error.message, 'error');
  }
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
  treeView.textContent = '粘贴后会自动解析并显示在这里';
  treeView.classList.add('empty');
  setStatus('内容已清空', 'muted');
});

collapseAllBtn.addEventListener('click', () => {
  if (!currentData) {
    setStatus('请先粘贴并完成解析', 'error');
    return;
  }
  setAllCollapsed(true);
  setStatus('已收起全部', 'success');
});
