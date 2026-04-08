const inputBox = document.getElementById('inputBox');
const treeView = document.getElementById('treeView');
const treePanel = document.getElementById('treePanel');
const statusBar = document.getElementById('statusBar');
const processInputBtn = document.getElementById('processInputBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const treeSearchInput = document.getElementById('treeSearchInput');
const searchPrevBtn = document.getElementById('searchPrevBtn');
const searchNextBtn = document.getElementById('searchNextBtn');
const copyValueBtn = document.getElementById('copyValueBtn');
const copyNodeBtn = document.getElementById('copyNodeBtn');
const clearBtn = document.getElementById('clearBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenCloseBtn = document.getElementById('fullscreenCloseBtn');
const fullscreenBackdrop = document.getElementById('fullscreenBackdrop');
const fullscreenHost = document.getElementById('fullscreenHost');
const contextMenu = document.getElementById('contextMenu');
const contextCopyPathBtn = document.getElementById('contextCopyPathBtn');
const contextCopyValueBtn = document.getElementById('contextCopyValueBtn');
const contextCopyNodeBtn = document.getElementById('contextCopyNodeBtn');
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
let treePanelPlaceholder = null;
let isTreeFullscreen = false;
let isTreeFullscreenAnimating = false;
const THEME_STORAGE_KEY = 'json-pretty-web-theme';
const INPUT_STORAGE_KEY = 'json-pretty-web-input';
let selectedTreeMeta = null;
let selectedTreeRow = null;
let searchResults = [];
let searchResultIndex = -1;
let searchKeyword = '';
let treeNodeRegistry = new Map();
let contextTreeMeta = null;
let copyPathBtn = null;
let selectedPathKey = '';
let contextMenuMode = 'input';
let lastParseFailed = false;

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

function updateProcessInputButtonVisibility() {
  const shouldShow = Boolean(inputBox.value.trim()) && lastParseFailed;
  processInputBtn.classList.toggle('visible', shouldShow);
  processInputBtn.classList.toggle('attention', shouldShow);
}

function updateTreeActionButtons() {
  const disabled = !selectedTreeMeta;
  copyValueBtn.disabled = disabled;
  copyNodeBtn.disabled = disabled;
  if (copyPathBtn) copyPathBtn.disabled = disabled;
  const hasResults = searchResults.length > 0;
  searchPrevBtn.disabled = !hasResults;
  searchNextBtn.disabled = !hasResults;
}

function getCurrentTheme() {
  return document.body.classList.contains('theme-mono') ? 'mono' : 'color';
}

function updateThemeButtonLabel() {
  themeToggleBtn.textContent = getCurrentTheme() === 'mono' ? '白天模式' : '夜晚模式';
}

function applyTheme(theme, persist = true) {
  document.body.classList.toggle('theme-mono', theme === 'mono');
  updateThemeButtonLabel();
  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
}

function saveInputDraft(value) {
  localStorage.setItem(INPUT_STORAGE_KEY, value);
}

function pathToKey(path) {
  return JSON.stringify(path);
}

function formatPath(path) {
  if (!Array.isArray(path) || path.length === 0) return 'root';
  return path.reduce((acc, segment, index) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    const safeSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(segment))
      ? String(segment)
      : `["${String(segment).replace(/"/g, '\\"')}"]`;

    if (index === 0) return safeSegment;
    if (safeSegment.startsWith('["')) return `${acc}${safeSegment}`;
    return `${acc}.${safeSegment}`;
  }, '');
}

function serializeValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function serializeNode(meta) {
  if (!meta) return '';
  if (meta.key === null) return serializeValue(meta.value);
  return JSON.stringify({ [meta.key]: meta.value }, null, 2);
}

async function copyText(text, successMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
    }
    setStatus(successMessage, 'success');
  } catch {
    setStatus('复制失败，请检查浏览器权限', 'error');
  }
}

