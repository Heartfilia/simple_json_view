# 只做一件事

## 那就是 干净，简单，易用


[快捷使用_QuickUse](https://json.litetools.top)


### 部分操作在右键，页面保留的按钮是方便手机端的

当前功能已经足够日常使用了

### 输入框为空时，「清除」会变成「粘贴」

点一下直接把剪贴板内容填进去并解析，省得长按调出系统粘贴菜单。

浏览器不允许网页静默读取剪贴板，需要同时满足两个条件，否则按钮会给出具体原因并聚焦输入框：

1. **安全上下文** —— HTTPS 或 localhost。用 `http://内网IP:3456` 这类地址访问时浏览器不提供剪贴板接口。
2. **用户授权** —— 首次点击会弹权限提示。**一旦点了「拒绝」，之后会一直失败**，需要在地址栏左侧的站点设置里把「剪贴板」改成「允许」。

不满足时直接按 `⌘ + V`（Windows/Linux 为 `Ctrl + V`）粘贴即可，效果一样。

## 容错解析

粘贴进来就能用，不需要先手工清理。支持的情况：

| 情况 | 例子 |
|---|---|
| 标准 JSON | `{"a": 1}` |
| Python 字典 | `{'a': 1, 'b': True, 'c': None}` |
| 尾逗号 | `{"a": 1,}` / `[1, 2,]` |
| 注释 | `//`、`/* */`、行首 `#` |
| 裸 key | `{a: 1, b: 'x'}` |
| 数字 key | `{1: 'a', 2: 'b'}` |
| 特殊字面量 | `NaN` / `Infinity` / `-Infinity` / `undefined` / `...` → `null` |
| 混杂文本里提取 | `callback({"a":1})`、`var d = {...};`、日志/网页源码里夹带的 JSON |
| 转义字符串 | `"{\"a\": 1}"` 会自动再解析一层，直接出树 |
| 全角标点 | `｛"a"：1｝`、`{“a”: 1}`（字符串内部的全角字符不受影响） |
| 控制字符 | 字符串里的裸换行 / Tab 会自动转义 |

解析失败时不再只提示一句「解析失败」，而是给出**出错行列号**和带箭头指向的上下文片段：

```
第 3 行第 8 列：这里期待一个值（字符串 / 数字 / 对象 / 数组 / true / false / null）
  3 |   "b": ,
    |        ^
```

字符串内容不会被误伤——`{"a": ",}"}`、`{"url": "http://x.com"}`、`{"a": "/* 不是注释 */"}` 都按字面量处理。

### 性能

解析分两级：合法 JSON 直接走一次 `JSON.parse`，不做任何预处理；只有解析失败才逐级生成修复候选。

| 场景 | 旧实现 | 现在 |
|---|---|---|
| 5.15 MB 合法 JSON | 237 ms | **17 ms**（与裸 `JSON.parse` 持平） |
| 5.15 MB 单引号宽松 JSON | 483 ms | **175 ms** |

另外 8 KB 以内的输入在主线程直接解析，省掉 Worker 的往返开销；超过才交给 Worker，避免卡住界面。

## 通过链接直接打开 JSON

在地址后拼接 `?url=` 即可，例如：

```
https://json.litetools.top/?url=https%3A%2F%2Fexample.com%2Fdata.json
```

页面会自动请求该链接：返回内容是 JSON 时，直接填入输入框并解析展示；不是 JSON 则只提示、不填充。

- `url` 的值建议做 URL 编码（`encodeURIComponent`）。
- 抓取由服务端接口 `/api/fetch` 完成，因此需要以 `node server.js` 运行；纯静态部署会退回浏览器直连，此时受目标站点的跨域（CORS）策略限制。
- 判断是否为 JSON 以 `JSON.parse` 结果为准，不依赖响应头的 `Content-Type`，因此 `text/html` 返回 JSON 体的接口也能识别。
- 出于安全考虑，`/api/fetch` 只允许 http/https，默认禁止访问内网地址。

### 指向你自己本机的服务

**先理解一个容易混淆的点**：`?url=` 里的 `127.0.0.1` / `localhost` 指的是**谁的回环地址**，取决于这次请求由谁发出：

| 谁发起请求 | `127.0.0.1` 指谁 | 能不能拿到你的数据 |
|---|---|---|
| 服务端（`/api/fetch` 代理） | 部署这个工具的**服务器自己** | ❌ 拿不到你的电脑 |
| 你的浏览器（直连兜底） | **你正在用的这台电脑** | ✅ 能拿到 |

所以线上页面写 `?url=http://127.0.0.1:64201/...` 时，**服务端那条路是走不通的**——它的 `127.0.0.1` 是服务器自己，不是你的机器。

页面已经处理了这一点：**检测到「页面不在本机 + 目标也是本机地址」时，直接跳过服务端代理**，省掉一次必然失败的往返，也不会再给出「内网地址已被拦截」这种误导性报错。状态栏会提示「目标是你本机的地址，服务端访问不到，正在用浏览器直连…」。

```
# 你本机 64201 端口有个服务
https://json.litetools.top/?url=http%3A%2F%2F127.0.0.1%3A64201%2Finfo&app=literedis
```

剩下唯一的路径就是**浏览器直连**——这时请求从你本机发出，`127.0.0.1` 才真的是你的机器。但它受下面两条限制。

#### ⚠️ 浏览器差异：Safari 会拦截「HTTPS 页面 → http://」

这一点必须按浏览器区分，实测结论：

| 页面 | 目标 | Chrome / Edge | Safari |
|---|---|---|---|
| `https://` | `http://127.0.0.1` | ✅ 允许 | ❌ **被拦截** |
| `https://` | `http://localhost` | ✅ 允许 | ❌ **被拦截** |
| `http://` | `http://127.0.0.1` | ✅ 允许 | ✅ 允许 |

Safari 的控制台会明确写：

```
[blocked] The page at https://... requested insecure content from http://127.0.0.1:... .
          This content was blocked and must be served over HTTPS.
```

**Chrome 把 localhost / 127.0.0.1 视为可信来源，Safari 不认这个例外。** 所以：

- **用 Safari 时，`https://json.litetools.top/` 无法直连你本机的 http 服务**，怎么配 CORS 都没用。
- 要么改用 Chrome / Edge，要么按下面「本机运行」的方式走服务端代理。

#### 推荐：本机运行，让服务端自己取数据

如果这个工具和你的本地服务在**同一台机器**上，最省事的做法是本地起服务，让服务端直接取——**服务端到服务端不涉及 CORS，也不涉及混合内容**，浏览器是什么都无所谓：

```bash
# 放行本机地址（更收紧的写法：FETCH_ALLOW_HOSTS=127.0.0.1）
FETCH_ALLOW_PRIVATE=1 node server.js
```

然后访问：

```
http://localhost:3456/?url=http%3A%2F%2F127.0.0.1%3A64201%2Finfo%2Fxxx
```

这条路要求你的本地服务**什么都不用改**——不用加 `Access-Control-Allow-Origin`，不用处理 `OPTIONS`。

#### 走线上页面直连时，需要满足两个前提

1. **目标服务要允许跨域** —— 需要返回 `Access-Control-Allow-Origin`。浏览器直连受同源策略约束，没这个头就会被拦，**错误响应（401/405）也必须带**。
2. **浏览器允许混合内容** —— 见上表，Safari 不满足这一条。

> **`localhost` 和 `127.0.0.1` 在 CORS 眼里是两个不同的 origin。** 本地服务的 `Access-Control-Allow-Origin` 必须写你实际用来打开页面的那个，两个都要就写两条。

> 服务端返回「内网地址已被拦截」时，页面状态栏会先显示「正在用浏览器直连重试…」，这是正常的。

什么情况下**不会**重试直连：`url` 本身格式非法、重定向目标无效、内容超过 20MB、服务端令牌校验失败。这些属于输入或授权问题，重试也是一样的结果，所以直接报错。

### 接入规范：让自己的本地服务对接本页面

#### 先搞清楚：哪一项该配在哪一边

CORS 的原理是**被访问的那一方**决定允许谁来读它的数据。你的本地服务是「被读」的，所以跨域相关的配置全在它那边；这个页面只是「发起请求」的一方，不需要任何 CORS 配置。

| 配置项 | 配在哪 | 作用 |
|---|---|---|
| `Access-Control-Allow-Origin` | **你的本地服务** | 允许我们的页面读取数据。**所有响应都要带，包括 401 / 404 / 500** |
| `Vary: Origin` | **你的本地服务** | 白名单按来源动态返回时的缓存正确性 |
| 应用标识校验（可选） | **你的本地服务** | 识别调用方是否受信 |
| `OPTIONS` 预检处理 | **你的本地服务**（仅在用 `?token=` 时需要） | 用 `?app=` 时不触发预检，不用实现 |
| `FETCH_TOKEN` | 本页面服务端（启动参数） | 限定谁能调用 `/api/fetch` |

> ⚠️ **最容易踩的坑**：只给 200 响应加了 CORS 头，忘了给错误响应加。这样一来浏览器读不到 401 的响应体，只能报一个笼统的 `Load failed`（Safari）或 `Failed to fetch`（Chrome），完全看不出真正原因。

#### 应用标识（`?app=`）—— 只做「调用方标签」

页面 URL 上加 `app` 参数：

```
https://json.litetools.top/?url=http%3A%2F%2F127.0.0.1%3A64201%2Finfo&app=literedis
```

浏览器直连时，`app` 会被拼到目标地址后面（`http://127.0.0.1:64201/info?app=literedis`）；服务端代理抓取时，则以请求头 `X-Json-Pretty-App` 转发。你的服务可以据此识别调用方。

**为什么放在查询串而不是请求头**：自定义请求头会触发 CORS 预检（OPTIONS）。很多本地小服务没实现 OPTIONS，会直接返回 405，浏览器于是中止整个请求、连 GET 都不发出去。放进查询串就是「简单请求」，不触发预检——**你的服务只要回 `Access-Control-Allow-Origin` 就够了，不用处理 OPTIONS**。

> ⚠️ `app` **只是一个标签，不是密钥，也没有任何特权**。它不会放宽内网访问限制——内网放行范围只由服务端环境变量 `FETCH_ALLOW_HOSTS` / `FETCH_ALLOW_PRIVATE` 决定，不接受请求参数控制。
> 早期版本曾用 `?app=` 放行内网地址，那是个设计缺陷（谁知道这个值谁就能摸内网），已移除。

#### 访问令牌（`?token=`）—— 需要密钥时

页面 URL 上加 `token` 参数：

```
https://json.litetools.top/?url=http%3A%2F%2Flocalhost%3A3000%2Fsource%2Fxxx#token=你的密钥
```

| 去处 | 形式 | 作用 |
|---|---|---|
| 我们服务端的 `/api/fetch` | 请求头 `X-Json-Pretty-Token` | 只有持有密钥的调用方能用我们的抓取接口 |
| 你的本地服务 | 请求头 `X-Json-Pretty-Token` | 你的服务据此识别「这是受信任的调用方」 |

```bash
FETCH_TOKEN=你的密钥 node server.js
```

比较用定长比较（`crypto.timingSafeEqual`），不泄露时间信息。`app` 和 `token` 可以同时用，也可以只用其中一个。

**令牌放在 URL 片段里，不要放查询串：**

```
✅ https://json.litetools.top/?url=...&app=literedis#token=你的密钥
❌ https://json.litetools.top/?url=...&app=literedis&token=你的密钥
```

`#` 后面的片段**不会发送给服务器**，因此不会出现在 Nginx 访问日志里。查询串则会——默认的 `combined` 日志格式会记录完整 URI。两种写法页面都能读，但只有片段是安全的。

> 令牌是密钥，所以发往 `/api/fetch` 和你的服务时**都走请求头**（`X-Json-Pretty-Token`），不落到请求 URL 上。
> 代价是自定义请求头会触发 OPTIONS 预检，用 `token` 时你的服务**必须**处理 `OPTIONS` 并放行该头。**只用 `app` 则不需要**。
> 令牌不写 `localStorage`——密钥留在浏览器存储里只会增加暴露面，而且服务端换令牌后会导致莫名其妙的 401。

#### CORS 来源白名单（你的本地服务侧）

`Access-Control-Allow-Origin` 填的是**打开页面的那个地址的 origin**，不是你本地服务的地址——这是最容易搞反的一点。

格式是 `协议://主机:端口`，**不带路径、不带结尾斜杠**：

| 你用什么地址打开这个页面 | 就填什么 |
|---|---|
| `https://json.litetools.top/` | `https://json.litetools.top` |
| `http://localhost:3456/` | `http://localhost:3456` |
| `http://127.0.0.1:3456/` | `http://127.0.0.1:3456` |

必须**精确匹配**：实测多一个结尾斜杠（`http://localhost:3456/`）就会被浏览器拦掉。`localhost` 和 `127.0.0.1` 也是两个不同的 origin，用哪个就填哪个，两个都用就写两条。

推荐做法是**把请求头里的 `Origin` 原样返回**，配合白名单：

```js
const ALLOWED_ORIGINS = [
  'https://json.litetools.top',      // 线上
  'http://localhost:3456',           // 本地调试
  'http://127.0.0.1:3456'            // 本地调试（与上一行是不同的 origin）
];

const origin = req.headers.origin;
if (ALLOWED_ORIGINS.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');   // 按来源动态返回时必须加
}
```

写成 `*` 也能用，但意味着**你访问的任何网站**都能读你本地服务返回的内容。写成确切来源后，只有我们的页面能读——这一层由浏览器强制，比任何标识都更难绕过。

> 不确定该填什么？先在你的本地服务里把 `req.headers.origin` 打印出来，浏览器发过来的那个值就是要填的。

#### 你的本地服务需要实现的最小约定

**只用 `?app=` 时，请求是「简单请求」，不触发预检。你只需要一件事：所有响应都带上 `Access-Control-Allow-Origin`。**

```http
GET /info?app=literedis
Origin: http://localhost:3456
```

成功响应：

```http
200 OK
Content-Type: application/json
Access-Control-Allow-Origin: http://localhost:3456
Vary: Origin

{"a": 1, "b": [2, 3]}
```

失败响应 —— **同样要带 CORS 头**，否则浏览器读不到，页面只能显示 `Load failed`：

```http
401 Unauthorized
Content-Type: application/json
Access-Control-Allow-Origin: http://localhost:3456
Vary: Origin

{"error": "unauthorized"}
```

要点：

1. **`Access-Control-Allow-Origin` 要加在所有响应上**，包括 401 / 403 / 404 / 500。这是最常见的坑
2. **`Vary: Origin`** —— 白名单按来源动态返回时必须加，否则 CDN/代理可能把 A 来源的响应缓存给 B 来源
3. 来源不在白名单时，**不要返回任何 CORS 头**，让浏览器自己拒绝
4. **没有 `Origin` 头的请求说明不是浏览器**（比如服务端代理）—— 跳过 CORS 检查即可，响应里也不用带 CORS 头

**只有用 `?token=` 时**才需要额外处理 `OPTIONS` 预检（因为令牌走请求头）：

```http
OPTIONS /info
Origin: http://localhost:3456
Access-Control-Request-Method: GET
Access-Control-Request-Headers: x-json-pretty-token
```

```http
204 No Content
Access-Control-Allow-Origin: http://localhost:3456
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, X-Json-Pretty-Token
Vary: Origin
```

判定顺序：`OPTIONS` 预检（如有）→ Origin 白名单 → 应用标识校验。

#### 完整示例（可直接抄进你的本地服务）

下面这段**不需要实现 OPTIONS**，只要改 `ALLOWED_ORIGINS` 和 `APP` 即可用：

```js
const http = require('http');

const PORT = 64201;
const APP = 'literedis';

// ★ 填「打开页面的那个地址的 origin」：协议://主机:端口，不带路径、不带结尾斜杠。
//   localhost 和 127.0.0.1 是两个不同的 origin，用哪个写哪个。
const ALLOWED_ORIGINS = [
  'https://json.litetools.top',
  'http://localhost:3456',
  'http://127.0.0.1:3456'
];

http.createServer((req, res) => {
  const origin = req.headers.origin || null;
  // 有 Origin 说明是浏览器请求，必须在白名单；没有说明不是浏览器（如服务端代理），跳过
  const originAllowed = origin ? ALLOWED_ORIGINS.includes(origin) : true;

  // ★ 关键：所有响应都带 CORS 头，包括下面 403/401 的分支
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' };
  if (origin && originAllowed) headers['Access-Control-Allow-Origin'] = origin;

  // 1) 来源白名单（仅浏览器请求）
  if (origin && !originAllowed) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'origin not allowed' }));
    return;
  }

  // 2) 应用标识：浏览器直连时我们把它放在查询串里
  const app = new URL(req.url, 'http://localhost').searchParams.get('app') || '';
  if (app !== APP) {
    res.writeHead(401, headers);   // ← 注意这里也用了带 CORS 的 headers
    res.end(JSON.stringify({ error: 'app 标识不匹配' }));
    return;
  }

  // 3) 正常返回你的数据
  res.writeHead(200, headers);
  res.end(JSON.stringify({ a: 1, b: [2, 3] }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`literedis: http://127.0.0.1:${PORT}`);
});
```

**内容大小限制（20MB）**

链接返回的内容超过 **20MB** 就不下载：

- 响应带 `Content-Length` 时，拿到响应头就判断，超出立即掐断连接（实测 25MB 的资源 11ms 就返回错误，客户端只收到一个分片）。
- 分块传输没有 `Content-Length` 时，流式累加，一超过 20MB 立刻中断，不会把整个文件下完再判断。

页面会明确提示「内容过大，已停止下载」并给出实际大小和上限，输入框保持为空。这个 20MB 只作用于 `?url=` 抓取路径，本地粘贴内容的处理不受影响。

> 浏览器直连路径也有同样的 20MB 拦截，并且是先看 `Content-Length` 再决定是否下载。

### 访问内网接口

默认会拦截解析到内网 IP 的地址（防 SSRF）。本地或内网部署时按需放行：

```bash
# 只放行指定域名（推荐，支持 *.example.com 通配）
FETCH_ALLOW_HOSTS=api.rhino.datastory.com.cn npm start

