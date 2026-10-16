# 只做一件事

## 那就是 干净，简单，易用


[快捷使用_QuickUse](https://json.litetools.top)


### 部分操作在右键，页面保留的按钮是方便手机端的

当前功能已经足够日常使用了

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
- 出于安全考虑，`/api/fetch` 只允许 http/https，默认禁止访问内网地址，超时 12 秒，响应上限 5MB。

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

> ⚠️ `proxy_read_timeout` 必须大于抓取接口的 12 秒超时（配置里已设 30s），否则 `?url=` 抓取会被 Nginx 提前掐断返回 504。

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
