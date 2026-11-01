# Chrome 扩展版

与油猴脚本同一套逻辑（单一事实来源：`build.mjs` 从 `../jike-circle-stats.user.js` 剥头生成 `content.js`），适合没装 Tampermonkey 的用户。

## 安装（开发者模式，无需上架商店）

1. 下载/拿到 `extension/` 目录（或 `jike-circle-stats-extension.zip` 解压）
2. Chrome 打开 `chrome://extensions` → 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」→ 选 `extension/` 目录
4. 打开 web.okjike.com，功能与油猴版完全一致（chip / 两级面板 / 图表 / 全量抓取）

> 注意：macOS 正式版 Google Chrome 156 起 `--load-extension` 命令行 flag 已被忽略
> （日志：`--load-extension is not allowed in Google Chrome, ignoring`），自动化测试请用
> Chrome for Testing（`--load-extension` 在 CfT 上仍有效），人工使用走上面的 UI 加载。

## 技术要点

- MV3 `content_scripts` 用 `"world": "MAIN"`（Chrome 111+）直接跑在页面上下文，能 wrap 页面的
  `XMLHttpRequest`/`fetch`——不需要 inline 注入 hack，也不需要任何额外权限
- 权限面：仅 `matches: https://web.okjike.com/*`，无 host_permissions、无 storage（沿用页面
  localStorage 存数据），与油猴版行为一致
- `content.js` 是生成物（头部有 `! Generated` 标记），**不要手改**；改油猴脚本后跑 `node build.mjs`
  重新生成，manifest 版本号也会自动同步

## 开发

```bash
cd web/extension
node build.mjs          # 重新生成 content.js + 同步 manifest 版本
# chrome://extensions 里点扩展卡片上的「重新加载」即可看到改动
```