# 放行全部内网地址（仅限本机/内网自用，切勿用于公网部署）
FETCH_ALLOW_PRIVATE=1 npm start
```

被拦截时页面状态栏会提示具体域名，照着填 `FETCH_ALLOW_HOSTS` 即可。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，反向代理场景建议设为 `127.0.0.1` |
| `FETCH_ALLOW_HOSTS` | 空 | 允许抓取的内网域名白名单，逗号分隔，支持 `*.example.com` |
| `FETCH_ALLOW_PRIVATE` | 空 | 设为 `1` 放行全部内网地址，仅限内网自用 |
| `FETCH_TOKEN` | 空 | 设置后 `/api/fetch` 必须带匹配的 `X-Json-Pretty-Token` 请求头 |
| `TRUST_PROXY` | 空 | 部署在 Nginx 后面时设为 `1`，从 `X-Forwarded-For` 取真实客户端 IP 用于限流 |

> `FETCH_ALLOW_HOSTS` 里的内网放行范围**只由这两个环境变量控制**，任何请求参数都无法放宽。

## 安全说明

### `/api/fetch` 的防护

这个接口本质上是一个「你让它抓什么它就抓什么」的代理，所以几层防护是必须的：

| 防护 | 做法 |
|---|---|
| SSRF | 解析域名后逐个检查所有 A/AAAA 记录，命中私有/保留网段即拒绝 |
| DNS 重绑定 | 解析结果会**钉死**在连接上（自定义 `lookup`），建立连接时不再重新解析 |
| 协议限制 | 只允许 `http` / `https`，其余协议直接拒绝 |
| 重定向 | 手动跟随，**每一跳都重新做一次地址校验** |
| 大小限制 | 20MB。带 `Content-Length` 的拿到响应头就掐断，分块传输的流式累加到上限即中断 |
| 超时 | 空闲 12s（每收到一块就重置）+ 总预算 60s |
| 并发 | 同时最多 8 个远端抓取，避免少量请求吃满内存 |
| 限流 | 每 IP 每分钟 60 次 |
| 鉴权 | 可选 `FETCH_TOKEN`，定长比较 |
| 只回传 JSON | 响应体不是 JSON 时**不把内容返回给调用方**，只回 `isJson: false`。这样它不能当通用爬虫代理用 |

内网判断覆盖的网段：

- IPv4：`0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.168/16`、`198.18/15`、`224/4` 及以上
- IPv6：`::`、`::1`、`fe80::/10`、`fc00::/7`、`ff00::/8`、`2001:db8::/32`
- **IPv4 映射地址**（`::ffff:127.0.0.1`、`::ffff:7f00:1`、`::ffff:192.168.1.1` 等）、IPv4 兼容地址、NAT64（`64:ff9b::/96`）—— 会取出内嵌的 IPv4 再判断

> 这一点曾经出过漏洞：WHATWG URL 解析器会把 `::ffff:127.0.0.1` 归一化成 `::ffff:7f00:1`，早期实现只认点分形式，导致这类地址能完全绕过内网拦截。现已改为解析成 8 个 16 位分组后按位掩码判断。

### 页面防护

- **CSP**：`default-src 'self'`，脚本、样式、Worker 全部同源，禁止内联与 `eval`。只有 `connect-src` 放开为 `*`——浏览器直连兜底需要请求用户指定的任意地址，这是功能本身决定的。
- **`X-Content-Type-Options: nosniff`**、**`Referrer-Policy: no-referrer`**、**`X-Frame-Options: DENY`**
- JSON 内容渲染全部走 `textContent` 或 `escapeHtml`，不拼接未转义的用户数据到 `innerHTML`

### 已知限制

- **不配 `FETCH_TOKEN` 时 `/api/fetch` 是开放接口**：任何知道地址的人都能让服务器去抓公网 JSON。防护只剩限流（每 IP 每分钟 60 次）和「只回传 JSON」。个人小站可以接受，流量和 IP 声誉敏感的场景建议开启令牌。
- 令牌、`url` 参数都会出现在**浏览器历史**里。分享链接前请自行判断。
- 输入框内容会存进 `localStorage`（草稿功能）。在公用电脑上用完记得清除。
- 开启 `FETCH_ALLOW_PRIVATE=1` 或 `FETCH_ALLOW_HOSTS=*` 后，内网拦截**完全失效**，启动时会打印警告。这类配置只适合内网自用。

## 部署到 Linux 服务器

### 架构

```
浏览器 ──HTTPS(443)──> Nginx ──HTTP(127.0.0.1:3456)──> Node 服务
```

Node 只监听本地回环地址，不直接暴露公网，外部访问一律经 Nginx 转发。

### 步骤

**1. 安装 Node.js**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

> 若用 nvm 装的 Node，注意它的实际路径可能在家目录（如 `/root/.nvm/...`），systemd 服务会因权限无法执行。`deploy.sh` 会自动检测并把二进制复制到 `/usr/local/bin`。

**2. 上传项目**

```bash
# 排除规则直接复用 .gitignore：系统文件、编辑器配置、本地记忆等都不会上传
rsync -avc --exclude-from=.gitignore ./ root@你的服务器:/opt/json-pretty/
```

**3. 运行部署脚本**

```bash
cd /opt/json-pretty && sudo ./deploy/deploy.sh
```

脚本会创建 `jsonpretty` 系统用户、复制文件、安装并启动 systemd 服务，最后做本机自检（含 `/api/fetch` 是否已挂载）。

**4. 配置 Nginx**

```bash
sudo apt install -y nginx
sudo cp /opt/json-pretty/deploy/nginx.conf /etc/nginx/conf.d/json-pretty.conf
sudo vim /etc/nginx/conf.d/json-pretty.conf      # 把 json.example.com 改成你的域名
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ `proxy_read_timeout` 必须大于抓取接口的总预算（服务端 60s，配置里已设 90s），否则 `?url=` 抓取大一点的链接会被 Nginx 提前掐断返回 504。

