# 跨平台 Runtime 实施审查报告（2026-07-20）

## 结论

当前项目结构已经从“桌面 sidecar + 移动特例”调整为合理的五端本地优先架构：

- 五端默认执行同一套 `portable` TypeScript Runtime；
- Node sidecar 仅是桌面显式 `desktop-power` 兼容模式；
- 业务数据、Flow、Run、事件、artifact 和变量均保存在用户设备；
- Provider URL 与 API Key 由用户配置，API Key 使用 Stronghold，本项目没有云端存储；
- Tauri/Rust 只实现 SQLite、密钥、原生 HTTP、受控文件等宿主能力；
- nkg-ai-flow 保持 Tauri 无关，并通过公开 package exports 提供 portable 能力。

该结构适合继续做聊天、自定义提示词角色和 Flow 编排助理。当前主要风险已经不是
“移动端没有 Node.js”，而是真机覆盖、完整桌面应用打包、长 Flow UI 隔离和高权限
工具授权尚未完成。

## 当前组件边界

```mermaid
flowchart LR
  UI["React UI / Studio"] --> Client["FlowRuntimeClient"]
  Client --> Router["RuntimeRouter"]
  Router -->|"五端默认"| Portable["In-process Portable Runtime"]
  Router -->|"桌面显式"| Sidecar["Node sidecar / desktop-power"]
  Portable --> Ports["Store / HTTP / Secret / Tool ports"]
  Ports --> Tauri["Tauri plugins + Rust commands"]
  Tauri --> SQLite[("SQLite")]
  Tauri --> Vault[("Stronghold")]
  Tauri --> OS["Native HTTP / scoped files"]
```

| 模块 | 应承担的职责 | 审查结果 |
|---|---|---|
| `nkg-ai-flow` | Flow IR、节点、调度、事件、capability、portable ports | 合理；未绑定 Tauri |
| `runtime-router` | backend 选择和统一客户端协议 | 合理；模式与平台已解耦 |
| `tauri-runtime-adapter` | 将 Tauri 能力映射为 nkg ports | 合理；已移除源码深路径导入 |
| `apps/client/src-tauri` | SQLite、Stronghold、sidecar 和原生工具命令 | 合理；桌面依赖按 target 条件编译 |
| `runtime-sidecar` | desktop-power 兼容执行 | 合理；不再是默认核心依赖 |
| React UI | 产品交互、目录同步、生命周期与错误呈现 | 基本合理；仍需 Worker 和 capability UI |

## Android 200+ MiB 的审查结论

历史 200+ MiB 包是 Debug 产物，不是当前发布结构的固有成本。Debug 包同时包含大量
符号、未裁剪 Rust 代码、未压缩资源和调试 ABI，因此不能用于评估上架体积。

当前 arm64 实测：

| 产物 | 体积 | 用途 |
|---|---:|---|
| Debug APK | 241.12 MiB | 开发调试，不发布 |
| Release APK | 14.38 MiB | 本地分发/安装基线 |
| Release AAB | 8.21 MiB | 商店上传基线 |

Release 已启用 Rust symbol strip、Thin LTO、`panic=abort`、R8 和资源裁剪；CI 对 APK
执行 40 MiB 硬门禁。受控 ToolHost、SQLite persistence 和 portable Runtime 接入后，
体积仍稳定在 14.38 MiB，证明这些架构修正没有重新引入桌面 sidecar 依赖。

## 已验证事实

| 维度 | 当前证据 |
|---|---|
| nkg-ai-flow | 47 个测试文件、746 项测试通过，TypeScript typecheck 通过 |
| 主项目 | 30 个测试文件、118 项测试通过，TypeScript typecheck 通过 |
| Rust | migration、sidecar 校验和路径 scope 共 6 项测试通过 |
| 前端 | Vite production build 通过，portable chunk gzip 约 21.32 KiB |
| Android | 本地 arm64 Release APK 14.38 MiB；远端 APK/AAB gate 已连续通过 |
| iOS | arm64 Simulator Release CI 通过 |
| 桌面 | Windows/macOS/Linux sidecar、鉴权和共享契约 CI 通过 |
| 包边界 | 顶层干净 `npm ci`、公开 `@ai-native-flow/*` 导入和禁止深路径门禁通过 |

