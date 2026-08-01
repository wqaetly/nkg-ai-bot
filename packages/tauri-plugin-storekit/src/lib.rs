use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

mod commands;
#[cfg(not(target_os = "ios"))]
mod desktop;
mod error;
#[cfg(target_os = "ios")]
mod mobile;
mod models;

pub use error::{Error, Result};

#[cfg(not(target_os = "ios"))]
use desktop::Storekit;
#[cfg(target_os = "ios")]
use mobile::Storekit;

pub trait StorekitExt<R: Runtime> {
    fn storekit(&self) -> &Storekit<R>;
}

impl<R: Runtime, T: Manager<R>> StorekitExt<R> for T {
    fn storekit(&self) -> &Storekit<R> {
        self.state::<Storekit<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("storekit")
        .invoke_handler(tauri::generate_handler![
            commands::products,
            commands::purchase,
            commands::unfinished,
            commands::finish,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let storekit = mobile::init(app, api)?;
            #[cfg(not(target_os = "ios"))]
            let storekit = desktop::init(app, api)?;
            app.manage(storekit);
            Ok(())
        })
        .build()
}