**5. 申请 HTTPS 证书**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

**6. 放行防火墙**

```bash
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

3456 端口**不要**对外开放，只留 80 / 443。

**7. 开启抓取接口令牌（公网部署强烈建议）**

不开的话 `/api/fetch` 就是一个开放代理，任何人都能拿你的服务器抓取任意地址、刷流量。

```bash
sudo mkdir -p /etc/json-pretty
printf 'FETCH_TOKEN=%s\n' "$(openssl rand -hex 32)" | sudo tee /etc/json-pretty/env
sudo chmod 600 /etc/json-pretty/env
sudo systemctl daemon-reload && sudo systemctl restart json-pretty
```

**令牌必须写在 `/etc/json-pretty/env`，不要直接写进 systemd 单元。** `deploy.sh` 每次安装都会用 `deploy/json-pretty.service` 重新生成单元文件，写在里面的内容会被覆盖——令牌一丢，接口就悄悄变回开放状态。

验证是否生效：

```bash
curl -s "http://127.0.0.1:3456/api/fetch?url=https%3A%2F%2Fexample.com%2F"
# 应返回 {"ok":false,"code":"unauthorized",...}

journalctl -u json-pretty -n 20 | grep 访问令牌
# 应显示「已启用」
```

之后页面链接需要带上令牌：

```
https://json.litetools.top/?url=...#token=你的令牌
```

### 需要抓取内网接口时

编辑 systemd 单元，解开 `FETCH_ALLOW_HOSTS` 那行：

```bash
sudo vim /etc/systemd/system/json-pretty.service
# Environment=FETCH_ALLOW_HOSTS=api.rhino.datastory.com.cn,*.corp.example.com
sudo systemctl daemon-reload && sudo systemctl restart json-pretty
```

> 注意这一项和令牌不同，它不敏感，可以直接写在单元里。但如果重新跑 `deploy.sh install`，这行也会被覆盖——长期使用建议也放到 `/etc/json-pretty/env` 里（`EnvironmentFile` 里的值优先生效）。

### 更新代码

```bash
# 本地：排除规则复用 .gitignore
rsync -avc --exclude-from=.gitignore ./ root@你的服务器:/opt/json-pretty/

