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
const https = require('https');
const net = require('net');
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
 * 访问令牌：配置后 /api/fetch 必须带匹配的 token 才允许抓取。
 * 用于把公网部署的抓取接口限定给「受信任的软件」使用。
 */
const FETCH_TOKEN = String(process.env.FETCH_TOKEN || '').trim();

/* 定长比较，避免通过响应时间推测令牌内容 */
function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/*
 * 统一的安全响应头。页面没有内联脚本、内联样式、内联事件处理器，
 * 脚本与 Worker 都同源加载，所以 CSP 可以收得很紧。
 *
 * connect-src 只能放开：浏览器直连兜底需要请求用户指定的任意地址，
 * 这是功能本身决定的，无法再收窄。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'",
    "img-src 'self' data:",
    'connect-src *',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; ')
};

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

/* 部署在反向代理后面时，真实客户端 IP 在 X-Forwarded-For 里 */
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(String(process.env.TRUST_PROXY || '').trim());

function clientIpOf(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

/*
 * 抓取接口限流：每个来源每分钟最多 RATE_LIMIT_MAX 次。
 * 目的是防止被当成免费代理刷流量、以及用并发大文件把内存打爆。
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map();

function consumeRateLimit(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { start: now, count: 1 });
    return { allowed: true };
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  return { allowed: true };
}

/* 定期清理过期计数，避免 Map 无限增长 */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

/*
 * 同时进行的远端抓取数量上限。每个抓取最多缓冲 20MB，
 * 不限并发的话少量请求就能把进程内存吃满。
 */
const MAX_CONCURRENT_FETCHES = 8;
let activeFetches = 0;

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

/*
 * IPv4 私有 / 保留地址判断。输入必须是点分四段，非法输入一律按「不安全」处理（失败即拦截）。
 *
 * 覆盖范围：
 *   0.0.0.0/8        本网络
 *   10.0.0.0/8       私有
 *   100.64.0.0/10    CGNAT（运营商级 NAT，常被云厂商内部使用）
 *   127.0.0.0/8      回环
 *   169.254.0.0/16   链路本地（含 169.254.169.254 云元数据）
 *   172.16.0.0/12    私有
 *   192.0.0.0/24     IETF 协议分配
 *   192.168.0.0/16   私有
 *   198.18.0.0/15    基准测试
 *   224.0.0.0/4      组播，以及 240.0.0.0/4 保留
 */
function isPrivateIPv4(address) {
  const parts = String(address).split('.').map((item) => Number(item));
  if (parts.length !== 4 || parts.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) {
    return true;
  }

  const [first, second, third] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first >= 224) return true;
  return false;
}

/*
 * 把 IPv6 地址解析成 8 个 16 位分组，解析失败返回 null。
 *
 * 自己实现的原因：Node 没有内置 IP 解析，而 WHATWG URL 解析器会把
 * ::ffff:127.0.0.1 归一化成 ::ffff:7f00:1。只认点分形式的正则永远匹配不上，
 * 会让 IPv4 映射地址完全绕过内网拦截——这是实际可利用的 SSRF 绕过。
 */
function parseIPv6Groups(address) {
  let text = String(address).toLowerCase().split('%')[0];
  if (!text.includes(':')) return null;

  /* 末尾可能是点分 IPv4（如 ::ffff:127.0.0.1），先摘出来换算成两个分组 */
  let tailGroups = null;
  const v4Match = text.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const octets = [v4Match[1], v4Match[2], v4Match[3], v4Match[4]].map(Number);
    if (octets.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
    tailGroups = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, v4Match.index + 1);
  }

  const parseHalf = (half) => {
    if (!half) return [];
    const groups = [];
    for (const piece of half.split(':')) {
      if (!piece) continue;
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left === null || right === null) return null;

  let groups;
  if (halves.length === 2) {
    const filled = 8 - left.length - right.length - (tailGroups ? tailGroups.length : 0);
    if (filled < 0) return null;
    groups = left.concat(new Array(filled).fill(0), right);
  } else {
    groups = left;
  }

  if (tailGroups) groups = groups.concat(tailGroups);
  return groups.length === 8 ? groups : null;
}

