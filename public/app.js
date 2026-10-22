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
const exactSearchToggleBtn = document.getElementById('exactSearchToggleBtn');
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
const LARGE_INPUT_BUSY_THRESHOLD = 50000;
const EXTREME_INPUT_LENGTH_THRESHOLD = 400000;
const FRAME_BUDGET_MS = 8;
const CHILD_RENDER_BATCH_SIZE = 150;
const INPUT_DRAFT_STORAGE_LIMIT = 200000;
const ROOT_AUTO_COLLAPSE_ENTRY_THRESHOLD = 800;
const LARGE_TREE_ESTIMATE_NODE_THRESHOLD = 3500;
const LARGE_TREE_ESTIMATE_SCAN_LIMIT = 5000;
const LARGE_TREE_CONTAINER_BREADTH_THRESHOLD = 600;
const EXPAND_ALL_NODE_LIMIT = 12000;
const EXPAND_ALL_STATUS_INTERVAL = 200;
/* 不超过这个长度就在主线程直接解析，省掉 Worker 往返开销 */
const SYNC_PARSE_MAX_LENGTH = 8192;

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
let isExactSearchEnabled = false;
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
let currentTreeAnalysis = null;
let shouldClearSearchOnNextInput = false;
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

function analyzeTreeComplexity(value, inputLength = 0) {
  const rootEntryCount = getContainerEntryCount(value);

  if (!value || typeof value !== 'object') {
    return {
      isLargeTree: inputLength >= EXTREME_INPUT_LENGTH_THRESHOLD,
      reason: inputLength >= EXTREME_INPUT_LENGTH_THRESHOLD ? 'extreme-input' : 'simple-value',
      rootEntryCount,
      estimatedNodes: 1,
      maxBreadth: 0,
      scannedAll: true
    };
  }

  let estimatedNodes = 0;
  let maxBreadth = rootEntryCount;
  let scannedAll = true;
  const queue = [value];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    estimatedNodes += 1;
    if (estimatedNodes >= LARGE_TREE_ESTIMATE_SCAN_LIMIT) {
      scannedAll = false;
      break;
    }

    if (!current || typeof current !== 'object') continue;

    const entries = Array.isArray(current) ? current : Object.values(current);
    if (entries.length > maxBreadth) {
      maxBreadth = entries.length;
    }

    for (let index = 0; index < entries.length; index += 1) {
      const child = entries[index];
      if (child && typeof child === 'object') {
        queue.push(child);
      } else {
        estimatedNodes += 1;
        if (estimatedNodes >= LARGE_TREE_ESTIMATE_SCAN_LIMIT) {
          scannedAll = false;
          break;
        }
      }
    }
  }

  const isExtremeInput = inputLength >= EXTREME_INPUT_LENGTH_THRESHOLD;
  const isWideRoot = rootEntryCount >= ROOT_AUTO_COLLAPSE_ENTRY_THRESHOLD;
  const isBroadTree = maxBreadth >= LARGE_TREE_CONTAINER_BREADTH_THRESHOLD;
  const isDenseTree = estimatedNodes >= LARGE_TREE_ESTIMATE_NODE_THRESHOLD;
  const isLargeTree = isExtremeInput || isWideRoot || isBroadTree || isDenseTree;

  let reason = 'normal';
  if (isExtremeInput) {
    reason = 'extreme-input';
  } else if (isWideRoot) {
    reason = 'wide-root';
  } else if (isBroadTree) {
    reason = 'broad-tree';
  } else if (isDenseTree) {
    reason = 'dense-tree';
  }

  return {
    isLargeTree,
    reason,
    rootEntryCount,
    estimatedNodes,
    maxBreadth,
    scannedAll
  };
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

function showTreePlaceholder(message) {
  treeView.classList.remove('notice');
  treeView.textContent = message;
  treeView.classList.add('empty');
}

/**
 * 在结果区展示一条提示（标题 + 说明 + 可选代码片段 + 可选操作建议）。
 * 解析失败、内容过大等场景共用。
 */