function updateFullscreenButtonLabel() {
  fullscreenBtn.textContent = isTreeFullscreen ? '全屏已开启' : '全屏查看';
  fullscreenBtn.disabled = isTreeFullscreen;
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

function decodeWholeInputText(raw) {
  let text = raw.trim();
  if (!text) return raw;

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
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

function applyUnescapeToWholeInput() {
  if (!inputBox.value.trim()) {
    setStatus('请先粘贴要处理的内容', 'error');
    return false;
  }

  inputBox.value = decodeWholeInputText(inputBox.value);
  saveInputDraft(inputBox.value);
  lastParseFailed = false;
  updateProcessInputButtonVisibility();
  processInput();
  setStatus('已处理输入框内容', 'success');
  return true;
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
}

function showContextMenu(x, y) {
  const menuWidth = 200;
  const menuHeight = 176;
  const left = Math.min(x, window.innerWidth - menuWidth - 12);
  const top = Math.min(y, window.innerHeight - menuHeight - 12);
  contextMenu.style.left = `${Math.max(12, left)}px`;
  contextMenu.style.top = `${Math.max(12, top)}px`;
  contextMenu.classList.remove('hidden');
}

function setContextMenuMode(mode) {
  contextMenuMode = mode;
  const isInput = mode === 'input';
  contextCopyPathBtn.style.display = isInput ? 'none' : '';
  contextCopyValueBtn.style.display = isInput ? 'none' : '';
  contextCopyNodeBtn.style.display = isInput ? 'none' : '';
  contextUnescapeBtn.style.display = isInput ? '' : 'none';
}

function waitForPanelTransition() {
  return new Promise((resolve) => {
    setTimeout(resolve, 220);
  });
}

async function enterTreeFullscreen() {
  if (isTreeFullscreen || isTreeFullscreenAnimating) return;
  if (!currentData) {
    setStatus('请先粘贴并完成解析', 'error');
    return;
  }

  isTreeFullscreenAnimating = true;
  treePanelPlaceholder = document.createElement('div');
  treePanelPlaceholder.className = 'result-panel-placeholder';
  treePanelPlaceholder.style.width = `${treePanel.offsetWidth}px`;
  treePanelPlaceholder.style.height = `${treePanel.offsetHeight}px`;
  treePanel.after(treePanelPlaceholder);
  fullscreenHost.appendChild(treePanel);
  fullscreenBackdrop.classList.add('active');
  fullscreenHost.classList.add('active');
  document.body.classList.add('has-fullscreen-panel');
  await waitForPanelTransition();
  isTreeFullscreenAnimating = false;
  isTreeFullscreen = true;
  updateFullscreenButtonLabel();
  setStatus('已进入全屏，按 Esc 可退出', 'success');
}

async function exitTreeFullscreen() {
  if (!isTreeFullscreen || isTreeFullscreenAnimating || !treePanelPlaceholder) return;

  isTreeFullscreenAnimating = true;
  treePanelPlaceholder.after(treePanel);
  await nextFrame();
  fullscreenBackdrop.classList.remove('active');
  fullscreenHost.classList.remove('active');
  await waitForPanelTransition();
  document.body.classList.remove('has-fullscreen-panel');
  treePanelPlaceholder.remove();
  treePanelPlaceholder = null;

  isTreeFullscreenAnimating = false;
  isTreeFullscreen = false;
  updateFullscreenButtonLabel();
  setStatus('已退出全屏', 'success');
}

function toggleTreeFullscreen() {
  if (isTreeFullscreen) {
    exitTreeFullscreen();
    return;
  }
  enterTreeFullscreen();
}

function syncFullscreenPanelToViewport() {
  return;
}

function setSelectedTreeRow(row, meta) {
  if (selectedTreeRow) {
    selectedTreeRow.classList.remove('selected');
  }
  selectedTreeRow = row;
  selectedTreeMeta = meta;
  selectedPathKey = meta ? pathToKey(meta.path) : '';
  if (selectedTreeRow) {
    selectedTreeRow.classList.add('selected');
  }
  updateTreeActionButtons();
}

function openTreeContextMenu(event, meta, row) {
  event.preventDefault();
  setSelectedTreeRow(row, meta);
  contextTreeMeta = meta;
  setContextMenuMode('tree');
  showContextMenu(event.clientX, event.clientY);
}

function buildSearchMatches(value, keyword, path = [], key = null, matches = []) {
  const lowerKeyword = keyword.toLowerCase();
  const selfText = [
    key === null ? '' : String(key),
    typeof value === 'object' && value !== null ? '' : String(value)
  ].join(' ').toLowerCase();

  if (selfText.includes(lowerKeyword)) {
    matches.push(path);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => buildSearchMatches(item, keyword, [...path, index], index, matches));
    return matches;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => {
      buildSearchMatches(childValue, keyword, [...path, childKey], childKey, matches);
    });
  }

  return matches;
}