/*
 * IPv6 私有 / 保留地址判断。覆盖：
 *   ::              未指定
 *   ::1             回环
 *   fe80::/10       链路本地
 *   fc00::/7        唯一本地
 *   ff00::/8        组播
 *   2001:db8::/32   文档用
 *   ::ffff:0:0/96   IPv4 映射地址、::/96 IPv4 兼容地址、64:ff9b::/96 NAT64
 *                   —— 取出内嵌的 IPv4 再按 IPv4 规则判断
 */
function isPrivateIPv6(address) {
  const groups = parseIPv6Groups(address);
  if (!groups) return true; // 解析不了就当不安全

  const allZero = (list) => list.every((num) => num === 0);

  if (allZero(groups)) return true;
  if (allZero(groups.slice(0, 7)) && groups[7] === 1) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  const isMapped = allZero(groups.slice(0, 5)) && groups[5] === 0xffff;
  const isCompat = allZero(groups.slice(0, 6));
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && allZero(groups.slice(2, 6));

  if (isMapped || isCompat || isNat64) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(embedded);
  }

  return false;
}

function isPrivateAddress(address) {
  const text = String(address);
  if (text.includes(':')) return isPrivateIPv6(text);
  return isPrivateIPv4(text);
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

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400, code: 'bad-url' });
  }

  if (!records.length) {
    throw Object.assign(new Error('无法解析链接的域名'), { statusCode: 400, code: 'bad-url' });
  }

  if (!FETCH_ALLOW_PRIVATE && !isHostAllowlisted(host)) {
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

  /*
   * 返回解析结果，供调用方把连接「钉」在这个 IP 上。
   *
   * 只做「先解析再检查」是不够的：真正建立连接时如果重新解析，
   * 攻击者可以用 TTL 0 的 DNS 记录在两次解析之间把域名切到内网地址
   * （DNS 重绑定）。把 IP 固定下来才能堵住这个时间差。
   */
  return records[0];
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

/**
 * 流式读取响应体，每收到一块就回调 onProgress（用于重置空闲超时）。
 * 超限立即中断，而不是读完整个文件再判断。
 */
async function readLimitedStream(stream, onProgress) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > REMOTE_FETCH_MAX_BYTES) {
      throw createTooLargeError(total);
    }
    chunks.push(chunk);
    if (onProgress) onProgress();
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 发一次 GET 请求，把连接钉在已经校验过的 IP 上。
 *
 * 不用全局 fetch 的原因：fetch 不接受自定义 lookup，无法固定解析结果，
 * DNS 重绑定就能绕过内网拦截。用 http/https 模块可以传 lookup，
 * 强制连接到校验过的那个地址。
 */
