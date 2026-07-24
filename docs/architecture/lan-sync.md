# 局域网同步

局域网同步复用 `.nkgbackup` 迁移包语义，但不把运行中的 SQLite 文件直接暴露为网络服务。
迁移包 v2 除 SQLite、偏好与加密凭据外，还包含消息所引用的 `chat-images/*` 原图；
接收端先校验相对路径和图片内容，再与数据库一起暂存并在重启时恢复。
发送端先执行 WAL checkpoint 并生成一致快照；接收端完成解密和格式校验后，仍需用户确认，
随后自动导出当前设备备份、暂存导入内容并重启替换数据。

## 发现层

- iOS 使用系统 DNS-SD/Bonjour 注册和浏览 `_nkg-sync._tcp`，并在
  `Info.ios.plist` 中声明 `NSLocalNetworkUsageDescription` 与 `NSBonjourServices`。
  这属于指定类型的 Bonjour 服务发现，不使用原始 UDP 广播，因此不要求受限的
  `com.apple.developer.networking.multicast` entitlement。
- Windows、macOS、Linux 与 Android 同时发布兼容的 mDNS/DNS-SD 服务，并保留原有
  IPv4 UDP 广播发现。Bonjour 用于与 iOS 互通，UDP 用于路由器或设备屏蔽 mDNS 时的回退。
- Bonjour TXT 记录只携带协议版本、会话 ID、设备显示名、临时公钥和过期时间，不包含
  配对码、聊天数据或凭据。

## 传输与认证

每次发送会话生成 X25519 临时密钥和 6 位配对码。接收端根据共享密钥、配对码和会话 ID
生成认证证明，通过后双方派生一次性 ChaCha20-Poly1305 数据密钥。迁移包使用会话 ID
作为附加认证数据加密传输。

会话十分钟过期；连续五次配对失败后关闭；成功传输一次后立即失效。数据不经过云端。

## 验证

`npm run rust:test` 包含 Bonjour 兼容服务的本机发布/发现测试，以及认证加密 TCP 传输测试。
`npm run rust:check:ios-bonjour` 会在非 macOS CI 上类型检查 iOS DNS-SD FFI 分支。

Windows 环境不能生成或签名 iOS 应用。发布前仍需在 macOS 上执行 iOS build，并用真机验证：

1. iPhone 与 Windows/Android 连接同一 WiFi，双向发送。
2. iPhone 连接 Windows/Android 热点，双向发送。
3. 两台 Apple 设备通过同一 WiFi；按产品需要补测 Personal Hotspot。
4. 首次搜索时允许“本地网络”权限，拒绝后确认错误提示与系统设置恢复路径。
