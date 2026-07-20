# nkg-ai-bot

纯客户端、用户自备模型 API 配置的跨平台 AI 聊天与助理应用。

项目使用 `nkg-ai-flow` 作为 Git submodule。桌面端通过本地 Node
sidecar 执行 Flow，Android/iOS 使用不依赖 Node 的进程内 Runtime；上层
通过统一协议路由调用两种宿主。

## 当前进度

- `packages/runtime-router`：平台路由、sidecar backend、进程内 backend、
  Flow HTTP 客户端与 SSE 解析；
- `packages/tauri-runtime-adapter`：Tauri command 到 sidecar 生命周期的适配，
  应用级 Runtime 组合入口，以及真实 `nkg-ai-flow` 移动 handler；
- `apps/runtime-sidecar`：可打包为自包含桌面二进制的 Node Runtime；
- `apps/client`：Tauri 2 + React 客户端、Rust sidecar 生命周期、本地 SQLite
  schema、Provider/API Key 设置页、Stronghold vault、移动原生 HTTP adapter 与
  Android 原生工程；启动/恢复时会把 SQLite Flow 目录同步到当前 Runtime，移动端
  挂起会取消活动 run 并中止流式请求；内置日常聊天同样通过 Flow 执行，消息仅写入
  本地 SQLite；
- `nkg-ai-flow`：固定版本的上游子模块；
- `docs/architecture/runtime-routing.md`：路由设计、安全约束和下一阶段。
- `.github/workflows/desktop-sidecar.yml`：Windows、macOS、Linux 的 sidecar
  构建、鉴权 E2E 与目标三元组产物门禁。
- `.github/workflows/mobile-build.yml`：Windows Android arm64 Release APK/AAB 与 macOS
  iOS arm64 Simulator Release app 构建门禁；两者均不生成或携带桌面 sidecar。

## 开发

```powershell
git submodule update --init --recursive
npm install
npm run typecheck
npm test
npm run rust:check
npm run build:client
```

`build:client` 是桌面构建，会先生成当前宿主三元组的 Node sidecar；Android/iOS
配置改用纯前端 `build:frontend`，不会生成或携带桌面 Node 二进制。桌面 sidecar 可单独
验证：

```powershell
npm run build:sidecar
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
当前 arm64 实测基线为 14.83 MiB APK / 8.45 MiB AAB（未签名）。

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
Emulator 已验证应用启动、进程内 Runtime、SQLite Flow 目录同步、HOME/恢复生命周期、
Stronghold 解锁、Provider profile + API Key 分离保存，以及自定义 HTTP Provider 的
OpenAI-compatible SSE 流式响应；真机外部网络仍需在实际设备上复核。

当前测试只扫描本项目 `packages/`，上游子模块保持自己的依赖、测试配置和
发布节奏。

当前验证基线：本项目 86 项测试、4 项 Rust 测试、SQLite migration、sidecar
二进制鉴权 E2E、Windows Tauri debug application build 与 Android arm64 Debug APK
通过；子模块 738 项测试、类型检查和生产构建通过，browser Runtime 实际 bundle
不含 Node builtin import。
