# kojike

即刻（Jike）个人页圈子统计工具：统计当前浏览的用户在哪些圈子发过动态、各发了多少条。两个发行版共用同一套统计口径：

- **App 版**（[app/](app/)）—— LSPosed 模块，注入即刻 App，被动拦截个人页分页请求累计数据
- **Web 版**（[web/](web/)）—— 油猴脚本（单一事实来源）+ Chrome 扩展（由 `web/extension/build.mjs` 从脚本生成），作用于 [web.okjike.com](https://web.okjike.com)

## 构建

```bash
# App 版（输出 app/build/outputs/apk/debug/app-debug.apk）
./gradlew assembleDebug

# Web 版扩展 zip
cd web/extension && node build.mjs
```

## 发布

推送 `v*` 标签触发 GitHub Actions（[.github/workflows/release.yml](.github/workflows/release.yml)）自动构建 APK 与扩展 zip 并发布到 Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

版本号从 tag 注入构建（`moduleVersion` / `moduleVersionCode`），无需手改 gradle。

## 目录

| 目录 | 说明 |
|---|---|
| `app/` | LSPosed 模块（Kotlin，Xposed API） |
| `web/` | 油猴脚本 + Chrome 扩展，[web/README.md](web/README.md) |
| `local/` | 本地产物（逆向用 APK、验证截图、debug keystore），不入库 |
| `HANDOFF.md` | 开发进度交接记录 |
