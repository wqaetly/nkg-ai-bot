use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{Result, StorekitExt};

#[command]
pub(crate) async fn products<R: Runtime>(
    app: AppHandle<R>,
    payload: ProductsRequest,
) -> Result<Vec<StoreProduct>> {
    app.storekit().products(payload)
}

#[command]
pub(crate) async fn purchase<R: Runtime>(
    app: AppHandle<R>,
    payload: PurchaseRequest,
) -> Result<PurchaseResult> {
    app.storekit().purchase(payload)
}

#[command]
pub(crate) async fn unfinished<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<StoreTransaction>> {
    app.storekit().unfinished()
}

#[command]
pub(crate) async fn finish<R: Runtime>(
    app: AppHandle<R>,
    payload: FinishRequest,
) -> Result<FinishResult> {
    app.storekit().finish(payload)
}
