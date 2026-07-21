# 本地一键 Release

项目不使用 GitHub Actions 生成安装包。发布脚本在原生宿主上构建对应平台产物，避免
每次从空 runner 冷启动，同时复用 npm、Cargo、Gradle、Android NDK 和 Xcode 缓存。

## 主机职责

| 主机 | 默认 Release 产物 | 不负责 |
|---|---|---|
| Windows | portable MSI、Android arm64 APK | DMG、IPA；Google Play AAB 需显式选择 |
| macOS | DMG、App Store Connect IPA | Android、MSI |

Linux 不是当前发布宿主；脚本会明确拒绝其他系统，而不是生成未经验证的交叉编译产物。

## 使用

```bash
git submodule update --init --recursive
npm run release:local
```

默认流程依次完成：

1. 检查 Git submodule 是否与主仓库指针一致；
2. 仅在 `package-lock.json` 改变或 `node_modules` 缺失时执行干净依赖安装；
3. 运行主项目测试、TypeScript 类型检查、nkg-ai-flow 全量测试、browser bundle
   边界、内置 Flow 审计和 Rust 测试；
4. 根据宿主执行 Release 构建；
5. 将产物复制到 `artifacts/releases/<版本>/<平台-时间>/`；
6. 生成包含 commit、产物体积和 SHA-256 的 `manifest.json`。

常用选项：

```bash
# 只显示计划，不执行安装、测试或构建
npm run release:local -- --dry-run

# lockfile 没变也强制重新安装依赖
npm run release:local -- --install

# 已经完成同一提交的完整验收后，快速重新打包
npm run release:local -- --skip-install --skip-tests

# 准备上传 Google Play 时额外生成 AAB
npm run release:local -- --android-aab
```

仅开发、安装流程联调与最终 Windows 交付可分别使用：

```powershell
# 桌面开发：Vite 热更新 + Rust debug 增量编译
npm run tauri -- dev

# 本地快速 MSI：关闭 LTO、16 个 codegen unit、开启 release 增量编译
npm run tauri:msi:fast

# 最终 Windows MSI：thin LTO、8 个 codegen unit、strip symbols、panic=abort
npm run tauri -- build
```

`tauri:msi:fast` 只放宽 Rust release 优化参数，不会切换 `desktop-power`，产物仍不包含
Node sidecar。它使用独立的 `apps/client/src-tauri/target/fast-msi` 缓存，避免与正式 thin-LTO
构建互相使缓存失效；代价是首次构建较慢并额外占用磁盘。它适合频繁验证安装器，不应
替代最终交付命令。

## Windows 前置条件

- Node.js 20.11 或更高版本；
- Rust stable 与 MSVC C++ Build Tools；
- Android Studio 的 JBR、Android SDK 36、Build Tools 36 和 NDK；
- Tauri 的 Windows/WebView2 构建依赖。

Windows 默认脚本构建纯 portable MSI，不生成或打包 Node sidecar；Android 产物同样
使用 portable Runtime。需要 `desktop-power` 时另行执行 `npm run build:desktop-power`
和 `npm run tauri:desktop-power`。Release APK 继续执行 40 MiB 体积门禁。
AAB 不能直接安装，只在传入 `--android-aab` 准备 Google Play 上传包时生成。

在没有既有 NKG AI Bot 安装的干净 Windows 用户环境中，可对最新安装器执行真实
安装、启动 8 秒和卸载 smoke：

```powershell
npm run smoke:windows-installer -- "artifacts/releases/<版本>/<目录>/windows-*.msi"
```

脚本会拒绝覆盖已有安装，通过 Windows Installer 静默安装、启动后卸载，并恢复应用
自身可能写入的历史注册表配置。MSI 是 per-machine 安装包，执行 smoke 的终端需要管理员权限。

## macOS 前置条件

- Node.js 20.11 或更高版本；
- Rust stable；
- 完整 Xcode 与 Command Line Tools；
- Apple Developer 账号、`com.nkg.ai.bot` App ID、有效签名证书与 provisioning profile；
- 在 Xcode Settings > Accounts 登录对应账号并启用自动签名。

macOS 脚本只构建 DMG 和 iOS IPA，不要求安装 Android Studio。IPA 使用
`app-store-connect` export method，预期输出位于 Tauri Apple build 目录，随后由脚本
统一归档。

DMG 对外分发还需要 Developer ID 签名与 notarization；IPA 需要 Apple Distribution
签名。脚本不会保存、上传或打印证书、密码、API Key 等签名凭据。

## 缓存与性能

脚本不会删除以下缓存：

- `node_modules` 与 npm 下载缓存；
- `apps/client/src-tauri/target`；
- Cargo registry/git cache；
- Gradle cache、Android NDK 编译缓存；
- Xcode DerivedData。

因此首次构建仍然较慢，后续相同工具链与依赖图的 Release 构建会显著加快。构建失败
会立即停止，已有缓存和成功产物不会被清空。

Cargo 并发数默认取宿主系统报告的可用并行度；如需限制内存占用，可在运行前显式设置
`CARGO_BUILD_JOBS`，构建脚本会保留该覆盖值。

项目当前不强制配置第三方链接器或编译缓存。若团队后续安装 `sccache`，可在 CI 或开发机
显式设置 `RUSTC_WRAPPER=sccache`；切换链接器会产生新的 Cargo 编译指纹，首次构建不会更快，
应先在目标 Windows 工具链上验证告警、签名与安装包兼容性。