function showResultNotice(options) {
  const info = options || {};

  treeView.classList.remove('empty');
  treeView.classList.add('notice');
  treeView.textContent = '';

  const title = document.createElement('div');
  title.className = 'notice-title';
  title.textContent = info.title || '提示';
  treeView.appendChild(title);

  const message = document.createElement('div');
  message.className = 'notice-message';
  message.textContent = info.message || '';
  treeView.appendChild(message);

  if (info.snippet) {
    const snippet = document.createElement('pre');
    snippet.className = 'notice-snippet';
    snippet.textContent = info.snippet;
    treeView.appendChild(snippet);
  }

  if (info.hint) {
    const hint = document.createElement('div');
    hint.className = 'notice-hint';
    hint.textContent = info.hint;
    treeView.appendChild(hint);
  }
}

/**
 * 解析失败时展示「错在哪一行、错在哪一列」以及带箭头的上下文片段，
 * 比原来一句「解析失败，请检查内容格式」有用得多。
 */
function showParseErrorPanel(detail) {
  const info = detail || {};

  showResultNotice({
    title: '解析失败',
    message: info.summary || '解析失败，请检查内容格式',
    snippet: info.snippet,
    hint: '按提示修改输入框里的内容即可，改完会自动重新解析。'
  });
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

function updateClearButtonState(hasInput) {
  /* 输入框为空时它就是「粘贴」，有内容时是「清除」 */
  const showPaste = !hasInput;
  const label = showPaste ? '粘贴' : '清除';
  const title = showPaste ? '粘贴剪贴板内容' : '清空输入内容';

  clearBtn.textContent = label;
  clearBtn.setAttribute('title', title);
  clearBtn.setAttribute('aria-label', title);
  clearBtn.disabled = false;
}

function updateProcessInputButtonVisibility() {
  const hasInput = Boolean(inputBox.value.trim());
  const shouldShow = hasInput && lastParseFailed;
  processInputBtn.classList.toggle('visible', shouldShow);
  processInputBtn.classList.toggle('attention', shouldShow);
  compactBtn.disabled = !hasInput;
  updateClearButtonState(hasInput);
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

function clearTreeSearchState(resetInput = true) {
  searchResults = [];
  searchResultIndex = -1;
  searchKeyword = '';
  treeView.querySelectorAll('.tree-row.search-hit').forEach((row) => row.classList.remove('search-hit'));
  if (resetInput) {
    treeSearchInput.value = '';
  }
  updateTreeActionButtons();
}

function isWholeInputReplacement(event) {
  const inputTypes = new Set([
    'insertFromPaste',
    'insertFromDrop',
    'insertReplacementText'
  ]);
  if (!inputTypes.has(event.inputType)) {
    return false;
  }

  const currentValue = inputBox.value;
  if (!currentValue) {
    return true;
  }

  const selectionStart = inputBox.selectionStart ?? 0;
  const selectionEnd = inputBox.selectionEnd ?? 0;
  return selectionStart === 0 && selectionEnd === currentValue.length;
}

function updateExactSearchToggleButton() {
  if (!exactSearchToggleBtn) return;
  const enabled = isTreeFullscreen && isExactSearchEnabled;
  exactSearchToggleBtn.classList.toggle('is-active', enabled);
  exactSearchToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  exactSearchToggleBtn.setAttribute('title', enabled ? '关闭精准搜索' : '开启精准搜索');
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

function createParseError(result) {
  const detail = (result && result.detail) || {
    summary: '解析失败，请检查内容格式',
    reason: '存在语法错误',
    line: -1,
    column: -1,
    snippet: ''
  };
  const error = new Error(detail.summary);
  error.parseDetail = detail;
  return error;
}

function runParseSync(input) {
  const result = SmartJSON.tryParse(input);
  if (!result.ok) throw createParseError(result);
  return result.empty ? null : result.value;
}

function getParseWorker() {
  if (typeof Worker === 'undefined') return null;
  if (parseWorker) return parseWorker;

  parseWorker = new Worker('./parser-worker.js');
  parseWorker.addEventListener('message', (event) => {
    const { id, ok, value, empty, detail } = event.data || {};
    const handlers = pendingWorkerJobs.get(id);
    if (!handlers) return;

    pendingWorkerJobs.delete(id);
    if (ok) {
      handlers.resolve(empty ? null : value);
      return;
    }
    handlers.reject(createParseError({ detail }));
  });

  parseWorker.addEventListener('error', () => {
    pendingWorkerJobs.forEach(({ reject }) => {
      reject(new Error('解析失败：解析线程异常'));
    });
    pendingWorkerJobs.clear();
    parseWorker = null;
  });

  return parseWorker;
}

function parseSmart(input) {
  const raw = input.trim();
  if (!raw) return Promise.resolve(null);

  /*
   * 小输入直接在主线程解析：省掉 postMessage 与结构化克隆的往返开销，
   * 实测这段开销对几百字节的输入来说比解析本身还大。
   */
  if (raw.length <= SYNC_PARSE_MAX_LENGTH) {
    try {
      return Promise.resolve(runParseSync(raw));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const worker = getParseWorker();
  if (!worker) {
    try {
      return Promise.resolve(runParseSync(raw));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const jobId = ++latestParseToken;
  return new Promise((resolve, reject) => {
    pendingWorkerJobs.set(jobId, { resolve, reject });
    worker.postMessage({ id: jobId, input: raw });
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
  updateExactSearchToggleButton();
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
  if (isExactSearchEnabled) {
    isExactSearchEnabled = false;
    updateExactSearchToggleButton();
    if (treeSearchInput.value.trim() && currentData) {
      runTreeSearch();
    }
  } else {
    updateExactSearchToggleButton();
  }
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

function normalizeExactSearchTerm(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function matchesExactSearch(value, keyword, key) {
  const normalizedKeyword = normalizeExactSearchTerm(keyword);
  if (!normalizedKeyword) return false;

  const matchesKey = key !== null && normalizeExactSearchTerm(key) === normalizedKeyword;
  if (matchesKey) return true;
  if (value && typeof value === 'object') return false;
  return normalizeExactSearchTerm(value) === normalizedKeyword;
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

function buildExactSearchMatches(value, keyword, path = [], key = null, matches = []) {
  if (matchesExactSearch(value, keyword, key)) {
    matches.push(path);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => buildExactSearchMatches(item, keyword, [...path, index], index, matches));
    return matches;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => {
      buildExactSearchMatches(childValue, keyword, [...path, childKey], childKey, matches);
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

  searchResults = isExactSearchEnabled
    ? buildExactSearchMatches(currentData, keyword)
    : buildSearchMatches(currentData, keyword);
  updateTreeActionButtons();
  if (!searchResults.length) {
    setStatus(isExactSearchEnabled ? '未找到精准匹配内容' : '未找到匹配内容', 'error');
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
  treeView.classList.remove('notice');

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
    currentTreeAnalysis = null;
    lastParseFailed = false;
    hasExpandedAllTree = false;
    isLargeTreeMode = false;
    showTreePlaceholder('粘贴后会自动解析并显示在这里');
    setStatus('等待粘贴内容', 'muted');
    updateProcessInputButtonVisibility();
    updateTreeBatchButtons();
    return;
  }

  try {
    const shouldShowBusy = inputValue.length >= LARGE_INPUT_BUSY_THRESHOLD;
    isLargeTreeMode = false;
    if (shouldShowBusy) {
      showTreePlaceholder('内容较大，正在处理中…');
      setStatus('内容较大，正在处理中', 'muted');
      await nextFrame();
    }

    const parsed = await parseSmart(inputValue);
    if (renderToken !== latestRenderToken || parsed === null) return;

    currentData = parsed;
    currentTreeAnalysis = analyzeTreeComplexity(parsed, inputValue.length);
    lastParseFailed = false;
    hasExpandedAllTree = false;
    isLargeTreeMode = currentTreeAnalysis.isLargeTree;
    updateProcessInputButtonVisibility();
    updateTreeBatchButtons();
    const startRender = async () => {
      const renderResult = await renderTreeAsync(parsed, renderToken);
      if (renderToken !== latestRenderToken) return;
      const rootStartsCollapsed = Boolean(renderResult?.rootStartsCollapsed);
      isLargeTreeMode = isLargeTreeMode || rootStartsCollapsed;
      updateTreeBatchButtons();
      if (isLargeTreeMode) {
        const analysis = currentTreeAnalysis || {};
        const reasonLabelMap = {
          'extreme-input': '文本体积特别大',
          'wide-root': '根节点子项很多',
          'broad-tree': '某一层节点很多',
          'dense-tree': '整体节点很多',
          'normal': '内容结构较大'
        };
        const reasonLabel = reasonLabelMap[analysis.reason] || '内容结构较大';
        if (rootStartsCollapsed) {
          setStatus(
            `超大内容模式：${reasonLabel}，已默认收起根节点（${renderResult?.rootEntryCount || 0} 项）并禁用展开全部，请使用搜索或逐层展开`,
            'processing'
          );
          return;
        }
        setStatus(`超大内容模式：${reasonLabel}，已禁用展开全部，请使用搜索或逐层展开`, 'processing');
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
    currentTreeAnalysis = null;
    lastParseFailed = true;
    hasExpandedAllTree = false;
    isLargeTreeMode = false;
    showParseErrorPanel(error.parseDetail);
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

inputBox.addEventListener('beforeinput', (event) => {
  shouldClearSearchOnNextInput = isWholeInputReplacement(event);
});

inputBox.addEventListener('input', () => {
  cancelTreeBatchOperations();
  if (shouldClearSearchOnNextInput) {
    clearTreeSearchState();
  }
  shouldClearSearchOnNextInput = false;
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

function clearInputContent() {
  cancelTreeBatchOperations();
  inputBox.value = '';
  saveInputDraft('');
  currentData = null;
  currentTreeAnalysis = null;
  lastParseFailed = false;
  hasExpandedAllTree = false;
  isLargeTreeMode = false;
  selectedTreeMeta = null;
  selectedTreeRow = null;
  selectedPathKey = '';
  clearTreeSearchState();
  showTreePlaceholder('粘贴后会自动解析并显示在这里');
  setStatus('内容已清空', 'muted');
  updateTreeActionButtons();
  updateProcessInputButtonVisibility();
  updateTreeBatchButtons();
}

/**
 * 把一段文本放进输入框并立即解析。
 * options.focus 为 false 时不抢焦点（例如打开 ?url= 分享链接时，避免手机弹出键盘）。
 */
async function applyInputText(text, successMessage, options = {}) {
  const shouldFocus = options.focus !== false;

  cancelTreeBatchOperations();
  inputBox.value = text;
  saveInputDraft(text);
  clearTreeSearchState();
  updateProcessInputButtonVisibility();

  if (shouldFocus) {
    inputBox.focus();
    try {
      inputBox.setSelectionRange(text.length, text.length);
    } catch {
      // 部分浏览器在未聚焦时不允许设置选区，忽略即可
    }
  }

  await processInput();
  if (successMessage) setStatus(successMessage, 'success');
}

const IS_APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const PASTE_SHORTCUT = IS_APPLE_PLATFORM ? '⌘ + V' : 'Ctrl + V';

function focusInputForManualPaste() {
  inputBox.focus();
  const end = inputBox.value.length;
  try {
    inputBox.setSelectionRange(end, end);
  } catch {
    // 忽略选区设置失败
  }
}

function describeClipboardError(error) {
  const name = (error && error.name) || '';
  if (name === 'NotAllowedError') {
    return '浏览器拒绝了剪贴板权限，请在地址栏左侧的站点设置里把「剪贴板」改成「允许」';
  }
  if (name === 'NotFoundError') {
    return '剪贴板里没有文本内容';
  }
  if (name === 'SecurityError') {
    return '出于安全限制无法读取剪贴板';
  }
  return `读取剪贴板失败${name ? `（${name}）` : ''}`;
}

/**
 * 读取剪贴板并填入输入框。
 *
 * 浏览器不允许网页静默读取剪贴板，必须满足两个条件：
 *   1. 安全上下文（HTTPS 或 localhost）
 *   2. 用户授权（首次会弹权限提示，被拒绝后会一直失败）
 * 任一不满足都给出具体原因，并把焦点交给输入框，方便直接按快捷键粘贴。
 */
async function pasteFromClipboard() {
  if (!window.isSecureContext || !navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    setStatus(`当前页面不是安全上下文（需要 HTTPS 或 localhost），浏览器不允许读取剪贴板。请直接按 ${PASTE_SHORTCUT}`, 'error');
    focusInputForManualPaste();
    return;
  }

  // readText 要求文档处于聚焦状态，否则同样会抛 NotAllowedError
  if (!document.hasFocus()) {
    inputBox.focus();
  }

  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
    setStatus(`${describeClipboardError(error)}；也可以直接按 ${PASTE_SHORTCUT}`, 'error');
    focusInputForManualPaste();
    return;
  }

  if (!text) {
    setStatus('剪贴板里没有文本内容', 'error');
    focusInputForManualPaste();
    return;
  }

  await applyInputText(text, '已粘贴剪贴板内容');
}

clearBtn.addEventListener('click', () => {
  if (inputBox.value.trim()) {
    clearInputContent();
  } else {
    void pasteFromClipboard();
  }
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

exactSearchToggleBtn.addEventListener('click', () => {
  if (!isTreeFullscreen) return;
  isExactSearchEnabled = !isExactSearchEnabled;
  updateExactSearchToggleButton();
  runTreeSearch();
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

const SHARED_URL_PARAM = 'url';
const REMOTE_FETCH_ENDPOINT = '/api/fetch';

/* 与 server.js 的 REMOTE_FETCH_MAX_BYTES 保持一致，仅用于本地展示与直连兜底拦截。 */
const REMOTE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildTooLargeMessage(info) {
  const limit = formatBytes(info.limitBytes || REMOTE_FETCH_MAX_BYTES);
  const actual = info.contentLength ? `（实际 ${formatBytes(info.contentLength)}）` : '';
  return `链接返回的内容过大${actual}，超过 ${limit} 上限，已停止下载`;
}

/** 内容过大时在结果区给出醒目提示，而不是只在一行状态栏里闪过。 */
function showTooLargeNotice(info) {
  showResultNotice({
    title: '内容过大，已停止下载',
    message: buildTooLargeMessage(info),
    hint: '换一个更小的链接，或让数据提供方分页、加筛选条件。'
  });
}

function readSharedUrlParam() {
  try {
    const value = new URLSearchParams(window.location.search).get(SHARED_URL_PARAM);
    return value ? value.trim() : '';
  } catch {
    return '';
  }
}

/* 浏览器直连时用于携带密钥的请求头名（app 标识不是密钥，走查询串） */
const TOKEN_HEADER = 'X-Json-Pretty-Token';

/*
 * 令牌读取顺序：
 *   1. URL 片段（#token=xxx）—— 片段不会发送给服务器，因此不会进访问日志
 *   2. 查询串（?token=xxx）—— 兼容旧链接，但会被 Nginx 记录到日志
 *
 * 不落 localStorage：令牌是密钥，留在浏览器存储里只会增加暴露面。
 */
function readSharedToken() {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      const fromHash = new URLSearchParams(hash).get('token');
      if (fromHash && fromHash.trim()) return fromHash.trim();
    }
  } catch {
    // 片段解析失败就继续往下找
  }

  try {
    const value = new URLSearchParams(window.location.search).get('token');
    return value ? value.trim() : '';
  } catch {
    return '';
  }
}

function readSharedApp() {
  try {
    const value = new URLSearchParams(window.location.search).get('app');
    return value ? value.trim() : '';
  } catch {
    return '';
  }
}

async function requestRemoteJson(target) {
  const token = readSharedToken();
  const app = readSharedApp();
  const params = [`url=${encodeURIComponent(target)}`];
  if (app) params.push(`app=${encodeURIComponent(app)}`);

  /*
   * 令牌走请求头而不是查询串：查询串会原样写进 Nginx 访问日志，
   * 请求头不会。同源请求带自定义头不触发预检，没有额外代价。
   */
  const headers = { Accept: 'application/json' };
  if (token) headers[TOKEN_HEADER] = token;

  const response = await fetch(`${REMOTE_FETCH_ENDPOINT}?${params.join('&')}`, { headers });

  let payload = null;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== 'object') {
    // 静态部署时该接口不存在，交给浏览器直连兜底。
    const error = new Error(`服务端未返回有效内容（HTTP ${response.status}）`);
    error.proxyUnavailable = true;
    throw error;
  }

  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `获取链接内容失败（HTTP ${response.status}）`);
    error.code = payload.code || 'fetch-failed';
    error.limitBytes = payload.limitBytes;
    error.contentLength = payload.contentLength;
    throw error;
  }

  return payload;
}

/* 直连兜底时同样要拦截，阈值见上方 REMOTE_FETCH_MAX_BYTES。 */
function createTooLargeError(bytes) {
  const error = new Error(
    `链接内容过大（${formatBytes(bytes)}），超过 ${formatBytes(REMOTE_FETCH_MAX_BYTES)} 上限，已停止下载`
  );
  error.code = 'payload-too-large';
  error.limitBytes = REMOTE_FETCH_MAX_BYTES;
  error.contentLength = bytes;
  return error;
}

async function cancelResponseBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // 取消失败不影响主流程
  }
}

/**
 * 直连兜底：先看 Content-Length，超限就不下载；分块传输则流式累加，超限即中断。
 */
async function requestRemoteJsonDirect(target) {
  const token = readSharedToken();
  const app = readSharedApp();
  const headers = { Accept: 'application/json, text/plain, */*' };

  /*
   * 应用标识拼进 URL 的查询串，而不是走请求头。
   *
   * 原因：自定义请求头会触发 CORS 预检（OPTIONS）。很多本地小服务根本没实现
   * OPTIONS，会直接返回 405，浏览器于是中止整个请求、连 GET 都不发出去，
   * 页面只能看到一个笼统的 "Load failed"。
   * 放进查询串就变成「简单请求」，不触发预检——目标服务只要回
   * Access-Control-Allow-Origin 即可，不必处理 OPTIONS。
   *
   * app 本身不是密钥，写进 URL 不会泄露敏感信息。
   * 令牌（token）是密钥，仍然走请求头，不落到 URL 上。
   */
  const targetUrl = app ? appendQueryParam(target, 'app', app) : target;
  if (token) {
    headers[TOKEN_HEADER] = token;
  }

  const response = await fetch(targetUrl, { headers });

  if (!response.ok) {
    const error = new Error(`链接返回 HTTP ${response.status}`);
    error.code = 'upstream-status';
    error.status = response.status;
    throw error;
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > REMOTE_FETCH_MAX_BYTES) {
    await cancelResponseBody(response);
    throw createTooLargeError(declaredLength);
  }

  let text = '';
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      if (total > REMOTE_FETCH_MAX_BYTES) {
        throw createTooLargeError(total);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (text.length > REMOTE_FETCH_MAX_BYTES) {
      throw createTooLargeError(text.length);
    }
  }

  /*
   * 与输入框保持一致：标准 JSON 和 Python 字典都算可解析的数据。
   * 用整段解析而不是片段提取，避免把网页里夹带的 JSON 误判成接口返回。
   */
  const isJson = text.trim() ? SmartJSON.parseStrictData(text).ok : false;

  return { ok: true, isJson, content: text };
}

/*
 * 这些错误说明「链接本身不合法」，浏览器直连也一样会失败，没必要重试。
 * 其余（内网拦截、超时、连不上、上游报错）都值得让浏览器再试一次——
 * 服务端和用户浏览器所处的网络位置不同，服务端访问不到的地址，
 * 用户本机往往可以（最典型的就是 localhost）。
 */
const NO_DIRECT_RETRY_CODES = new Set(['bad-url', 'bad-redirect', 'payload-too-large', 'unauthorized']);

function describeDirectFetchFailure(directError, target) {
  const message = (directError && directError.message) || '';
  const loopback = isLoopbackHost(safeHostname(target));

  /* 线上页面 + 本机目标 + Safari：这是混合内容拦截，怎么配 CORS 都没用 */
  if (loopback && !isLocalPage() && isSafari()) {
    return (
      `${message}。Safari 会拦截 HTTPS 页面访问 http:// 地址（127.0.0.1 也不例外），` +
      '控制台会显示 "requested insecure content ... blocked"。' +
      '请改用 Chrome / Edge，或在本地运行本工具（FETCH_ALLOW_PRIVATE=1 node server.js）'
    );
  }

  if (loopback) {
    return (
      `${message}。浏览器没能读到本地服务的响应，常见原因：` +
      '① 服务没返回 Access-Control-Allow-Origin（**错误响应 401/405 也必须带**）；' +
      '② 服务地址或端口不对；' +
      '③ 请求被服务自身的鉴权拒绝。具体原因可看浏览器控制台'
    );
  }

  return `${message}。通常是跨域限制（目标站点需要返回 Access-Control-Allow-Origin，错误响应也要带），或该地址在当前网络下不可达`;
}

function safeHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

/* 往 URL 上追加查询参数，自动处理已有的 ? 与 # */
function appendQueryParam(rawUrl, key, value) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/* 目标主机是否是「回环地址」——这类地址只在本机有意义 */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

/* 当前页面本身是否跑在本机 */
function isLocalPage() {
  return isLoopbackHost(location.hostname);
}

/* 是否是 Safari（Chrome/Edge 的 UA 里也含 Safari，要排除掉） */
function isSafari() {
  const ua = navigator.userAgent || '';
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);
}

async function loadJsonFromSharedUrl(target) {
  setStatus('正在获取链接内容…', 'processing');

  let payload = null;
  let proxyError = null;

  /*
   * 线上页面 + 目标是本机回环地址：服务端一定够不到。
   * 服务端的 127.0.0.1 是服务器自己，不是用户的电脑——要么被 SSRF 拦截，
   * 要么（放行后）取到服务器上的无关服务。所以直接跳过服务端代理，
   * 省一次必然失败的往返，也避免给出误导性的报错。
   */
  const remotePageLocalTarget = isLoopbackHost(safeHostname(target)) && !isLocalPage();

  if (!remotePageLocalTarget) {
    try {
      payload = await requestRemoteJson(target);
    } catch (error) {
      proxyError = error;
    }
  }

  if (!payload) {
    if (proxyError && proxyError.code === 'payload-too-large') {
      showTooLargeNotice(proxyError);
      setStatus(buildTooLargeMessage(proxyError), 'error');
      return;
    }

    if (proxyError && proxyError.code === 'unauthorized') {
      setStatus(`获取链接内容失败：${proxyError.message}`, 'error');
      return;
    }

    const shouldRetryDirectly =
      remotePageLocalTarget ||
      !proxyError ||
      proxyError.proxyUnavailable ||
      !NO_DIRECT_RETRY_CODES.has(proxyError.code);

    if (!shouldRetryDirectly) {
      setStatus(`获取链接内容失败：${proxyError.message}`, 'error');
      return;
    }

    if (remotePageLocalTarget) {
      setStatus('目标是你本机的地址，服务端访问不到，正在用浏览器直连…', 'processing');
    } else if (proxyError) {
      setStatus('服务端取不到，正在用浏览器直连重试…', 'processing');
    }

    try {
      payload = await requestRemoteJsonDirect(target);
    } catch (directError) {
      if (directError && directError.code === 'payload-too-large') {
        showTooLargeNotice(directError);
        setStatus(buildTooLargeMessage(directError), 'error');
        return;
      }
      if (directError && directError.status === 401) {
        const app = readSharedApp();
        const hint = app
          ? `请确认 ?app=${app} 是该服务认可的标识`
          : readSharedToken()
            ? '请确认 ?token= 与该服务配置的令牌一致'
            : '该服务需要身份标识，请在 URL 上补 ?app=xxx';
        setStatus(`获取链接内容失败：目标服务返回 401，${hint}`, 'error');
        return;
      }
      setStatus(
        `获取链接内容失败：${describeDirectFetchFailure(directError, target)}`,
        'error'
      );
      return;
    }
  }

  if (!payload.isJson) {
    setStatus('链接返回的内容不是 JSON，未填入输入框', 'error');
    return;
  }

  await applyInputText(payload.content, '已从链接加载 JSON 内容', { focus: false });
}

let savedInput = '';
try {
  savedInput = localStorage.getItem(INPUT_STORAGE_KEY) || '';
} catch {
  savedInput = '';
}

const sharedUrl = readSharedUrlParam();
if (sharedUrl) {
  // 带 ?url= 分享链接时，优先展示链接内容。
  void loadJsonFromSharedUrl(sharedUrl);
} else if (savedInput) {
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
