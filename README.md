# nkg-ai-bot

纯客户端、用户自备模型 API 配置的跨平台 AI 聊天与助理应用。

项目使用 `nkg-ai-flow` 作为 Git submodule。Windows、macOS、Android、iOS 默认
执行同一套不依赖 Node 的 portable Runtime；桌面 Node sidecar 仅作为用户显式开启的
`desktop-power` 模式。上层通过统一协议路由调用两种宿主。

## 当前进度

- `packages/runtime-router`：平台路由、sidecar backend、portable backend、
  Flow HTTP 客户端与 SSE 解析；
- `packages/tauri-runtime-adapter`：Tauri command 到 sidecar 生命周期的适配，
  Web Worker Runtime client、原生能力/流式 fetch broker、SQLite Run 历史与保留策略；
- `apps/runtime-sidecar`：可打包为自包含桌面二进制的 Node Runtime；
- `apps/client`：Tauri 2 + React 客户端、Rust sidecar 生命周期、本地 SQLite
  schema、Provider/API Key 设置页、Stronghold vault、移动原生 HTTP adapter 与
  Android 原生工程；启动/恢复时会把 SQLite Flow 目录同步到当前 Runtime，移动端
  挂起会取消活动 run 并中止流式请求；内置日常聊天同样通过 Flow 执行，消息仅写入
  本地 SQLite；
- `nkg-ai-flow`：固定版本的上游子模块；
- `docs/architecture/runtime-routing.md`：路由设计、安全约束和下一阶段。
- `scripts/local-release.mjs`：按本机系统执行完整 Release；Windows 默认产出 NSIS 与
  Android APK，macOS 产出 DMG 与 App Store Connect IPA。Google Play AAB 按需生成；发布过程不依赖
  GitHub Actions，并复用本机 npm、Cargo、Gradle 与 Xcode 缓存。

## 开发

```powershell
git submodule update --init --recursive
npm install
npm run typecheck
npm test
npm run rust:check
npm run build:client
```

## 一键本地 Release

准备好当前系统原生工具链后，在仓库根目录执行：

```bash
npm run release:local
```

脚本自动判断宿主系统，并执行完整测试、类型检查和 Release 构建：

| 宿主 | 产物 |
|---|---|
| Windows | NSIS `.exe`、Android arm64 `.apk`；可选 Google Play `.aab` |
| macOS | macOS `.dmg`、iOS App Store Connect `.ipa` |

所有产物会复制到 `artifacts/releases/<版本>/<平台-时间>/`，同目录的
`manifest.json` 记录 Git commit、体积和 SHA-256。脚本不会清理 Cargo/Gradle/Xcode
缓存；仅当 `package-lock.json` 变化时才重新执行 `npm ci`。

首次在 macOS 生成 IPA 前，需要在 Xcode 登录 Apple Developer 账号，并为
`com.nkg.ai.bot` 配置自动签名。仅检查构建计划或快速重打包可执行：

```bash
npm run release:local:plan
npm run release:local:quick

# 仅在准备上传 Google Play 时增加 AAB
npm run release:local -- --android-aab
```

完整参数与前置条件见 [`docs/local-release.md`](docs/local-release.md)。

`build:client` 默认只构建 portable 前端，不生成 Node sidecar。Android/iOS 同样不会
生成或携带桌面 Node 二进制。只有显式 `desktop-power` 构建才会准备 sidecar：

```powershell
npm run build:desktop-power
npm run tauri:desktop-power
npm run test:e2e -w @nkg-ai-bot/runtime-sidecar
```

Windows 首次运行 Rust/Tauri 脚本时会从 libsodium 官方 HTTPS 地址下载固定版本、
校验固定 SHA-256 后放入用户构建缓存；不会写入应用数据目录或仓库。

Android 工具链准备好后可执行：

```powershell
npm run android:init
npm run android:build -- --target aarch64
```

Android 默认构建 Release APK，并执行 40 MiB 体积门禁；显式调试构建使用
`npm run android:build:debug -- --target aarch64`。同时生成商店 AAB 时追加 `--aab`。
当前 arm64 实测基线约为 14.40 MiB APK；AAB 仅在准备上传 Google Play 时按需生成，
不是默认 Release 产物。移动 Cargo
依赖图和生成的 Gradle 工程均不包含桌面 Shell/sidecar 模块。

macOS/Xcode 环境中的 iOS 工程入口为：

```bash
npm run ios:init
npm run ios:build
```

iOS 默认构建 Release；调试构建使用 `npm run ios:build:debug`。

Android Emulator 的可重复流式网络门禁：在一个终端启动仓库内的 OpenAI-compatible
测试服务，确认 Debug APK 已安装并启动后，在另一个终端运行 WebView E2E（默认测试
端口为 `18080`）：

```powershell
npm run android:build:debug -- --target x86_64
$env:NKG_MOCK_PORT = "18080"
npm run mock:provider
npm run android:e2e:chat
```

要验证真实 APK 在生成中切到后台的取消与恢复，可让 mock Provider 每 2 秒发送一个
分块，并运行生命周期门禁：

```powershell
$env:NKG_MOCK_PORT = "18080"
$env:NKG_MOCK_CHUNK_DELAY_MS = "2000"
npm run mock:provider
npm run android:e2e:lifecycle
```

该门禁会在收到首个文本分块后发送 Android HOME：要求生命周期日志严格出现
`suspending → suspended → resuming → active`，半截助手回复不进入 SQLite，界面显示
正常停止提示，并在恢复后重新完成一次聊天。

E2E 脚本会自动发现 Android SDK 的 `adb`，为当前应用 WebView 建立 DevTools 转发，
并把测试 Provider 的 loopback 端口反向映射到宿主机；它只创建/更新名为 `NKG E2E`
的测试 profile，不覆盖其他 Provider。

Windows Android 构建脚本会自动发现 Android Studio JBR、SDK 和最新的 side-by-side
NDK，并为目标 ABI 缓存经过 SHA-256 校验的 Zig/libsodium 构建产物。它使用文件复制
装配 JNI 库，因此未开启 Windows“开发人员模式”时也能生成 APK。其他 ABI 可把
target 改成 `armv7`、`i686` 或 `x86_64`，每条命令只构建一个 ABI。

本地 Android 设备门禁使用项目专用 `NkgAiBot_API_36_1` AVD。Android 16 x86_64
Emulator 已验证应用启动、Worker Runtime、SQLite Flow 目录同步、HOME/恢复生命周期、
Stronghold 解锁、Provider profile + API Key 分离保存，以及自定义 HTTP Provider 的
OpenAI-compatible SSE 流式响应。Worker fetch broker 会逐块转发并把取消传播到原生
HTTP；真机外部网络仍需在实际设备上复核。

当前测试只扫描本项目 `packages/`，上游子模块保持自己的依赖、测试配置和
发布节奏。

当前验证基线：本项目 137 项测试、默认 Rust 3 项测试、SQLite migration、Windows
NSIS 安装/启动/卸载 smoke、Android arm64 Release APK、Android Emulator 流式聊天与
前后台恢复通过；子模块 757 项测试、类型检查和 browser bundle Node builtin 门禁通过。
Windows portable 安装器约 4.13 MiB，Android arm64 APK 约 14.40 MiB。macOS DMG、
iOS IPA/真机与 Android 物理真机仍需在对应真实设备和签名环境验收。
