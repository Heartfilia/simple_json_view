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

const inputBox = document.getElementById('inputBox');
const treeView = document.getElementById('treeView');
const treePanel = document.getElementById('treePanel');
const statusBar = document.getElementById('statusBar');
const processInputBtn = document.getElementById('processInputBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const compactBtn = document.getElementById('compactBtn');
const treeSearchInput = document.getElementById('treeSearchInput');
const searchResultCount = document.getElementById('searchResultCount');
const searchPrevBtn = document.getElementById('searchPrevBtn');
const searchNextBtn = document.getElementById('searchNextBtn');
const copyValueBtn = document.getElementById('copyValueBtn');
const clearBtn = document.getElementById('clearBtn');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenCloseBtn = document.getElementById('fullscreenCloseBtn');
const fullscreenBackdrop = document.getElementById('fullscreenBackdrop');
const fullscreenHost = document.getElementById('fullscreenHost');
const contextMenu = document.getElementById('contextMenu');
const contextCopyPathBtn = document.getElementById('contextCopyPathBtn');
const contextCopyKeyBtn = document.getElementById('contextCopyKeyBtn');
const contextCopyValueBtn = document.getElementById('contextCopyValueBtn');
const contextCopyNodeBtn = document.getElementById('contextCopyNodeBtn');
const contextUnescapeBtn = document.getElementById('contextUnescapeBtn');
const contextCompactBtn = document.getElementById('contextCompactBtn');

let currentData = null;
let debounceTimer = null;
const AUTO_EXPAND_DEPTH = 1;
const LARGE_INPUT_THRESHOLD = 50000;
const FRAME_BUDGET_MS = 8;
const CHILD_RENDER_BATCH_SIZE = 150;
const INPUT_DRAFT_STORAGE_LIMIT = 200000;
const ROOT_AUTO_COLLAPSE_ENTRY_THRESHOLD = 1000;
const EXPAND_ALL_NODE_LIMIT = 12000;
const EXPAND_ALL_STATUS_INTERVAL = 200;

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
let selectedPathKey = '';
let contextMenuMode = 'input';
let lastParseFailed = false;
let isTreeBatchUpdating = false;
let hasExpandedAllTree = false;
let isLargeTreeMode = false;
let latestTreeBatchToken = 0;
let didWarnDraftStorageDisabled = false;
const THEME_TOGGLE_ICONS = {
  color: `
    <span class="theme-toggle-icon" aria-hidden="true">
      <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" focusable="false">
        <path d="M20.2 14.1A8.6 8.6 0 1 1 9.9 3.8a7.2 7.2 0 1 0 10.3 10.3Z" />
      </svg>
    </span>
  `,
  mono: `
    <span class="theme-toggle-icon" aria-hidden="true">
      <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" focusable="false">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.3M12 19.2v2.3M21.5 12h-2.3M4.8 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
      </svg>
    </span>
  `
};

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

function getTickNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getContainerEntryCount(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.length;
  return Object.keys(value).length;
}

function createTreeBatchCancelledError() {
  const error = new Error('批量树操作已取消');
  error.name = 'TreeBatchCancelledError';
  return error;
}

function assertTreeBatchActive(batchToken) {
  if (batchToken !== undefined && batchToken !== latestTreeBatchToken) {
    throw createTreeBatchCancelledError();
  }
}

function cancelTreeBatchOperations() {
  latestTreeBatchToken += 1;
  if (!isTreeBatchUpdating) return;
  isTreeBatchUpdating = false;
  updateTreeBatchButtons();
}

function setStatus(message, type = 'muted') {
  statusBar.textContent = message;
  statusBar.className = `status status-inline ${type}`;
}

function updateExpandAllButtonTitle() {
  let title = '展开全部';
  if (isLargeTreeMode) {
    title = '超大内容模式下已禁用展开全部，请使用搜索或逐层展开';
  } else if (hasExpandedAllTree) {
    title = '当前内容已全部展开';
  } else if (isTreeBatchUpdating) {
    title = '正在批量处理节点';
  } else if (!currentData) {
    title = '请先粘贴并完成解析';
  }

  expandAllBtn.setAttribute('title', title);
  expandAllBtn.setAttribute('aria-label', title);
}

function updateProcessInputButtonVisibility() {
  const hasInput = Boolean(inputBox.value.trim());
  const shouldShow = hasInput && lastParseFailed;
  processInputBtn.classList.toggle('visible', shouldShow);
  processInputBtn.classList.toggle('attention', shouldShow);
  compactBtn.disabled = !hasInput;
  clearBtn.disabled = !hasInput;
}

function updateTreeBatchButtons() {
  expandAllBtn.disabled = !currentData || isTreeBatchUpdating || hasExpandedAllTree || isLargeTreeMode;
  collapseAllBtn.disabled = !currentData || isTreeBatchUpdating;
  updateExpandAllButtonTitle();
}

function updateTreeActionButtons() {
  const disabled = !selectedTreeMeta;
  copyValueBtn.disabled = disabled;
  const hasSearchKeyword = Boolean(treeSearchInput.value.trim()) && Boolean(currentData);
  const hasResults = hasSearchKeyword && searchResults.length > 0;
  searchPrevBtn.disabled = !hasResults;
  searchNextBtn.disabled = !hasResults;
  if (searchResultCount) {
    if (hasResults) {
      const current = searchResultIndex >= 0 ? searchResultIndex + 1 : 1;
      searchResultCount.textContent = `${current}/${searchResults.length}`;
      searchResultCount.classList.add('visible');
    } else {
      searchResultCount.textContent = '';
      searchResultCount.classList.remove('visible');
    }
  }
}

function getCurrentTheme() {
  return document.body.classList.contains('theme-mono') ? 'mono' : 'color';
}

function updateThemeButtonLabel() {
  const currentTheme = getCurrentTheme();
  const nextTheme = currentTheme === 'mono' ? 'color' : 'mono';
  const label = nextTheme === 'mono' ? 'Switch to dark mode' : 'Switch to light mode';
  themeToggleBtn.innerHTML = THEME_TOGGLE_ICONS[currentTheme];
  themeToggleBtn.setAttribute('aria-label', label);
  themeToggleBtn.setAttribute('title', label);
}

function applyTheme(theme, persist = true) {
  themeToggleBtn.classList.remove('theme-toggle-animating');
  document.body.classList.toggle('theme-mono', theme === 'mono');
  updateThemeButtonLabel();
  void themeToggleBtn.offsetWidth;
  themeToggleBtn.classList.add('theme-toggle-animating');
  if (persist) {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
}

function saveInputDraft(value) {
  try {
    if (!value) {
      localStorage.removeItem(INPUT_STORAGE_KEY);
      didWarnDraftStorageDisabled = false;
      return true;
    }

    if (value.length > INPUT_DRAFT_STORAGE_LIMIT) {
      localStorage.removeItem(INPUT_STORAGE_KEY);
      return false;
    }

    localStorage.setItem(INPUT_STORAGE_KEY, value);
    didWarnDraftStorageDisabled = false;
    return true;
  } catch {
    try {
      localStorage.removeItem(INPUT_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures and continue parsing/rendering.
    }
    return false;
  }
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
  fullscreenBtn.textContent = isTreeFullscreen ? '全屏中' : '全屏';
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
  contextMenu.style.visibility = '';
}

function showContextMenu(x, y) {
  contextMenu.style.visibility = 'hidden';
  contextMenu.classList.remove('hidden');
  const menuWidth = contextMenu.offsetWidth || 200;
  const menuHeight = contextMenu.offsetHeight || 176;
  const left = Math.min(x, window.innerWidth - menuWidth - 12);
  const top = Math.min(y, window.innerHeight - menuHeight - 12);
  contextMenu.style.left = `${Math.max(12, left)}px`;
  contextMenu.style.top = `${Math.max(12, top)}px`;
  contextMenu.style.visibility = '';
}

function setContextMenuMode(mode) {
  contextMenuMode = mode;
  const isInput = mode === 'input';
  const activeMeta = contextTreeMeta || selectedTreeMeta;
  const hasKey = activeMeta && activeMeta.key !== null && activeMeta.key !== undefined;
  contextCopyPathBtn.style.display = isInput ? 'none' : '';
  contextCopyKeyBtn.style.display = isInput || !hasKey ? 'none' : '';
  contextCopyValueBtn.style.display = isInput ? 'none' : '';
  contextCopyNodeBtn.style.display = isInput ? 'none' : '';
  contextUnescapeBtn.style.display = isInput ? '' : 'none';
  contextCompactBtn.style.display = isInput ? '' : 'none';
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
  treePanelPlaceholder.replaceWith(treePanel);
  await nextFrame();
  fullscreenBackdrop.classList.remove('active');
  fullscreenHost.classList.remove('active');
  await waitForPanelTransition();
  document.body.classList.remove('has-fullscreen-panel');
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

async function revealPath(path) {
  for (let i = 0; i < path.length; i += 1) {
    const ancestorKey = pathToKey(path.slice(0, i));
    const ancestorNode = treeNodeRegistry.get(ancestorKey);
    if (!ancestorNode) continue;
    if (typeof ancestorNode._expandNode === 'function') {
      await ancestorNode._expandNode();
    }
  }
  return treeNodeRegistry.get(pathToKey(path)) || null;
}

async function focusSearchResult(index) {
  if (!searchResults.length) return;
  searchResultIndex = (index + searchResults.length) % searchResults.length;
  updateTreeActionButtons();
  treeView.querySelectorAll('.tree-row.search-hit').forEach((row) => row.classList.remove('search-hit'));

  const path = searchResults[searchResultIndex];
  const node = await revealPath(path);
  const row = node?.querySelector(':scope > .tree-row');
  if (!row) return;
  row.classList.add('search-hit');
  setSelectedTreeRow(row, row._treeMeta);
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  void focusSearchResult(0);
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

  row.addEventListener('pointerdown', () => {
    setSelectedTreeRow(row, row._treeMeta);
  });
  row.addEventListener('contextmenu', (event) => {
    openTreeContextMenu(event, row._treeMeta, row);
  });

  if (!isContainer) {
    return {
      node,
      isContainer: false
    };
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  const entryCount = getContainerEntryCount(value);
  const shouldStartCollapsed = level >= AUTO_EXPAND_DEPTH
    || (level === 0 && entryCount >= ROOT_AUTO_COLLAPSE_ENTRY_THRESHOLD);
  let hasRenderedChildren = false;
  let isRenderingChildren = false;
  let renderChildrenPromise = null;

  if (shouldStartCollapsed) {
    children.classList.add('collapsed');
    toggle.textContent = '▸';
  }

  const ensureChildrenRendered = async (batchToken) => {
    if (hasRenderedChildren) return;
    if (renderChildrenPromise) {
      await renderChildrenPromise;
      assertTreeBatchActive(batchToken);
      return;
    }

    const entries = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : Object.entries(value);

    isRenderingChildren = true;
    row.classList.add('loading');
    toggle.textContent = '…';

    renderChildrenPromise = (async () => {
      for (let index = 0; index < entries.length; index += CHILD_RENDER_BATCH_SIZE) {
        assertTreeBatchActive(batchToken);
        const fragment = document.createDocumentFragment();
        const chunk = entries.slice(index, index + CHILD_RENDER_BATCH_SIZE);

        chunk.forEach(([childKey, childValue]) => {
          const childShell = createTreeNodeShell(childValue, childKey, level + 1, [...path, childKey]);
          fragment.appendChild(childShell.node);
        });

        children.appendChild(fragment);
        if (index + CHILD_RENDER_BATCH_SIZE < entries.length) {
          await nextFrame();
          assertTreeBatchActive(batchToken);
        }
      }

      hasRenderedChildren = true;
    })();

    try {
      await renderChildrenPromise;
    } finally {
      isRenderingChildren = false;
      renderChildrenPromise = null;
      row.classList.remove('loading');
      toggle.textContent = children.classList.contains('collapsed') ? '▸' : '▾';
    }
  };

  const setCollapsedState = (collapsed) => {
    children.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '▸' : '▾';
  };

  const toggleNode = async () => {
    const wasCollapsed = children.classList.contains('collapsed');
    if (wasCollapsed) {
      await ensureChildrenRendered();
    }
    if (isRenderingChildren) return;
    setCollapsedState(!children.classList.contains('collapsed'));
  };

  const expandNode = async (batchToken) => {
    await ensureChildrenRendered(batchToken);
    assertTreeBatchActive(batchToken);
    if (isRenderingChildren) return;
    if (children.classList.contains('collapsed')) {
      setCollapsedState(false);
    }
  };

  node._expandNode = expandNode;
  node._ensureChildrenRendered = ensureChildrenRendered;
  node._childrenContainer = children;
  node._startsCollapsed = shouldStartCollapsed;
  node._entryCount = entryCount;

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setSelectedTreeRow(row, row._treeMeta);
    void toggleNode();
  });
  row.addEventListener('click', () => {
    setSelectedTreeRow(row, row._treeMeta);
    if (isContainer) {
      void toggleNode();
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

  const rootStartsCollapsed = rootShell.node._startsCollapsed === true;
  if (!rootStartsCollapsed && typeof rootShell.node._ensureChildrenRendered === 'function') {
    await rootShell.node._ensureChildrenRendered();
    if (renderToken !== latestRenderToken) return;
  }

  return {
    rootStartsCollapsed,
    rootEntryCount: rootShell.node._entryCount || 0
  };
}

function setAllCollapsed(collapsed) {
  treeView.querySelectorAll('.tree-children').forEach((el) => {
    el.classList.toggle('collapsed', collapsed);
  });
  treeView.querySelectorAll('.toggle:not(.leaf)').forEach((el) => {
    el.textContent = collapsed ? '▸' : '▾';
  });
}

async function expandAllNodes(batchToken) {
  const pendingNodes = Array.from(treeView.children);
  let processedCount = 0;
  let lastYieldAt = getTickNow();

  for (let index = 0; index < pendingNodes.length; index += 1) {
    assertTreeBatchActive(batchToken);
    if (processedCount >= EXPAND_ALL_NODE_LIMIT) {
      return {
        completed: false,
        processedCount
      };
    }

    const node = pendingNodes[index];
    if (typeof node._expandNode === 'function') {
      await node._expandNode(batchToken);
      assertTreeBatchActive(batchToken);
    }

    const children = node._childrenContainer;
    if (children && children.children.length) {
      pendingNodes.push(...Array.from(children.children));
    }

    processedCount += 1;

    const shouldYield = processedCount % EXPAND_ALL_STATUS_INTERVAL === 0
      || getTickNow() - lastYieldAt >= FRAME_BUDGET_MS;
    if (shouldYield) {
      setStatus(`正在展开全部节点中，请稍等... 已处理 ${processedCount} 个节点`, 'processing');
      await nextFrame();
      assertTreeBatchActive(batchToken);
      lastYieldAt = getTickNow();
    }
  }

  return {
    completed: true,
    processedCount
  };
}

async function runTreeBatchAction(action, pendingMessage, successMessage, pendingType = 'muted') {
  if (!currentData) {
    setStatus('请先粘贴并完成解析', 'error');
    return;
  }

  if (isTreeBatchUpdating) return;

  const batchToken = ++latestTreeBatchToken;
  isTreeBatchUpdating = true;
  updateTreeBatchButtons();
  setStatus(pendingMessage, pendingType);

  try {
    await action(batchToken);
    if (batchToken !== latestTreeBatchToken) return;
    setStatus(successMessage, 'success');
  } catch (error) {
    if (error?.name === 'TreeBatchCancelledError') {
      return;
    }
    if (batchToken !== latestTreeBatchToken) return;
    setStatus(error?.message || '操作失败，请稍后重试', 'error');
  } finally {
    if (batchToken === latestTreeBatchToken) {
      isTreeBatchUpdating = false;
      updateTreeBatchButtons();
    }
  }
}

async function compactInputContent() {
  const raw = inputBox.value.trim();
  if (!raw) {
    setStatus('请先粘贴要处理的内容', 'error');
    return;
  }

  try {
    const parsed = await parseSmart(inputBox.value);
    if (parsed === null) {
      setStatus('请先粘贴要处理的内容', 'error');
      return;
    }

    inputBox.value = JSON.stringify(parsed);
    saveInputDraft(inputBox.value);
    lastParseFailed = false;
    updateProcessInputButtonVisibility();
    await processInput();
    setStatus('已压缩输入内容', 'success');
  } catch (error) {
    lastParseFailed = true;
    updateProcessInputButtonVisibility();
    setStatus(error.message, 'error');
  }
}

async function processInput() {
  cancelTreeBatchOperations();
  const renderToken = ++latestRenderToken;
  const inputValue = inputBox.value;

  if (!inputValue.trim()) {
    currentData = null;
    lastParseFailed = false;
    hasExpandedAllTree = false;
    isLargeTreeMode = false;
    treeView.textContent = '粘贴后会自动解析并显示在这里';
    treeView.classList.add('empty');
    setStatus('等待粘贴内容', 'muted');
    updateProcessInputButtonVisibility();
    updateTreeBatchButtons();
    return;
  }

  try {
    const shouldShowBusy = inputValue.length >= LARGE_INPUT_THRESHOLD;
    isLargeTreeMode = shouldShowBusy;
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
    hasExpandedAllTree = false;
    updateProcessInputButtonVisibility();
    updateTreeBatchButtons();
    const startRender = async () => {
      const renderResult = await renderTreeAsync(parsed, renderToken);
      if (renderToken !== latestRenderToken) return;
      const rootStartsCollapsed = Boolean(renderResult?.rootStartsCollapsed);
      isLargeTreeMode = isLargeTreeMode || rootStartsCollapsed;
      updateTreeBatchButtons();
      if (isLargeTreeMode) {
        if (rootStartsCollapsed) {
          setStatus(`超大内容模式：已默认收起根节点（${renderResult?.rootEntryCount || 0} 项），已禁用展开全部，请使用搜索或逐层展开`, 'processing');
          return;
        }
        setStatus('超大内容模式：已禁用展开全部，请使用搜索或逐层展开', 'processing');
        return;
      }
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
    hasExpandedAllTree = false;
    isLargeTreeMode = false;
    treeView.textContent = '解析失败，请检查内容格式';
    treeView.classList.add('empty');
    setStatus(error.message, 'error');
    updateProcessInputButtonVisibility();
    updateTreeBatchButtons();
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

contextCopyKeyBtn.addEventListener('click', () => {
  const activeMeta = contextTreeMeta || selectedTreeMeta;
  if (!activeMeta || activeMeta.key === null || activeMeta.key === undefined) return;
  copyText(String(activeMeta.key), '已复制当前键名');
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

contextCompactBtn.addEventListener('click', () => {
  compactInputContent();
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
  cancelTreeBatchOperations();
  const didPersistDraft = saveInputDraft(inputBox.value);
  if (!inputBox.value.trim()) {
    lastParseFailed = false;
  }
  if (!didPersistDraft && !didWarnDraftStorageDisabled && inputBox.value.trim()) {
    didWarnDraftStorageDisabled = true;
    setStatus('内容过大，已跳过本地草稿保存，继续解析中', 'processing');
  }
  updateProcessInputButtonVisibility();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processInput, 220);
});

clearBtn.addEventListener('click', () => {
  cancelTreeBatchOperations();
  inputBox.value = '';
  saveInputDraft('');
  currentData = null;
  lastParseFailed = false;
  hasExpandedAllTree = false;
  isLargeTreeMode = false;
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
  updateTreeBatchButtons();
});

processInputBtn.addEventListener('click', () => {
  applyUnescapeToWholeInput();
});

compactBtn.addEventListener('click', () => {
  compactInputContent();
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

updateFullscreenButtonLabel();
applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === 'mono' ? 'mono' : 'color', false);
updateTreeActionButtons();
updateProcessInputButtonVisibility();
updateTreeBatchButtons();

let savedInput = '';
try {
  savedInput = localStorage.getItem(INPUT_STORAGE_KEY) || '';
} catch {
  savedInput = '';
}
if (savedInput) {
  inputBox.value = savedInput;
  updateProcessInputButtonVisibility();
  processInput();
}

collapseAllBtn.addEventListener('click', () => {
  void runTreeBatchAction(() => {
    setAllCollapsed(true);
    hasExpandedAllTree = false;
  }, '正在收起内容…', '已收起内容');
});

expandAllBtn.addEventListener('click', () => {
  if (isLargeTreeMode) {
    setStatus('超大内容模式下已禁用展开全部，请使用搜索或逐层展开', 'error');
    return;
  }
  void runTreeBatchAction(
    async (batchToken) => {
      const result = await expandAllNodes(batchToken);
      hasExpandedAllTree = result.completed;
      if (!result.completed) {
        throw new Error(`节点过多，已暂停继续展开（已处理 ${result.processedCount} 个节点）。请使用搜索或逐层展开。`);
      }
    },
    '正在展开全部节点中，请稍等...',
    '已展开全部内容',
    'processing'
  );
});