function revealPath(path) {
  for (let i = 0; i < path.length; i += 1) {
    const ancestorKey = pathToKey(path.slice(0, i));
    const childKey = pathToKey(path.slice(0, i + 1));
    const ancestorNode = treeNodeRegistry.get(ancestorKey);
    if (!ancestorNode) continue;
    const children = ancestorNode.querySelector(':scope > .tree-children');
    if (children?.classList.contains('collapsed')) {
      const row = ancestorNode.querySelector(':scope > .tree-row');
      row?.click();
    }
  }
  return treeNodeRegistry.get(pathToKey(path)) || null;
}

function focusSearchResult(index) {
  if (!searchResults.length) return;
  searchResultIndex = (index + searchResults.length) % searchResults.length;
  treeView.querySelectorAll('.tree-row.search-hit').forEach((row) => row.classList.remove('search-hit'));

  const path = searchResults[searchResultIndex];
  const node = revealPath(path);
  const row = node?.querySelector(':scope > .tree-row');
  if (!row) return;
  row.classList.add('search-hit');
  setSelectedTreeRow(row, row._treeMeta);
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setStatus(`搜索结果 ${searchResultIndex + 1} / ${searchResults.length}`, 'success');
}

function runTreeSearch() {
  const keyword = treeSearchInput.value.trim();
  searchKeyword = keyword;
  searchResults = [];
  searchResultIndex = -1;
  treeView.querySelectorAll('.tree-row.search-hit').forEach((row) => row.classList.remove('search-hit'));

  if (!keyword || !currentData) {
    updateTreeActionButtons();
    return;
  }

  searchResults = buildSearchMatches(currentData, keyword);
  updateTreeActionButtons();
  if (!searchResults.length) {
    setStatus('未找到匹配内容', 'error');
    return;
  }
  focusSearchResult(0);
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

function createTreeNodeShell(value, key = null, level = 0, path = []) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.level = String(level);
  node.dataset.pathKey = pathToKey(path);
  treeNodeRegistry.set(node.dataset.pathKey, node);

  const row = document.createElement('div');
  row.className = 'tree-row';
  row._treeMeta = { key, value, path };

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
      const childShell = createTreeNodeShell(childValue, childKey, level + 1, [...path, childKey]);
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
    setSelectedTreeRow(row, row._treeMeta);
    toggleNode();
  });
  row.addEventListener('pointerdown', () => {
    setSelectedTreeRow(row, row._treeMeta);
  });
  row.addEventListener('contextmenu', (event) => {
    openTreeContextMenu(event, row._treeMeta, row);
  });
  row.addEventListener('click', () => {
    setSelectedTreeRow(row, row._treeMeta);
    if (isContainer) {
      toggleNode();
    }
  });

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
  treeNodeRegistry = new Map();
  selectedTreeMeta = null;
  selectedTreeRow = null;
  treeView.innerHTML = '';
  treeView.classList.remove('empty');

  const rootShell = createTreeNodeShell(data);
  treeView.appendChild(rootShell.node);
  const preferredNode = treeNodeRegistry.get(selectedPathKey) || rootShell.node;
  const preferredRow = preferredNode.querySelector(':scope > .tree-row');
  setSelectedTreeRow(preferredRow, preferredRow._treeMeta);

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
    lastParseFailed = false;
    treeView.textContent = '粘贴后会自动解析并显示在这里';
    treeView.classList.add('empty');
    setStatus('等待粘贴内容', 'muted');
    updateProcessInputButtonVisibility();
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
    lastParseFailed = false;
    updateProcessInputButtonVisibility();
    const startRender = async () => {
      await renderTreeAsync(parsed, renderToken);
      if (renderToken !== latestRenderToken) return;
      setStatus('解析完成', 'success');
    };

    await startRender();
    if (searchKeyword) {
      runTreeSearch();
    } else {
      updateTreeActionButtons();
    }
  } catch (error) {
    if (renderToken !== latestRenderToken) return;
    currentData = null;
    lastParseFailed = true;
    treeView.textContent = '解析失败，请检查内容格式';
    treeView.classList.add('empty');
    setStatus(error.message, 'error');
    updateProcessInputButtonVisibility();
  }
}

inputBox.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  setContextMenuMode('input');
  showContextMenu(event.clientX, event.clientY);
});

