use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

tauri::ios_plugin_binding!(init_plugin_storekit);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Storekit<R>> {
    Ok(Storekit(api.register_ios_plugin(init_plugin_storekit)?))
}

pub struct Storekit<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Storekit<R> {
    pub fn products(&self, payload: ProductsRequest) -> crate::Result<Vec<StoreProduct>> {
        self.0.run_mobile_plugin("products", payload).map_err(Into::into)
    }

    pub fn purchase(&self, payload: PurchaseRequest) -> crate::Result<PurchaseResult> {
        self.0.run_mobile_plugin("purchase", payload).map_err(Into::into)
    }

    pub fn unfinished(&self) -> crate::Result<Vec<StoreTransaction>> {
        self.0.run_mobile_plugin("unfinished", ()).map_err(Into::into)
    }

    pub fn finish(&self, payload: FinishRequest) -> crate::Result<FinishResult> {
        self.0.run_mobile_plugin("finish", payload).map_err(Into::into)
    }
}
