use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductsRequest {
    pub product_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreProduct {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub display_price: String,
    pub price: String,
    pub product_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRequest {
    pub product_id: String,
    pub app_account_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreTransaction {
    pub transaction_id: String,
    pub original_transaction_id: String,
    pub product_id: String,
    pub app_account_token: Option<String>,
    pub purchase_date: String,
    pub environment: String,
    pub ownership_type: String,
    pub signed_transaction_info: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseResult {
    pub status: String,
    pub transaction: Option<StoreTransaction>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRequest {
    pub transaction_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishResult {
    pub finished: bool,
}