function requestPinned(targetUrl, pinned, signal, headers) {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const mod = isHttps ? https : http;
    const hostname = targetUrl.hostname.replace(/^\[|\]$/g, '');

    const options = {
      host: hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'GET',
      headers: Object.assign({ Host: targetUrl.host }, headers),
      signal,
      /* 无论调用方请求哪个地址，都只连到 pinned 里那个已校验的 IP */
      lookup: (host, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) {
          return callback(null, [{ address: pinned.address, family: pinned.family }]);
        }
        return callback(null, pinned.address, pinned.family);
      }
    };

    /* SNI 与证书校验仍用域名；IP 字面量不设 servername */
    if (isHttps && net.isIP(hostname) === 0) {
      options.servername = hostname;
    }

    const req = mod.request(options, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function fetchRemoteText(rawUrl, options) {
  const settings = options || {};
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

    /*
     * 内网拦截范围只由服务端环境变量决定，**不接受请求参数放宽**。
     * 早先的 ?app= 放行是设计缺陷：app 不是密钥，谁知道值谁就能摸内网。
     */
    const pinned = await assertPublicHost(current.hostname);

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
      const response = await requestPinned(current, pinned, controller.signal, requestHeaders);

      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        const location = response.headers.location;
        response.resume(); // 丢弃重定向响应体
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

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw Object.assign(new Error(`链接返回 HTTP ${response.statusCode}`), {
          statusCode: 502,
          code: 'upstream-status'
        });
      }

      /*
       * 先看 Content-Length：超出上限就立刻掐断连接，一个字节都不下载。
       * 分块传输没有该字段，才退回到下面的流式累加判断。
       */
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > REMOTE_FETCH_MAX_BYTES) {
        response.destroy();
        controller.abort();
        throw createTooLargeError(declaredLength);
      }

      const text = await readLimitedStream(response, armIdleTimeout);

      return {
        finalUrl: current.toString(),
        contentType: response.headers['content-type'] || '',
        contentLength: response.headers['content-length'] || '',
        text
      };
    } catch (error) {
      if (error && error.statusCode) throw error;
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
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
   * 配置了 FETCH_TOKEN 之后，/api/fetch 就只对持有令牌的调用方开放。
   * 这样即使站点部署在公网，也不会被陌生人当成开放代理随意使用。
   * 不配置则完全跳过校验（默认行为不变）。
   *
   * 令牌优先从请求头读，其次才看查询参数——查询串会进 Nginx 访问日志，
   * 请求头不会，能少一处泄露面。
   */
  if (FETCH_TOKEN) {
    const provided = req.headers['x-json-pretty-token'] || requestUrl.searchParams.get('token') || '';
    if (!safeTokenEqual(provided, FETCH_TOKEN)) {
      sendJson(res, 401, {
        ok: false,
        code: 'unauthorized',
        error: 'token 无效或缺失。请在请求头 X-Json-Pretty-Token 中带上令牌'
      });
      return;
    }
  }

  const rate = consumeRateLimit(clientIpOf(req));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    sendJson(res, 429, {
      ok: false,
      code: 'rate-limited',
      error: `请求过于频繁，请 ${rate.retryAfter} 秒后重试`
    });
    return;
  }

  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    res.setHeader('Retry-After', '2');
    sendJson(res, 429, { ok: false, code: 'busy', error: '当前抓取请求过多，请稍后重试' });
    return;
  }

  activeFetches += 1;
  try {
    const result = await fetchRemoteText(target, { app });
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

    /*
     * 只有确实是 JSON 才把内容回传。
     *
     * 不加这一步的话，这个接口就是个「抓什么返回什么」的通用代理：
     * 别人可以拿它抓任意网页 HTML、图片，流量和追责 IP 都算在你头上。
     * 限定成「只回传 JSON」之后，它就不能当通用爬虫代理用了。
     */
    if (!isJson) {
      sendJson(res, 200, {
        ok: true,
        isJson: false,
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        contentLength: result.contentLength
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      isJson: true,
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
  } finally {
    activeFetches -= 1;
  }
}

// ---------- 服务 ----------

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);

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

  /* 前缀比较要带上分隔符，否则 public-xxx 这类同级目录也会被判为合法 */
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
  console.log(`  访问令牌：${FETCH_TOKEN ? '已启用（/api/fetch 需要 X-Json-Pretty-Token 头）' : '未启用（公网部署建议开启，否则任何人都能用它抓取任意地址）'}`);
  console.log(`  限流阈值：每 IP 每分钟 ${RATE_LIMIT_MAX} 次，并发抓取上限 ${MAX_CONCURRENT_FETCHES}`);
  if (FETCH_ALLOW_HOSTS.includes('*')) {
    console.log('  ⚠️  警告：FETCH_ALLOW_HOSTS 含通配符 *，内网拦截已完全失效');
  }
  if (FETCH_ALLOW_PRIVATE) {
    console.log('  ⚠️  警告：FETCH_ALLOW_PRIVATE=1，内网拦截已完全失效，切勿用于公网部署');
  }
  console.log('──────────────────────────────────────────────');
});
