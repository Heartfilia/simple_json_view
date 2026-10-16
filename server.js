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

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');

const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const REMOTE_FETCH_PATH = '/api/fetch';
/* 超时分两种：空闲 12s（每收到一块数据就重置）与总预算 60s。
   只用总超时会把「下载慢但一直在推进」的大文件误杀。 */
const REMOTE_FETCH_IDLE_TIMEOUT_MS = 12000;
const REMOTE_FETCH_TOTAL_TIMEOUT_MS = 60000;
/* ?url= 抓取的内容上限。超过就先看 Content-Length 直接拒绝，一个字节都不下载。 */
const REMOTE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const REMOTE_FETCH_MAX_REDIRECTS = 5;
const REMOTE_FETCH_USER_AGENT = 'json-pretty-web/3.1 (+https://json.litetools.top)';
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// 内网地址默认拦截（防 SSRF）。本地/内网部署时可通过环境变量放行：
//   FETCH_ALLOW_HOSTS=api.example.com,*.corp.example.com  仅放行指定域名
//   FETCH_ALLOW_PRIVATE=1                                 放行全部内网地址
const FETCH_ALLOW_HOSTS = String(process.env.FETCH_ALLOW_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase().replace(/\.$/, ''))
  .filter(Boolean);
const FETCH_ALLOW_PRIVATE = /^(1|true|yes|on)$/i.test(String(process.env.FETCH_ALLOW_PRIVATE || '').trim());

/*
 * 访问令牌：配置后 /api/fetch 必须带匹配的 token 参数才允许抓取。
 * 用于把公网部署的抓取接口限定给「受信任的软件」使用。
 */
const FETCH_TOKEN = String(process.env.FETCH_TOKEN || '').trim();

/*
 * 本地访问授权标识：请求带 ?app=<此值> 时，本次请求允许访问内网地址。
 *
 * 注意它**不是密钥**，只是一个应用标识，用来把「允许摸内网」这件事
 * 限定给特定场景，而不是全局打开（全局打开要用 FETCH_ALLOW_PRIVATE=1）。
 * 只有在确实需要「服务端自己去访问内网地址」时才配置它。
 */
const FETCH_LOCAL_APP = String(process.env.FETCH_LOCAL_APP || '').trim();

/* 定长比较，避免通过响应时间推测令牌内容 */
function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// ---------- 链接抓取（供 ?url= 分享链接使用） ----------

function isPrivateIPv4(address) {
  const parts = address.split('.').map((item) => Number(item));
  if (parts.length !== 4 || parts.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) {
    return true;
  }

  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first >= 224) return true;
  return false;
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

function isPrivateAddress(address) {
  if (address.includes(':')) return isPrivateIPv6(address);
  return isPrivateIPv4(address);
}

function isHostAllowlisted(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  return FETCH_ALLOW_HOSTS.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

async function assertPublicHost(hostname, allowPrivate) {
  const host = String(hostname).replace(/^\[|\]$/g, '');

  if (allowPrivate || FETCH_ALLOW_PRIVATE || isHostAllowlisted(host)) {
    return;
  }

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400, code: 'bad-url' });
  }

  if (!records.length) {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400, code: 'bad-url' });
  }

  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw Object.assign(
        new Error(
          `内网地址已被拦截（${host} → ${record.address}）。如需访问，请用 FETCH_ALLOW_HOSTS=${host} 或 FETCH_ALLOW_PRIVATE=1 启动服务`
        ),
        { statusCode: 403, code: 'blocked-host' }
      );
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function createTooLargeError(bytes) {
  return Object.assign(
    new Error(
      `链接内容过大（${formatBytes(bytes)}），超过 ${formatBytes(REMOTE_FETCH_MAX_BYTES)} 上限，已停止下载`
    ),
    {
      statusCode: 413,
      code: 'payload-too-large',
      limitBytes: REMOTE_FETCH_MAX_BYTES,
      contentLength: bytes
    }
  );
}

async function cancelResponseBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // 取消失败不影响主流程，连接最终会被关闭。
  }
}

/**
 * 流式读取响应体，每收到一块就回调 onProgress（用于重置空闲超时）。
 * 超限立即中断，而不是读完整个文件再判断。
 */
