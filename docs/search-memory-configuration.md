# 联网搜索与长期记忆配置

本文记录 Steam 发布版的默认策略、配置边界和隐私口径。

## 联网搜索

- 内置 SearXNG URL 为 `https://search.lfzxb.top`，Steam 默认模式通过 `api.lfzxb.top/api/app/v1/search` 代理访问。
- 客户端只发送现有的 NKG 匿名安装会话；Hosted AI 服务验证会话并按会话限流，SearXNG Key 只存在服务端环境变量 `SEARXNG_API_KEY`。
- Hosted AI 未编入特定构建时，可用 `VITE_DEFAULT_SEARXNG_API_KEY` 作为兼容回退。该值会进入前端资源，所以只能是**公开客户端 token**：仅具搜索权限、限流、可轮换、不可拥有管理权限，也不能复用后台密钥。
- 没有 Hosted AI、构建期 token 或已有本地配置时，不会伪造默认凭据。用户仍可填写当前服务的 Key，或改用自己的 SearXNG。
- 自定义 SearXNG 支持 `X-API-Key` 和无认证两种模式。更换 URL 时不会把旧服务的 Key 自动发送给新服务。
- 开启联网后不会直接把用户整段输入粘贴给 SearXNG。客户端先调用当前聊天模型运行内置搜索规划 Flow，结合最近最多 12 条对话判断是否真的需要联网，并生成最多 3 条、每条不超过 200 字符的独立查询。
- 多条查询顺序执行，每条最多取 4 个结果，再按查询轮询合并、URL 去重，最终最多向聊天 Flow 注入 6 个结果。模型明确返回空查询时跳过联网；规划 Flow 异常时才回退到安全裁剪后的用户原文，包含凭据特征的文本不会进入回退搜索。

兼容回退构建示例（正常 Steam 构建不需要）：

```powershell
$env:VITE_DEFAULT_SEARXNG_API_KEY = "仅搜索、限流且可轮换的公开客户端 token"
npm run release:local
```

Hosted AI 服务本身还对 `/api/app/v1/search` 做每 IP 与每会话固定窗口限流、12 秒超时、1 MiB 上游响应限制、URL scheme 过滤和结果长度裁剪。发布前仍应在 Nginx/SearXNG 侧叠加限流，形成独立于 Node 进程内计数器的第二道门禁。

## 长期记忆

### 默认：本地模式

- 每次成功的新问答都会创建一个异步自动归档任务，只分析当前用户与助手这一轮；任务串行执行，不阻塞回复。
- 当前聊天模型最多提取 5 条稳定事实或偏好；无长期价值时返回空数组。通过凭据过滤后，结果会自动去重并写入 `nkg-ai-bot.db` 的 `memory_items`。
- 默认开启本地混合语义检索，使用 `Xenova/bge-small-zh-v1.5` 的 q8 ONNX 模型和 512 维向量。
- ONNX Runtime WASM 和约 25 MB 的模型均随应用发布，不依赖外部 CDN，也不上传记忆正文。
- 本地模型不可用、设备能力不足或推理失败时，自动回退中英文词项召回，不阻断聊天。
- 手动“记住”和用户纠正触发的反思 Flow 仍生成待审候选；自动归档任务则直接启用通过检查的结果，之后用户仍可编辑、停用或删除。
- 自动归档和反思 Flow 会调用用户当前选择的聊天模型做事实提取，因此“本地记忆”表示本地存储、向量检索和治理，不表示归档文本永远不离开设备。设置中可单独关闭“自动归档每轮对话”。

### 本地混合语义检索

模型在独立 `localEmbedding.worker.ts` 中以 WASM CPU 执行，避免阻塞 UI 和现有 Flow Runtime Worker。查询会添加 BGE 中文检索指令，记忆正文使用原文编码；两者均进行 CLS pooling 和向量归一化。

检索链路：

1. 分页读取当前助手 namespace 的全部启用记忆，不再截断到最近 500 条；
2. 先运行现有本地词项排序；
3. 首次检索同步补齐最多 8 条候选，随后在后台按每批 8 条逐步补齐其余记忆；
4. 把 Float32 向量压成 Base64，存入 SQLite `memory_item_embeddings`；
5. 原生端调用 Tauri Rust 命令，将有效向量同步到 zvec HNSW 索引；按 namespace、模型标识和维度分库，只有变化的向量才写入；
6. zvec 取至少 50 条语义候选，补充词项候选后以余弦相似度和词项分数混合排序；zvec 失败时回退全量余弦，Worker 或模型不可用时回退词项检索。

记忆编辑后内容指纹会变化，旧向量不会继续使用；删除记忆时 SQLite 向量通过外键级联删除。手动编辑、停用或删除记忆会清空所有派生 zvec 索引，下次检索重建；进行中的旧快照检索会被丢弃。索引在应用本地数据目录的 `memory-zvec-v1` 中，不包含记忆正文，不纳入聊天快照导出。SQLite 始终为主存储。

zvec 不生成 Embedding，也不会自动改善 BGE 的语义理解。本地模型仍为 BGE；索引使用近似检索，需要在实际语料上衡量召回率与耗时。本版仍读取全部向量快照并传给 Rust，尚未消除 O(N) 的数据库读取和 IPC 成本；不能把原生检索速度等同于端到端速度提升。索引损坏会回退现有检索，关闭应用后可删除该派生目录重建。

