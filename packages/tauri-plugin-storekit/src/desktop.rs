use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Storekit<R>> {
    Ok(Storekit(app.clone()))
}

pub struct Storekit<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Storekit<R> {
    pub fn products(&self, _payload: ProductsRequest) -> Result<Vec<StoreProduct>> {
        Err(Error::Unsupported)
    }

    pub fn purchase(&self, _payload: PurchaseRequest) -> Result<PurchaseResult> {
        Err(Error::Unsupported)
    }

    pub fn unfinished(&self) -> Result<Vec<StoreTransaction>> {
        Err(Error::Unsupported)
    }

    pub fn finish(&self, _payload: FinishRequest) -> Result<FinishResult> {
        Err(Error::Unsupported)
    }
}