这些证据证明代码边界与 Release 构建可用，但不等同于五端真机产品验收。

## 稳定性与安全审查

已经处理：

- Runtime Store 使用 SQLite 持久化，不再依赖生产内存状态；
- checkpoint 写入先于对应事件发布，降低崩溃后状态倒挂风险；
- 请求级变量覆盖与持久化变量分层，API Key 不进入普通 Runtime 变量表；
- capability 在 Flow 注册和执行解析前检查，拒绝运行到一半才发现宿主缺失；
- ToolHost 在 TypeScript 与 Rust 两侧重复校验 allow-list；
- 原生文件路径固定在应用私有目录，拒绝绝对路径、父目录和 symlink escape；
- 移动端不暴露 `filesystem.write` 或 `process.spawn`；
- HTTP/LLM 使用显式客户端注入，不污染全局 fetch；
- sidecar 崩溃后不自动重放可能产生副作用的请求。

仍需处理：

| 优先级 | 缺口 | 风险/影响 | 建议验收 |
|---|---|---|---|
| P1 | 三桌面系统未构建完整 Tauri portable Release 应用 | sidecar 通过不代表安装包能启动 | CI 构建并启动最小 smoke |
| P1 | Android/iOS 真机矩阵不足 | WebView、网络、挂起和密钥行为可能不同 | 同 Flow 真机 contract |
| P1 | Runtime 仍在 UI 主线程 | 大图或 CPU 节点可能阻塞交互 | Worker 压测与取消/恢复 |
| P1 | 自带 Flow fixture 通过率未单独统计 | 单元测试全绿不代表示例 Flow 可运行 | 建立 fixture 清单与通过率报告 |
| P2 | Studio 未显示 capability badge | 用户只能在注册/运行时看到不兼容 | 编辑时预检和平台报告 |
| P2 | 写文件与用户目录授权未实现 | 助理能力受限，但贸然开放会扩大攻击面 | 选择目录 + 预览 + 逐次确认 |
| P2 | Runtime 事件/Run 保留策略未定义 | 长期使用可能导致 SQLite 增长 | 配额、归档与清理 contract |
| P3 | 主前端 chunk 约 1.06 MiB（gzip 262 KiB） | 影响首屏，不是 APK 体积主因 | 路由/编辑器按需加载 |

## 下一轮优化顺序

1. 建立 nkg-ai-flow 自带 Flow fixture runner，输出按节点类型和平台分类的通过率；
2. 把五端共同的 persistence、capability、HTTP 和 ToolHost ports 继续下沉到
   nkg-ai-flow，Tauri 实现继续留在 nkg-ai-bot；
3. 增加 Windows/macOS/Linux 完整 Tauri portable Release gate；
4. 增加 Android/iOS 真机相同 fixture、流式取消和前后台恢复 gate；
5. 将 portable Runtime 放入 Web Worker，并设计主线程原生能力代理；
6. Studio 接入 capability inspection；
7. 在明确用户确认流程后，再增加用户选择目录和写工具。

## 审查判定

- 结构合理性：**通过，允许继续产品开发**。
- Android 发布体积：**通过，200+ MiB 问题已被 Release 基线消除**。
- 五端语义一致性：**代码与 CI 基础通过，真机和完整桌面应用仍需补齐**。
- nkg-ai-flow 自带 Flow 通过率：**尚未形成可量化报告，列为下一阶段 P1**。
- 完全下沉跨平台能力到 submodule：**已开始（browser runtime、capability、HTTP
  注入），尚未完成宿主 ports 与 fixture 验收闭环**。
