#[cfg(any(not(target_os = "windows"), test))]
use cookie::{time::Duration, Cookie};

#[cfg(any(not(target_os = "windows"), test))]
fn remember_cookie(mut cookie: Cookie<'static>, allowed: bool) -> Option<Cookie<'static>> {
    if !allowed || cookie.expires_datetime().is_some() || cookie.max_age().is_some() {
        return None;
    }
    // WebView2 discards session cookies across restarts even with a persistent profile.
    // Keep them in its encrypted cookie store; never export credentials to JS or logs.
    cookie.set_max_age(Duration::days(7));
    Some(cookie)
}

// Must run off the UI thread: WebView2 cookie reads otherwise deadlock.
#[cfg(not(target_os = "windows"))]
pub fn remember_session_cookies(
    window: &tauri::WebviewWindow,
    allowed_host: impl Fn(&str) -> bool + Send + 'static,
) -> Result<usize, String> {
    let cookies = window.cookies().map_err(|_| "无法读取商城登录状态")?;
    let mut remembered = 0;
    for cookie in cookies {
        let allowed = cookie
            .domain()
            .is_some_and(|host| allowed_host(host.trim_start_matches('.')));
        if let Some(cookie) = remember_cookie(cookie, allowed) {
            window
                .set_cookie(cookie)
                .map_err(|_| "无法保存商城登录状态")?;
            remembered += 1;
        }
    }
    // Await the native cookie manager after queued writes before closing a WebView.
    if remembered > 0 {
        window
            .cookies()
            .map_err(|_| "无法确认商城登录状态保存完成")?;
    }
    Ok(remembered)
}

#[cfg(target_os = "windows")]
pub fn remember_session_cookies(
    window: &tauri::WebviewWindow,
    allowed_host: impl Fn(&str) -> bool + Send + 'static,
) -> Result<usize, String> {
    use std::{sync::mpsc, time::{Duration, SystemTime, UNIX_EPOCH}};
    use webview2_com::{GetCookiesCompletedHandler, take_pwstr, Microsoft::Web::WebView2::Win32::ICoreWebView2_2};
    use windows::core::{Interface, PCWSTR, PWSTR};
    let (sender, receiver) = mpsc::channel();
    window.with_webview(move |webview| unsafe {
        let failed = sender.clone();
        let start = (|| -> windows::core::Result<()> {
            let core = webview.controller().CoreWebView2()?.cast::<ICoreWebView2_2>()?;
            let manager = core.CookieManager()?;
            let callback_manager = manager.clone();
            manager.GetCookies(PCWSTR::null(), &GetCookiesCompletedHandler::create(Box::new(move |error, list| {
                let result = (|| -> windows::core::Result<usize> {
                    error?;
                    let Some(list) = list else { return Ok(0) };
                    let mut count = 0;
                    list.Count(&mut count)?;
                    let expires = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() + 7.0 * 86400.0;
                    let mut remembered = 0;
                    for index in 0..count {
                        let cookie = list.GetValueAtIndex(index)?;
                        let mut session = false.into();
                        cookie.IsSession(&mut session)?;
                        if !session.as_bool() { continue; }
                        let mut domain = PWSTR::null();
                        cookie.Domain(&mut domain)?;
                        let domain = take_pwstr(domain);
                        if !allowed_host(domain.trim_start_matches('.')) { continue; }
                        // Keep the native object: cookie::Cookie::domain() strips the leading
                        // dot, so Tauri's read/set round trip changes subdomain scope.
                        // Never read or export cookie names/values through the app.
                        cookie.SetExpires(expires)?;
                        callback_manager.AddOrUpdateCookie(&cookie)?;
                        remembered += 1;
                    }
                    Ok(remembered)
                })();
                match result {
                    Ok(count) => {
                        let done = sender.clone();
                        // Await a native round trip before closing the owning WebView.
                        if callback_manager.GetCookies(PCWSTR::null(), &GetCookiesCompletedHandler::create(Box::new(move |error, _| {
                            let _ = done.send(error.map(|_| count).map_err(|_| "无法确认商城登录状态保存完成".to_owned()));
                            Ok(())
                        }))).is_err() {
                            let _ = sender.send(Err("无法确认商城登录状态保存完成".to_owned()));
                        }
                    }
                    Err(_) => { let _ = sender.send(Err("无法保存商城登录状态".to_owned())); }
                }
                Ok(())
            })))?;
            Ok(())
        })();
        if start.is_err() { let _ = failed.send(Err("无法读取商城登录状态".to_owned())); }
    }).map_err(|_| "无法调度商城登录状态保存")?;
    receiver.recv_timeout(Duration::from_secs(10)).map_err(|_| "商城登录状态保存超时".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_cookie_domain_access_loses_native_subdomain_scope() {
        let domain_cookie = Cookie::build(("synthetic", "test")).domain(".example.test").build();
        let host_cookie = Cookie::build(("synthetic", "test")).domain("example.test").build();
        assert_eq!(domain_cookie.domain(), host_cookie.domain());
        assert_eq!(domain_cookie.domain(), Some("example.test"));
        // Windows must update the native object rather than reconstruct it with domain().
    }

    #[test]
    fn remembers_only_session_cookies_and_preserves_security_attributes() {
        let session = Cookie::build(("test-session", "synthetic"))
            .domain(".jd.com")
            .path("/")
            .http_only(true)
            .secure(true)
            .same_site(cookie::SameSite::Strict)
            .build();
        assert!(remember_cookie(session.clone(), false).is_none());
        let remembered = remember_cookie(session, true).unwrap();
        assert_eq!(remembered.max_age(), Some(Duration::days(7)));
        assert_eq!(remembered.http_only(), Some(true));
        assert_eq!(remembered.secure(), Some(true));
        assert_eq!(remembered.same_site(), Some(cookie::SameSite::Strict));
        assert_eq!(remembered.domain(), Some("jd.com"));
        assert_eq!(remembered.path(), Some("/"));
        assert!(remember_cookie(remembered, true).is_none());
    }

    #[test]
    fn never_extends_expiring_or_deleted_cookies() {
        for cookie in [
            Cookie::parse("test=x; Max-Age=60").unwrap().into_owned(),
            Cookie::parse("test=; Max-Age=0").unwrap().into_owned(),
            Cookie::parse("test=x; Expires=Wed, 01 Jan 2031 00:00:00 GMT")
                .unwrap()
                .into_owned(),
            Cookie::parse("test=; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
                .unwrap()
                .into_owned(),
        ] {
            assert!(remember_cookie(cookie, true).is_none());
        }
    }
}
