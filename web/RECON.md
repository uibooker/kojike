# web.okjike.com 网页端侦察笔记（2026-10-31）

> 方法：无需登录，直接下载公开 SPA bundle 静态分析（bundle 留在 `recon/`，已 gitignore）。
> 样本：`index-COQcR2LR.js`（sha256 前 16 位 `fa5fe191312d2779`）、`vendor-CdbGy5Mg.js`（`d08f7cc67113c16c`）、`index.html`（`267e82704717481a`）。
> 正式 Chrome 默认 profile 禁用 CDP（9222 端口 404），但本侦察不依赖 CDP。

## 1. 数据端点（与 App 版同源同构）

- 个人页动态流：`POST https://api.ruguoapp.com/1.0/personalUpdate/single`
  - body：`{ limit: 20, loadMoreKey, username }`（`loadMoreKey` 首页传 `undefined`）
  - 响应顶层：`{ data: TypeNeo[], loadMoreKey }`——与 App 版 `TypeNeoListResponse` 一致
  - bundle 证据（index.js 41735 附近）：`queryFn: ({pageParam:e}) => J(Gr, {limit:20, loadMoreKey:e, username:t}).then(n=>n.data).then(n=>(Kn(n.data), {data:n.data.map(s=>s.id), loadMoreKey:n.loadMoreKey}))`
- 登录用户：`GET /1.0/users/profile`（bundle 内 `Va`），响应 `.data.user`
- 其它相关端点全表见 index.js `/1.0/` 字面量（personalUpdate/followingUpdates、recommendFeed/list、users/topics/search 等）

## 2. 鉴权（token/刷新全部宿主自理）

- localStorage 键：`JK_ACCESS_TOKEN`、`JK_REFRESH_TOKEN`、`JK_DEVICE_ID`（bundle 内 `Ku` class，getter/setter 直读直写）
- 请求头（axios 请求拦截器 `mN`，index.js 414434 附近）：
  - `x-jike-access-token: <JK_ACCESS_TOKEN>`
  - `x-jike-device-id: <JK_DEVICE_ID>`（有才带）
  - `platform: web`
- 401 / `E101` → 用 `JK_REFRESH_TOKEN` POST 刷新后自动重试；`E202` → 服务端弹窗
- 结论：脚本若用页面自身的 axios 实例则完全不用管 token；若自己发请求，读 localStorage 三键 + 上述头即可，401 时引导用户刷新页面

## 3. 传输层与拦截方案

- axios 实例 `Lr = axios.create({withCredentials: true, baseURL: "https://api.ruguoapp.com"})`，未指定 adapter → 走默认 **XMLHttpRequest**
- 拦截被动流量：wrap `XMLHttpRequest.prototype.open/send`（同时 wrap `window.fetch` 作冗余），读 `responseText` 按 `loadMoreKey`/body 内容判别 `/1.0/personalUpdate/single`
- 脚本需运行在页面上下文（`unsafeWindow` 或 MAIN world）才能看到宿主 XHR

## 4. 路由（TanStack Router，bundle 内完整路由表）

- 个人主页：`/u/$username`（URL 里的值就是接口 `username` 参数，无需换算）
  - tab：动态 `/u/$username/`、相册 `/gallery`、收藏 `/collection`（仅本人）、我的圈子 `/topic`（仅本人）
- 动态详情：`/u/$username/post/$id`（ORIGINAL_POST）、`/u/$username/repost/$id`（REPOST）—— bundle 内 `De={ORIGINAL_POST:"post",REPOST:"repost",PERSONAL_UPDATE:"post"}`
- 登录页会带 `redirectURL` 回跳；未登录访问任何页都重定向 `/login`

## 5. 响应模型要点（与 App 版第 3.2 节对应）

- 列表元素：`type`（"ORIGINAL_POST"/"REPOST"/…）、`id`、`content`、`user.username`、`topic`（纯文字/纯转发为 null）
- REPOST 原动态在 `target` 字段（App 版：`target.topic` 兜底归类）
- 单作者判别直接平移 App 版 GsonResponseHook：对 `data` 内所有 `user.username` 去重，多作者整页跳过（发现页 `/1.0/recommendFeed/list` 等共用响应结构，防污染）

## 6. 开发用隔离 Chrome

- 已启动：`web/recon/chrome-profile`（独立 profile，未登录），CDP `http://127.0.0.1:9333`
- 启动命令（沙箱内需 --no-sandbox --disable-gpu）：
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=<profile> --remote-debugging-port=9333 --no-first-run --no-default-browser-check --disable-gpu --no-sandbox --crash-dumps-dir=<recon> "https://web.okjike.com"`
- 用途：脚本开发期装 Tampermonkey 或直接以 CDP 注入脚本验证；**用户正式验证用自己的 Chrome + 油猴**
- `web/recon/` 已加入 .gitignore（bundle 与 profile 不入库）

## 7. 实机验证结论（隔离 Chrome + CDP，2026-10-31）

- 隔离实例登录后，全程用 `recon/cdp.mjs`（自写 CDP 助手：`node cdp.mjs eval/nav/pages`）驱动验证
- XHR wrap 在 document-start 后注入同样生效（脚本注入晚于首批请求时，下一页分页请求即被捕获，无遗漏风险——SPA 后续全走同一 XHR 栈）
- 被动统计：滚 2 屏 → 40 条入库；分桶按 username 隔离（自己 40 条 vs 另一用户 40 条，互不串扰）
- 三级链路全通：chip → 面板圈子列表 → 圈子明细卡片 → `/u/<username>/post/<id>` 宿主详情页
- 验证中发现并修复：① 面板 rows 数组未 join('')，行间渲染出游离逗号；② 明细卡片跳转 id 为 undefined（id 在 byId 的 key 上，未摊平进 post 对象）
- 详情页等非个人页 chip 自动隐藏（符合预期）

## 8. 残余未知

- 全量抓取的限速阈值未实测（沿用 App 版 400–800ms/页，首跑再调）
- `E202`（风控弹窗）在网页端的具体触发条件未实测
- 页面 DOM 注入锚点需在登录后的真实页面上确认（隔离实例未登录，看不到个人页结构）
