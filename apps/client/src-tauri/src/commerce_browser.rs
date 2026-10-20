use crate::commerce_session::remember_session_cookies;
use serde_json::{json, Value};
use std::{sync::mpsc, time::Duration};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn remember_all_sessions(app: &AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if let Some(provider) = label.strip_prefix("commerce-login-") {
            let provider = provider.to_owned();
            remember_session_cookies(&window, move |host| allowed_host(&provider, host))?;
        }
    }
    Ok(())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if let Some(provider) = window.label().strip_prefix("commerce-login-") {
        api.prevent_close();
        let provider = provider.to_owned();
        if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
            let _ = webview.hide();
            tauri::async_runtime::spawn_blocking(move || {
                if remember_session_cookies(&webview, move |host| allowed_host(&provider, host)).is_err()
                {
                    eprintln!("商城登录状态保存失败；窗口仍保留，可以重新打开后重试。");
                }
            });
        }
    } else if window.label() == "main"
        && window
            .app_handle()
            .webview_windows()
            .keys()
            .any(|label| label.starts_with("commerce-login-"))
    {
        api.prevent_close();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            if remember_all_sessions(&app).is_err() {
                eprintln!("退出前无法保存商城登录状态，下次启动可能需要重新登录。");
            }
            app.exit(0);
        });
    }
}

fn platform_home(provider: &str) -> Result<&'static str, String> {
    match provider {
        "pdd" => Ok("https://mobile.yangkeduo.com/"),
        "jd" => Ok("https://www.jd.com/"),
        "taobao" => Ok("https://www.taobao.com/"),
        _ => Err("请选择拼多多、京东或淘宝".into()),
    }
}

fn allowed_host(provider: &str, host: &str) -> bool {
    let domains: &[&str] = match provider {
        "pdd" => &["yangkeduo.com", "pinduoduo.com"],
        "jd" => &["jd.com"],
        "taobao" => &["taobao.com", "tmall.com", "alipay.com"],
        _ => &[],
    };
    domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn product_url(provider: &str, raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|_| "商品链接无效")?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    let valid = match provider {
        "jd" => {
            url.host_str() == Some("item.jd.com")
                && url
                    .path()
                    .strip_prefix('/')
                    .and_then(|p| p.strip_suffix(".html"))
                    .is_some_and(digits)
        }
        "pdd" => {
            url.host_str() == Some("mobile.yangkeduo.com")
                && url.path() == "/goods.html"
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "goods_id" && digits(&value))
        }
        "taobao" => {
            matches!(url.host_str(), Some("item.taobao.com" | "detail.tmall.com"))
                && url.path() == "/item.htm"
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "id" && digits(&value))
        }
        _ => false,
    };
    if !valid
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("只允许打开所选商城的商品详情链接".into());
    }
    Ok(url)
}

fn profile(app: &AppHandle, provider: &str) -> Result<std::path::PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("commerce-browser")
        .join(provider);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn commerce_browser_login(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    provider: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("仅允许从主窗口操作商城会话".into());
    }
    let home = platform_home(&provider)?;
    let label = format!("commerce-login-{provider}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let url = tauri::Url::parse(home).map_err(|e| e.to_string())?;
    let profile = profile(&app, &provider)?;
    let mut builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("商城登录 · 登录后关闭窗口将记住登录状态")
        .inner_size(1100.0, 780.0)
        .data_directory(profile);
    if provider == "pdd" {
        builder = builder
            .inner_size(430.0, 820.0)
            .user_agent(PDD_MOBILE_USER_AGENT);
    }
    builder
        .on_navigation(move |url| {
            url.scheme() == "https" && allowed_host(&provider, url.host_str().unwrap_or(""))
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn commerce_browser_collect(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    request_id: String,
    provider: String,
    keyword: Option<String>,
    url: Option<String>,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("仅允许从主窗口采集商城商品".into());
    }
    platform_home(&provider)?;
    if app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with("commerce-collect-"))
        .count()
        >= 4
    {
        return Err("商城采集正在进行，请稍后重试".into());
    }
    if request_id.len() > 80
        || !request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("采集请求标识无效".into());
    }
    let target = if let Some(raw) = &url {
        product_url(&provider, raw)?
    } else {
        let keyword = keyword.as_deref().unwrap_or("").trim();
        if keyword.is_empty() || keyword.len() > 300 {
            return Err("搜索词无效".into());
        }
        let (base, key) = match provider.as_str() {
            "pdd" => (
                "https://mobile.yangkeduo.com/search_result.html",
                "search_key",
            ),
            "jd" => ("https://search.jd.com/Search", "keyword"),
            _ => ("https://s.taobao.com/search", "q"),
        };
        let mut target = tauri::Url::parse(base).map_err(|e| e.to_string())?;
        target.query_pairs_mut().append_pair(key, keyword);
        target
    };
    let label = format!("commerce-collect-{request_id}");
    let phase = if url.is_some() { "detail" } else { "search" };
    let callback = format!("https://nkg-commerce.invalid/{request_id}");
    let config = json!({"provider": provider, "url": url, "callback": callback});
    let script = format!(
        "{}\ncollectCommercePage({});",
        include_str!("../../../../packages/commerce-flow/src/browserCollector.js"),
        config
    );
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .title("正在读取商城商品")
        .visible(false)
        .focused(false)
        .inner_size(1100.0, 780.0)
        .data_directory(profile(&app, &provider)?)
        .initialization_script(&script);
    if provider == "pdd" {
        builder = builder
            .inner_size(430.0, 820.0)
            .user_agent(PDD_MOBILE_USER_AGENT);
    }
    let cookie_provider = provider.clone();
    let window = builder
        .on_navigation(move |target| {
            if target.as_str().starts_with(&format!("{callback}?")) {
                if let Some((_, data)) = target.query_pairs().find(|(key, _)| key == "data") {
                    if data.len() < 100_000 {
                        if let Ok(value) = serde_json::from_str::<Value>(&data) {
                            let _ = sender.try_send(value);
                        }
                    }
                }
                return false;
            }
            target.scheme() == "https" && allowed_host(&provider, target.host_str().unwrap_or(""))
        })
        .build()
        .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(30))
    })
    .await;
    let cookie_window = window.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        remember_session_cookies(&cookie_window, move |host| allowed_host(&cookie_provider, host))
    })
    .await;
    let page_url = window.url().ok().map(|mut url| {
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    });
    let _ = window.close();
    Ok(match result {
        Ok(Ok(value)) => value,
        _ => json!({"status": "timeout", "products": [], "diagnostics": {"pageUrl": page_url, "phase": phase}}),
    })
}

// PDD's storefront is a mobile web page; use the same profile and viewport for login and collection.
const PDD_MOBILE_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

#[tauri::command]
pub async fn commerce_browser_cancel(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("仅允许从主窗口取消采集".into());
    }
    if let Some(window) = app.get_webview_window(&format!("commerce-collect-{request_id}")) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_selected_platform_products_can_be_opened() {
        assert!(product_url("jd", "https://item.jd.com/123.html").is_ok());
        assert!(product_url("taobao", "https://detail.tmall.com/item.htm?id=123").is_ok());
        assert!(product_url(
            "pdd",
            "https://mobile.yangkeduo.com/goods.html?goods_id=123"
        )
        .is_ok());
        for url in [
            "https://item.jd.com.evil.test/123.html",
            "https://127.0.0.1/",
            "https://item.jd.com/search",
            "http://item.jd.com/123.html",
        ] {
            assert!(product_url("jd", url).is_err());
        }
        assert!(!allowed_host("pdd", "yangkeduo.com.evil.test"));
    }
}