async function readLimitedText(response, onProgress) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      if (total > REMOTE_FETCH_MAX_BYTES) {
        throw createTooLargeError(total);
      }

      chunks.push(Buffer.from(value));
      if (onProgress) onProgress();
    }
  } finally {
    if (typeof reader.releaseLock === 'function') {
      try {
        reader.releaseLock();
      } catch {
        // 释放失败无需处理，读取流程已结束。
      }
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function fetchRemoteText(rawUrl, options) {
  const settings = options || {};
  const allowPrivate = Boolean(settings.allowPrivate);
  const appHeader = settings.app || '';

  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('链接格式不正确'), { statusCode: 400, code: 'bad-url' });
  }

  for (let hop = 0; hop <= REMOTE_FETCH_MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw Object.assign(new Error('仅支持 http / https 链接'), { statusCode: 400, code: 'bad-url' });
    }

    await assertPublicHost(current.hostname, allowPrivate);

    const controller = new AbortController();
    const deadline = Date.now() + REMOTE_FETCH_TOTAL_TIMEOUT_MS;
    let timer = null;
    const armIdleTimeout = () => {
      if (timer) clearTimeout(timer);
      const remaining = Math.min(REMOTE_FETCH_IDLE_TIMEOUT_MS, deadline - Date.now());
      timer = setTimeout(() => controller.abort(), Math.max(remaining, 1));
    };
    armIdleTimeout();

    const requestHeaders = {
      'User-Agent': REMOTE_FETCH_USER_AGENT,
      Accept: 'application/json, text/plain, */*'
    };
    /* 把应用标识透传给目标服务，目标服务可据此做自己的校验 */
    if (appHeader) requestHeaders['X-Json-Pretty-App'] = appHeader;

    try {
      const response = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: requestHeaders
      });

      if (REDIRECT_STATUS_CODES.has(response.status)) {
        const location = response.headers.get('location');
        await cancelResponseBody(response);
        if (!location) {
          throw Object.assign(new Error('链接重定向缺少目标地址'), {
            statusCode: 502,
            code: 'bad-redirect'
          });
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, current);
        } catch {
          throw Object.assign(new Error('链接重定向目标无效'), {
            statusCode: 502,
            code: 'bad-redirect'
          });
        }
        current = nextUrl;
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        throw Object.assign(new Error(`链接返回 HTTP ${response.status}`), {
          statusCode: 502,
          code: 'upstream-status'
        });
      }

      /*
       * 先看 Content-Length：超出上限就立刻掐断连接，一个字节都不下载。
       * 分块传输没有该字段，才退回到下面的流式累加判断。
       */
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > REMOTE_FETCH_MAX_BYTES) {
        controller.abort();
        throw createTooLargeError(declaredLength);
      }

      const text = await readLimitedText(response, armIdleTimeout);

      return {
        finalUrl: current.toString(),
        contentType: response.headers.get('content-type') || '',
        contentLength: response.headers.get('content-length') || '',
        text
      };
    } catch (error) {
      if (error && error.statusCode) throw error;
      if (error && error.name === 'AbortError') {
        throw Object.assign(new Error('链接访问超时'), { statusCode: 504, code: 'timeout' });
      }
      throw Object.assign(new Error('无法访问该链接'), { statusCode: 502, code: 'unreachable' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw Object.assign(new Error('链接重定向次数过多'), { statusCode: 502, code: 'bad-redirect' });
}

async function handleRemoteFetch(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('405 Method Not Allowed');
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { ok: false, error: '缺少 url 参数' });
    return;
  }

  if (target.length > 2048) {
    sendJson(res, 400, { ok: false, error: '链接过长' });
    return;
  }

  const app = requestUrl.searchParams.get('app') || '';
  /*
   * ?app=<FETCH_LOCAL_APP> 时本次请求放行内网地址。
   * 用于「服务端自己也要访问内网」的场景（比如工具和本地服务跑在同一台机器上）。
   * 注意：浏览器直连那条路径本来就能到用户的机器，不需要这个开关。
   */
  const allowPrivate = Boolean(FETCH_LOCAL_APP) && app === FETCH_LOCAL_APP;

  /*
   * 配置了 FETCH_TOKEN 之后，/api/fetch 就只对持有令牌的调用方开放。
   * 这样即使站点部署在公网，也不会被陌生人当成开放代理随意使用。
   * 不配置则完全跳过校验（默认行为不变）。
   */
  if (FETCH_TOKEN) {
    const provided = requestUrl.searchParams.get('token') || '';
    if (!safeTokenEqual(provided, FETCH_TOKEN)) {
      sendJson(res, 401, {
        ok: false,
        code: 'unauthorized',
        error: 'token 无效或缺失。请带上与 FETCH_TOKEN 一致的 token 参数'
      });
      return;
    }
  }

  try {
    const result = await fetchRemoteText(target, { allowPrivate, app });
    const trimmed = result.text.trim();
    let isJson = false;

    if (trimmed) {
      try {
        JSON.parse(trimmed);
        isJson = true;
      } catch {
        isJson = false;
      }
    }

    sendJson(res, 200, {
      ok: true,
      isJson,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      contentLength: result.contentLength,
      content: result.text
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      ok: false,
      code: error.code || 'fetch-failed',
      error: error.message || '获取链接内容失败',
      limitBytes: error.limitBytes,
      contentLength: error.contentLength
    });
  }
}

// ---------- 服务 ----------

const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  if (requestUrl.pathname === REMOTE_FETCH_PATH) {
    handleRemoteFetch(req, res, requestUrl);
    return;
  }

  let requestPath;
  try {
    requestPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const safePath = path.normalize(normalizedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  const fetchPolicy = FETCH_ALLOW_PRIVATE
    ? '放行全部内网地址（FETCH_ALLOW_PRIVATE=1）'
    : FETCH_ALLOW_HOSTS.length
      ? `放行指定域名：${FETCH_ALLOW_HOSTS.join(', ')}`
      : '内网地址已拦截（可用 FETCH_ALLOW_HOSTS / FETCH_ALLOW_PRIVATE 放行）';

  console.log('──────────────────────────────────────────────');
  console.log('  只做JSON格式化 已启动');
  console.log(`  本机访问：http://localhost:${PORT}`);
  console.log(`  监听地址：${HOST}:${PORT}`);
  console.log(`  抓取策略：${fetchPolicy}`);
  console.log(`  访问令牌：${FETCH_TOKEN ? '已启用（/api/fetch 需要 token）' : '未启用'}`);
  console.log(`  本地授权：${FETCH_LOCAL_APP ? `已启用（?app=${FETCH_LOCAL_APP} 可访问内网地址）` : '未启用'}`);
  console.log('──────────────────────────────────────────────');
});