### zvec 原生构建

- Rust SDK 固定为 `zvec-rust 0.7.1`，底层 C SDK 固定为上游 `0.7.0`；通过 `scripts/zvec-sdk.mjs` 下载并校验固定 SHA-256，Cargo 不自动拉取或编译未固定的上游源码。
- 使用项目的 `scripts/cargo.mjs`、Tauri 和 Android 构建入口；SDK 缓存在忽略提交的 `apps/client/src-tauri/native/zvec`。运行时不联网下载原生库。
- 自动预编译目标：Windows x64、Linux x64/ARM64（glibc/musl）、macOS ARM64、Android ARM64、iOS ARM64 真机及模拟器。其他架构需要提供兼容版本的 `ZVEC_LIB_DIR`，不会静默使用主机架构库。
- Android 最低版本为 Android 9 / API 28；`.so` 随 APK 的 `jniLibs` 打包，不需要 Python 或 Node Sidecar。
- iOS 在 macOS/Xcode 上准备包含真机和模拟器切片的 `zvec_c_api.xcframework`，由 Tauri 配置嵌入并签名。已有 iOS 工程需重新运行 `npm run ios:init` 更新 framework 依赖；Windows 无法完成 iOS 构建或签名验收。
- Windows DLL 随安装包放在可执行文件旁；Linux 使用应用资源目录，macOS 使用 Frameworks。许可证和 NOTICE 位于前端资源 `licenses/zvec/`。
- 验证：Windows 原生索引测试覆盖重开、更新、删除和模型隔离；Android ARM64 Release 构建及 APK 检查通过（API 28、包含 zvec、16 KiB 对齐）。当前 APK 约 62.88 MiB，默认体积门禁调整为 64 MiB。iOS/macOS/Linux 运行及签名尚未在对应环境验收。

### 可选：云端 Embeddings

用户仍可切换到已配置的 OpenAI 兼容 Provider，并填写 `text-embedding-3-small`、`bge-m3` 等模型。只有在此模式下，查询与待索引记忆会发送到该 Provider 的 `/embeddings`；向量仍只保存在本机。

### 可选：MemOS

MemOS 是本地记忆之外的可选跨端增强。启用后，应用会在回答前调用 `search/memory`，并在完整回答落库后异步调用 `add/message`。远程失败不会阻断本地记忆或聊天。MemOS URL、用户标识和启用状态保存在 SQLite，API Key 只进入 Stronghold。

## 为什么暂不引入完整记忆框架

- [Mem0](https://github.com/mem0ai/mem0) 默认需要 LLM、Embedding 与向量存储；增强混合检索还会扩大 NLP 依赖，和当前小规模本地记忆重复。
- [MemOS](https://github.com/MemTensor/MemOS) Local 插件会引入第二套记忆生命周期、原生 Node 模块和额外 UI/状态模型；当前只保留其云 API 适配。
- [Transformers.js](https://github.com/huggingface/transformers.js) 只用于独立、懒加载的本地 Embedding Worker；当前包体和内存预算已接受其 ONNX/WASM 成本。
- [sqlite-vec](https://github.com/asg017/sqlite-vec) 很轻，但仍是 pre-v1 原生扩展；目前先对全部启用记忆做分页线性余弦，出现真实性能瓶颈后再评估。
- [SQLite FTS5](https://www.sqlite.org/fts5.html) 适合 BM25 全文检索，但中文默认分词和四端 SQLite 编译特性仍需单独验收；现阶段保留已有的中文字/双字词项索引作为稳定回退。

## Steam 隐私文案

可以描述为：聊天、配置、本地记忆和语义向量默认写入用户设备；项目方不运营聊天云同步。

不能描述为“所有内容永不离开设备”。使用远程聊天模型、Embedding、联网搜索或 MemOS 时，相应查询、上下文或记忆会发送到用户启用的服务。设置页和记忆面板必须持续展示这一边界。

2026-10-20 搜索故障处理：前置联网搜索与上下文准备纳入聊天运行的失败记录，失败回复可原位重新生成，不再只保留用户消息。直接 SearXNG 返回空结果时区分真正无结果、上游验证码/限流/超时、响应格式异常；仅输出分类，不回显上游原始错误或密钥。真正无结果继续尝试后续规划关键词；服务故障停止后续搜索，已有有效结果仍保留。未获得联网资料时不会把离线推荐伪装成已联网核实。替代配置搜索沿用相同故障分类。客户端修复不能解除搜索服务器的上游风控。

2026-10-20 服务端恢复：SearXNG 镜像从 2026-08-22 构建更新到 `2026.10.19-81371861f`，默认通用检索采用本轮实测可用的 Bing、Yahoo，停用本轮持续报验证码/限流的百度、Brave、DuckDuckGo、Google CSE、Startpage，以及拒绝访问的 Qwant。外部带认证接口对 `python`、`AMD 7500F`、`8000元 2K 游戏 编程 电脑配置` 分别返回 15、17、7 条结果，上游错误均为空；旧镜像与原配置留存以便回滚。这是本次接口实测，不保证上游永久可用，尚未验证完整配置推荐流程。
