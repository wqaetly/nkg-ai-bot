import StoreKit
import SwiftRs
import Tauri
import WebKit

private final class ProductsArgs: Decodable {
    let productIds: [String]
}

private final class PurchaseArgs: Decodable {
    let productId: String
    let appAccountToken: String
}

private final class FinishArgs: Decodable {
    let transactionId: String
}

final class StorekitPlugin: Plugin {
    private var updatesTask: Task<Void, Never>?

    @objc public override func load(webview: WKWebView) {
        updatesTask?.cancel()
        updatesTask = Task { [weak self] in
            for await verification in Transaction.updates {
                guard !Task.isCancelled else { return }
                guard case .verified(let transaction) = verification else { continue }
                self?.trigger(
                    "transaction",
                    data: Self.transactionPayload(transaction, verification.jwsRepresentation)
                )
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    @objc public func products(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ProductsArgs.self)
        Task {
            do {
                let products = try await Product.products(for: Set(args.productIds))
                invoke.resolve(products.sorted { $0.price < $1.price }.map(Self.productPayload))
            } catch {
                invoke.reject("无法从 App Store 获取点数商品：\(error.localizedDescription)")
            }
        }
    }

    @objc public func purchase(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PurchaseArgs.self)
        guard let accountToken = UUID(uuidString: args.appAccountToken) else {
            invoke.reject("NKG 账户标识无效")
            return
        }
        Task { @MainActor in
            do {
                guard let product = try await Product.products(for: [args.productId]).first else {
                    invoke.reject("App Store 中没有找到该点数商品")
                    return
                }
                guard product.type == .consumable else {
                    invoke.reject("该 App Store 商品不是消耗型点数商品")
                    return
                }
                switch try await product.purchase(options: [.appAccountToken(accountToken)]) {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else {
                        invoke.reject("App Store 交易未通过设备验证")
                        return
                    }
                    invoke.resolve([
                        "status": "purchased",
                        "transaction": Self.transactionPayload(
                            transaction,
                            verification.jwsRepresentation
                        ),
                    ])
                case .pending:
                    invoke.resolve(["status": "pending"])
                case .userCancelled:
                    invoke.resolve(["status": "cancelled"])
                @unknown default:
                    invoke.reject("App Store 返回了未知购买状态")
                }
            } catch {
                invoke.reject("购买未完成：\(error.localizedDescription)")
            }
        }
    }

    @objc public func unfinished(_ invoke: Invoke) {
        Task {
            var transactions: [[String: Any]] = []
            for await verification in Transaction.unfinished {
                guard case .verified(let transaction) = verification else { continue }
                transactions.append(Self.transactionPayload(
                    transaction,
                    verification.jwsRepresentation
                ))
            }
            invoke.resolve(transactions)
        }
    }

    @objc public func finish(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FinishArgs.self)
        Task {
            for await verification in Transaction.unfinished {
                guard case .verified(let transaction) = verification else { continue }
                if String(transaction.id) == args.transactionId {
                    await transaction.finish()
                    invoke.resolve(["finished": true])
                    return
                }
            }
            invoke.resolve(["finished": false])
        }
    }

    private static func productPayload(_ product: Product) -> [String: Any] {
        [
            "id": product.id,
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
            "price": NSDecimalNumber(decimal: product.price).stringValue,
            "productType": product.type == .consumable ? "consumable" : "unsupported",
        ]
    }

    private static func transactionPayload(
        _ transaction: Transaction,
        _ signedTransactionInfo: String
    ) -> [String: Any] {
        let environment: String
        if #available(iOS 16.0, *) {
            environment = transaction.environment.rawValue
        } else {
            environment = transaction.environmentStringRepresentation
        }
        var payload: [String: Any] = [
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID,
            "purchaseDate": ISO8601DateFormatter().string(from: transaction.purchaseDate),
            "environment": environment,
            "ownershipType": String(describing: transaction.ownershipType),
            "signedTransactionInfo": signedTransactionInfo,
        ]
        if let appAccountToken = transaction.appAccountToken {
            payload["appAccountToken"] = appAccountToken.uuidString.lowercased()
        }
        return payload
    }
}

@_cdecl("init_plugin_storekit")
func initPlugin() -> Plugin {
    StorekitPlugin()
}
