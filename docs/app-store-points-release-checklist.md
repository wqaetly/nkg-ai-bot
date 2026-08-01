# iOS 免费下载 + AI 点数上线清单

## App Store Connect

- App 价格设为免费，不创建订阅或“买断解锁”商品。
- 每个点数包创建为 **Consumable（消耗型）**，商品 ID 与服务端 `NKG_POINT_PACKS_JSON` 完全一致。
- 点数数量由服务端商品目录决定；按钮价格和商品名称只显示 StoreKit 返回的本地化内容。
- 首次随 App 提交的内购商品与新版本一并送审，并准备购买页截图。
- App 隐私信息、隐私政策、支持 URL 和审核测试账号/步骤全部可访问。

## 审核说明建议

> NKG 是以自定义 AI 工作流为核心的本地优先客户端。用户可免费创建、编辑和运行工作流，并可连接自己拥有的兼容模型 API。可选的 NKG AI 服务使用消耗型 AI 点数，只有用户主动选择 NKG AI 模型时才扣点。购买点数不设有效期；重装或换设备可用账户恢复码找回服务端余额。App 使用 StoreKit 2，服务端验证 Apple 签名交易后才发放点数。

不要在元数据或审核说明中把产品描述为“中转站”；也不要声称点数能够解锁 App 内功能。点数购买的是可计量的托管模型用量，自定义工作流与 BYOK 功能保持免费。

## 生产门禁

- `api.lfzxb.top` 的 Commerce API、PostgreSQL、Apple 根证书和专用 New API 受限令牌已部署。
- App Store Server Notifications V2 已指向 `/api/app/v1/apple/notifications`，Sandbox 与 Production 都完成退款演练。
- 新账户赠送默认保持为 0；启用赠送前先接入 App Attest 或等效防刷能力。
- 用 StoreKit Configuration、本地 Sandbox 账号和至少一台真机验证：购买成功、pending、取消、断网、崩溃后未完成交易、重复通知、退款、恢复码换机。
- 验证客户端永远拿不到 `NEW_API_KEY`，运行令牌过期后不可使用，重复交易只入账一次。
- 只有上述门禁全部通过，才在 iOS Release 构建中设置 `VITE_NKG_HOSTED_AI_ENABLED=true`。

## 中国大陆可用区

技术上架能力与中国大陆的生成式 AI 合规是两件事。不要仅因为同类 App 可下载就推断本项目必然可以开放国区。正式勾选中国大陆销售区域前，应单独确认模型服务、内容治理、备案/许可、隐私与跨境数据安排；不满足时先限制销售区域或仅提供合规后的服务目录。

## 官方参考

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple：Persisting a purchase](https://developer.apple.com/documentation/storekit/persisting-a-purchase)
- [Apple：In-App Purchase 商品类型](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases/)
- [国家网信办：《生成式人工智能服务管理暂行办法》](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)