# 服务器：改了 server.js 才需要重启；只改 HTML/CSS/JS 的话刷新即可
sudo systemctl restart json-pretty
```

`-c` 让 rsync 按内容校验和比较而非时间戳，能确保有差异的文件一定传上去。

也可以直接跑 `sudo /opt/json-pretty/deploy/deploy.sh update` 完成「复制文件 + 重启服务」。

### 运维命令

```bash
systemctl status json-pretty      # 查看状态
journalctl -u json-pretty -f      # 实时日志
systemctl restart json-pretty     # 重启服务
```

## 目录结构

```
server.js               主服务：静态文件 + /api/fetch 抓取代理
public/
  index.html            页面骨架
  app.js                交互逻辑（树渲染、搜索、全屏、?url= 加载）
  json-parser.js        宽松 JSON 解析器（主线程与 Worker 共用）
  parser-worker.js      解析 Worker（只负责把解析挪出主线程）
  styles.css            样式
  favicon.svg           站点图标
deploy/
  json-pretty.service   systemd 单元
  nginx.conf            Nginx 站点配置
  deploy.sh             部署脚本（install / update）
```

服务不落盘任何数据，整个文件系统以只读方式运行。

## License

This project is licensed under the Apache License 2.0.
See the [LICENSE](./LICENSE) file for details.
