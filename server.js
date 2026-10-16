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

const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const REMOTE_FETCH_PATH = '/api/fetch';
const REMOTE_FETCH_TIMEOUT_MS = 12000;
const REMOTE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
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

async function assertPublicHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');

  if (FETCH_ALLOW_PRIVATE || isHostAllowlisted(host)) {
    return;
  }

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400 });
  }

  if (!records.length) {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400 });
  }

  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw Object.assign(
        new Error(
          `内网地址已被拦截（${host} → ${record.address}）。如需访问，请用 FETCH_ALLOW_HOSTS=${host} 或 FETCH_ALLOW_PRIVATE=1 启动服务`
        ),
        { statusCode: 403 }
      );
    }
  }
}

async function readLimitedText(response) {
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
        throw Object.assign(new Error('链接返回的内容过大（超过 5MB）'), { statusCode: 413 });
      }
      chunks.push(Buffer.from(value));
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

async function fetchRemoteText(rawUrl) {
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('链接格式不正确'), { statusCode: 400 });
  }

  for (let hop = 0; hop <= REMOTE_FETCH_MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw Object.assign(new Error('仅支持 http / https 链接'), { statusCode: 400 });
    }

    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
    let response;

    try {
      response = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': REMOTE_FETCH_USER_AGENT,
          Accept: 'application/json, text/plain, */*'
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(new Error('链接访问超时'), { statusCode: 504 });
      }
      throw Object.assign(new Error('无法访问该链接'), { statusCode: 502 });
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUS_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw Object.assign(new Error('链接重定向缺少目标地址'), { statusCode: 502 });
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, current);
      } catch {
        throw Object.assign(new Error('链接重定向目标无效'), { statusCode: 502 });
      }
      current = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw Object.assign(new Error(`链接返回 HTTP ${response.status}`), { statusCode: 502 });
    }

    return {
      finalUrl: current.toString(),
      contentType: response.headers.get('content-type') || '',
      text: await readLimitedText(response)
    };
  }

  throw Object.assign(new Error('链接重定向次数过多'), { statusCode: 502 });
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

  try {
    const result = await fetchRemoteText(target);
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
      content: result.text
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      ok: false,
      error: error.message || '获取链接内容失败'
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
  console.log('──────────────────────────────────────────────');
});
