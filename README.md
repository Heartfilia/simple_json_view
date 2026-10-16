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

`?url=` 的地址是**服务端**去访问的，所以服务端的 `localhost` 是服务器自己，不是你的电脑——直接写 `localhost` 必然被 SSRF 防护拦截，这是应该的。

遇到这种情况，页面会**自动退回浏览器直连**：这时请求从你本机发出，`localhost` 就真的是你的机器了。

```
# 你本机 64201 端口有个服务
https://json.litetools.top/?url=http%3A%2F%2F127.0.0.1%3A64201%2Finfo&app=literedis
```

前提（两个都要满足）：

1. **目标服务要允许跨域** —— 需要返回 `Access-Control-Allow-Origin` 响应头。浏览器直连受同源策略约束，没这个头就会被拦。
2. **`http://localhost` 和 `http://127.0.0.1` 都不受混合内容拦截** —— HTTPS 页面访问它们是允许的（浏览器把这两个视为可信来源，已实测验证）。**换成公网 http 域名则会被混合内容策略拦掉。**

> **`localhost` 和 `127.0.0.1` 在 CORS 眼里是两个不同的 origin。** 本地服务的 `Access-Control-Allow-Origin` 必须写你实际用来打开页面的那个，两个都要就写两条。

> 服务端返回「内网地址已被拦截」时，页面状态栏会先显示「正在用浏览器直连重试…」，这是正常的。

什么情况下**不会**重试直连：`url` 本身格式非法、重定向目标无效、内容超过 20MB、服务端令牌校验失败。这些属于输入或授权问题，重试也是一样的结果，所以直接报错。

### 接入规范：让「受信任的本地软件」对接线上页面

#### 应用标识（`?app=`）—— 不用密钥的轻量方案

页面 URL 上加 `app` 参数：

```
https://json.litetools.top/?url=http%3A%2F%2F127.0.0.1%3A64201%2Finfo&app=literedis
```

这一个标识会用在两个地方：

| 去处 | 形式 | 作用 |
|---|---|---|
| 我们服务端的 `/api/fetch` | 查询参数 `?app=` | 匹配 `FETCH_LOCAL_APP` 时，**本次请求**放行内网地址 |
| 你的本地服务 | 请求头 `X-Json-Pretty-App` | 你的服务据此识别「这是受信任的调用方」 |

**服务端启用方式**：

```bash
FETCH_LOCAL_APP=literedis node server.js
```

不设置则 `?app=` 不产生任何放行效果（默认行为不变）。

**它解决什么问题**：当你的工具和本地服务跑在**同一台机器**上时，服务端自己就能访问 `127.0.0.1:64201`，比绕一圈浏览器直连更快。这时用 `?app=literedis` 打开通这一条路，而不必全局打开 `FETCH_ALLOW_PRIVATE=1`。

> ⚠️ `app` 标识**不是密钥**，只是一个应用名，用来把「允许摸内网」限定给特定场景。知道这个值的任何人都能让服务端去访问内网地址（主要是服务器自己的 localhost）。
> 如果你的页面部署在公网且在意这一点，请改用下面的访问令牌，或者干脆不配 `FETCH_LOCAL_APP`——浏览器直连那条路径本来就能到你的机器，不需要这个开关。

#### 访问令牌（`?token=`）—— 需要密钥时

页面 URL 上加 `token` 参数：

```
https://json.litetools.top/?url=http%3A%2F%2Flocalhost%3A3000%2Fsource%2Fxxx&token=你的密钥
```

| 去处 | 形式 | 作用 |
|---|---|---|
| 我们服务端的 `/api/fetch` | 查询参数 `?token=` | 只有持有密钥的调用方能用我们的抓取接口 |
| 你的本地服务 | 请求头 `X-Json-Pretty-Token` | 你的服务据此识别「这是受信任的调用方」 |

```bash
FETCH_TOKEN=你的密钥 node server.js
```

比较用定长比较，不泄露时间信息。`app` 和 `token` 可以同时用，也可以只用其中一个。

#### 为什么标识走请求头而不是拼进 URL

请求头不会写进访问日志，也不会在目标服务发生重定向时泄露给下一个地址。

> 自定义请求头会让跨域请求产生一次 OPTIONS 预检，所以你的服务**必须**处理 `OPTIONS` 并在响应里放行对应的头，否则带头请求根本发不出去。这是最常见的踩坑点。

#### CORS 来源白名单（你的本地服务侧）

强烈建议把 `Access-Control-Allow-Origin` 写成**确切的来源**而不是 `*`：

```js
const ALLOWED_ORIGINS = [
  'https://json.litetools.top',      // 线上
  'http://localhost:3456',           // 本地调试
  'http://127.0.0.1:3456'            // 本地调试（与上一行是不同的 origin）
];
```

写成 `*` 意味着**你访问的任何网站**都能读你本地服务返回的内容。写成确切来源后，只有我们的页面能读——这一层由浏览器强制，比任何标识都更难绕过。

写成 `*` 意味着**任何网站**都能读你本地服务返回的内容。写成确切来源后，只有我们的页面能读——这一层由浏览器强制，比令牌更难绕过。

#### 你的本地服务需要实现的最小约定

```http
OPTIONS /info
Origin: https://json.litetools.top
Access-Control-Request-Method: GET
Access-Control-Request-Headers: x-json-pretty-app
```

响应（预检必须放行自定义头，否则后续请求发不出去）：

```http
204 No Content
Access-Control-Allow-Origin: https://json.litetools.top
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, X-Json-Pretty-App, X-Json-Pretty-Token
Vary: Origin
```

```http
GET /info
Origin: https://json.litetools.top
X-Json-Pretty-App: literedis
```

响应：

```http
200 OK
Content-Type: application/json
Access-Control-Allow-Origin: https://json.litetools.top

{"a": 1, "b": [2, 3]}
```

要点：

1. **`OPTIONS` 返回 204，不要 200 带 body**
2. **`Access-Control-Allow-Headers` 必须包含你用到的自定义头**（`X-Json-Pretty-App` 或 `X-Json-Pretty-Token`），漏了对应请求会被浏览器直接掐断
3. **`Vary: Origin`** —— 白名单按来源动态返回时必须加，否则 CDN/代理可能把 A 来源的响应缓存给 B 来源
4. 来源不在白名单时，**不要返回任何 CORS 头**，让浏览器自己拒绝
5. **没有 `Origin` 头的请求说明不是浏览器**（比如服务端代理）—— 跳过 CORS 检查，只校验应用标识即可，响应里也不用带 CORS 头

判定顺序建议：先处理 `OPTIONS` 预检 → 再校验 Origin 白名单 → 最后校验应用标识。反过来会在服务端代理场景下误拒。

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
| `FETCH_LOCAL_APP` | 空 | 应用标识。请求带 `?app=<此值>` 时，**该次请求**放行内网地址 |
| `FETCH_TOKEN` | 空 | 设置后 `/api/fetch` 必须带匹配的 `?token=`，用于限定受信任的调用方 |

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

### 需要抓取内网接口时

编辑 systemd 单元，解开 `FETCH_ALLOW_HOSTS` 那行：

```bash
sudo vim /etc/systemd/system/json-pretty.service
# Environment=FETCH_ALLOW_HOSTS=api.rhino.datastory.com.cn,*.corp.example.com
sudo systemctl daemon-reload && sudo systemctl restart json-pretty
```

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
