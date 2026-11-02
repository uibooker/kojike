# kojike web —— 即刻网页版圈子统计

在 [web.okjike.com](https://web.okjike.com) 个人页统计「当前浏览的用户在哪些圈子发过动态、各发了多少条」。与 App 版 LSPosed 模块（`app/`）同一需求、同一套统计口径，网页端形态。

**两个发行版，同一套逻辑**（油猴脚本是单一事实来源，扩展由它构建）：

- **油猴脚本** `jike-circle-stats.user.js` —— 装过 Tampermonkey 的用户
- **Chrome 扩展** `extension/` —— 没装油猴的用户，MV3 MAIN world，见 `extension/README.md`

## 安装（自己的 Chrome）

1. 装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. Tampermonkey 管理面板 → 新建脚本 → 粘贴 `jike-circle-stats.user.js` 全文 → 保存（或直接把文件拖进浏览器装）
3. 打开/刷新 web.okjike.com，进任意用户（或自己）的个人主页

## 使用

- 右下角出现「📊 圈子统计 · N」悬浮 chip，N = 该用户已入库动态数
- **上下滚动动态流**，脚本被动拦截页面自己的分页请求累计数据（只算加载过的，与 App 版一致），数据存 localStorage，跨会话累计
- 点 chip 开面板：一级圈子列表（按条数降序）→ 点行进二级动态明细 → 点卡片跳宿主动态详情
- 点列表头部的 📈 进图表视图，下拉切换 **饼图 / 柱状图 / 折线图**（选择记忆在 localStorage）：
  - 饼图（环形）：中心显示总条数，图例带百分比，top8 + 其他
  - 柱状图：top10 + 其他，条形长度按占比
  - 折线图：按月聚合最近 12 个月，画动态数 top5 的圈子（数据点悬停看「圈子 年-月 · N条」）
  - 饼图扇区/图例、柱状图行可点击，直接跳进该圈子的动态明细
- 点 header 的「**全量**」自动翻页抓取该用户**全部动态**（无需滚动）：
  - 复用登录态 fetch，`loadMoreKey` 游标翻页，每页 25 条（服务端实测上限）
  - 限速 400–800ms/页 + 429/403 中止 + 连续失败 3 次退避中止 + 600 页硬上限
  - 抓取中 header 行内显示「N 条…」，SPA 路由切走立即中止；单用户入库上限 3000 条（更早的动态提示未入库）
  - 实测：32000+ 粉丝高产用户 3000 条（2020-11 → 2026-10）约 100 秒抓完
- 「清空」只清当前浏览用户的桶；chip 在详情页等非个人页自动隐藏

## 文件

| 文件 | 说明 |
|---|---|
| `jike-circle-stats.user.js` | 脚本本体（单一事实来源，统计/图表/抓取逻辑只在这里维护） |
| `extension/` | Chrome 扩展版（MV3，`build.mjs` 从油猴脚本生成，见 `extension/README.md`） |
| `RECON.md` | 网页端侦察笔记：端点、鉴权、路由、响应模型、实机验证结论 |
| `recon/` | 侦察工作区（bundle 快照、CDP 助手 `cdp.mjs`、隔离 Chrome profile），已 gitignore |

## 验证状态（2026-10-31，隔离 Chrome + CDP 实测）

- [x] 被动拦截 `POST /1.0/personalUpdate/single` 并入库（滚 2 屏 = 40 条）
- [x] 单作者判别：个人页接口正常入库；多作者整页跳过（防发现页等 feed 污染，逻辑平移自 App 版）
- [x] 按浏览对象分桶隔离（用户 A 40 条 / 用户 B 40 条，互不串扰）
- [x] 两级面板 + 明细卡片跳宿主详情（`/u/<username>/post/<id>`）
- [x] SPA 路由切换 chip/面板自动跟随；非个人页 chip 隐藏
- [x] 图表视图（饼/柱/折线下拉切换，手写 SVG 零依赖）：渲染、切换记忆、点击下钻均实测通过
- [x] 全量抓取：实测 3000 条（触库上限即停）、限速正常、SPA 中止正常、错误提示正常
- [x] 样式对齐宿主（v0.4）：圈子行 TopicTagLayout 同款胶囊 + 蓝点 + 计数徽章，「无圈子」灰蓝圆标
- [x] 年度统计（v0.5）：年度堆叠柱（top4 圈子 + 其他 + 无圈子）+ 覆盖跨度汇总行，点柱下钻该年明细；v0.5.1 起「按年」独立为「统计维度」下拉（按圈子/按年），不再混在图表类型下拉里
- [x] Chrome 扩展版（v0.4.0）：Chrome for Testing 156 实测 MAIN world 注入、滚动捕获、面板、图表全通
- [ ] 正式 Chrome + Tampermonkey 人工复验

## 与 App 版的对应

| App 版（LSPosed） | Web 版（本脚本） |
|---|---|
| hook `Gson.fromJson` 拦响应 | wrap `XMLHttpRequest`（axios 默认 adapter），fetch 兜底 |
| `TopicStatsStore` 内存分桶 | localStorage 分桶（跨会话持久化，LRU 30 用户） |
| 真 tab 插页 / 悬浮 chip 降级 | 悬浮 chip + 浮层面板 |
| 宿主 TopicTagLayout 胶囊样式 | 同款 CSS 胶囊（灰底/蓝点/蓝字/徽章，无圈子灰蓝圆标）|
| `FetchEngine` 反射复用宿主网络栈全量抓取 | 直接 fetch 同源 API + 同款限速/退避/fail-closed |
| 进程存活期数据 | localStorage 持久化 |