contextCopyPathBtn.addEventListener('click', () => {
  if (!contextTreeMeta && !selectedTreeMeta) return;
  copyText(formatPath((contextTreeMeta || selectedTreeMeta).path), '已复制当前路径');
  hideContextMenu();
});

contextCopyValueBtn.addEventListener('click', () => {
  if (!contextTreeMeta && !selectedTreeMeta) return;
  copyText(serializeValue((contextTreeMeta || selectedTreeMeta).value), '已复制当前值');
  hideContextMenu();
});

contextCopyNodeBtn.addEventListener('click', () => {
  if (!contextTreeMeta && !selectedTreeMeta) return;
  copyText(serializeNode(contextTreeMeta || selectedTreeMeta), '已复制当前节点');
  hideContextMenu();
});

contextUnescapeBtn.addEventListener('click', () => {
  if (contextMenuMode === 'input') {
    applyUnescapeToWholeInput();
  } else {
    applyUnescapeToSelection();
  }
  hideContextMenu();
});

document.addEventListener('click', (event) => {
  if (!contextMenu.contains(event.target)) {
    hideContextMenu();
    contextTreeMeta = null;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isTreeFullscreen) {
    event.preventDefault();
    exitTreeFullscreen();
  }
});

document.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', () => {
  hideContextMenu();
  syncFullscreenPanelToViewport();
});
inputBox.addEventListener('blur', () => {
  setTimeout(hideContextMenu, 120);
});

inputBox.addEventListener('input', () => {
  saveInputDraft(inputBox.value);
  if (!inputBox.value.trim()) {
    lastParseFailed = false;
  }
  updateProcessInputButtonVisibility();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processInput, 220);
});

clearBtn.addEventListener('click', () => {
  inputBox.value = '';
  saveInputDraft('');
  currentData = null;
  lastParseFailed = false;
  selectedTreeMeta = null;
  selectedTreeRow = null;
  selectedPathKey = '';
  searchResults = [];
  searchResultIndex = -1;
  searchKeyword = '';
  treeSearchInput.value = '';
  treeView.textContent = '粘贴后会自动解析并显示在这里';
  treeView.classList.add('empty');
  setStatus('内容已清空', 'muted');
  updateTreeActionButtons();
  updateProcessInputButtonVisibility();
});

processInputBtn.addEventListener('click', () => {
  applyUnescapeToWholeInput();
});

fullscreenBtn.addEventListener('click', () => {
  toggleTreeFullscreen();
});

fullscreenCloseBtn.addEventListener('click', () => {
  exitTreeFullscreen();
});

themeToggleBtn.addEventListener('click', () => {
  applyTheme(getCurrentTheme() === 'mono' ? 'color' : 'mono');
});

treeSearchInput.addEventListener('input', () => {
  runTreeSearch();
});

searchPrevBtn.addEventListener('click', () => {
  focusSearchResult(searchResultIndex - 1);
});

searchNextBtn.addEventListener('click', () => {
  focusSearchResult(searchResultIndex + 1);
});

copyValueBtn.addEventListener('click', () => {
  if (!selectedTreeMeta) return;
  copyText(serializeValue(selectedTreeMeta.value), '已复制当前值');
});

copyNodeBtn.addEventListener('click', () => {
  if (!selectedTreeMeta) return;
  copyText(serializeNode(selectedTreeMeta), '已复制当前节点');
});

copyPathBtn = (() => {
  const btn = document.createElement('button');
  btn.id = 'copyPathBtn';
  btn.className = 'ghost';
  btn.textContent = '复制路径';
  btn.addEventListener('click', () => {
    if (!selectedTreeMeta) return;
    copyText(formatPath(selectedTreeMeta.path), '已复制当前路径');
  });
  return btn;
})();
copyValueBtn.insertAdjacentElement('afterend', copyPathBtn);

updateFullscreenButtonLabel();
applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === 'mono' ? 'mono' : 'color', false);
updateTreeActionButtons();

const savedInput = localStorage.getItem(INPUT_STORAGE_KEY);
if (savedInput) {
  inputBox.value = savedInput;
  updateProcessInputButtonVisibility();
  processInput();
}

collapseAllBtn.addEventListener('click', () => {
  if (!currentData) {
    setStatus('请先粘贴并完成解析', 'error');
    return;
  }
  setAllCollapsed(true);
  setStatus('已收起全部', 'success');
});
