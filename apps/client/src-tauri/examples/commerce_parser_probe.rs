//! Local HTML fixtures in a real WebView. No marketplace requests or profiles.
use std::{io::{Read, Write}, net::TcpListener, path::PathBuf, sync::mpsc, time::Duration};
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 5, "usage: commerce_parser_probe <profile> <html> <provider> <output-json>");
    let profile = PathBuf::from(&args[1]);
    let html = std::fs::read_to_string(&args[2]).unwrap();
    let output = PathBuf::from(&args[4]);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break; };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut request = [0u8; 8192];
            if stream.read(&mut request).is_err() { continue; }
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
        }
    });
    let script = format!("{}\ncollectCommercePage({});",
        include_str!("../../../../packages/commerce-flow/src/browserCollector.js"),
        serde_json::json!({"provider": args[3], "callback": "https://nkg-commerce.invalid/probe"}));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(move |app| {
        let (sender, receiver) = mpsc::sync_channel(1);
        let window = WebviewWindowBuilder::new(app, "parser-probe", WebviewUrl::External(url.parse().unwrap()))
            .visible(false).inner_size(1100.0, 780.0).data_directory(profile)
            .initialization_script(&script)
            .on_navigation(move |target| {
                if target.host_str() == Some("nkg-commerce.invalid") {
                    if let Some((_, data)) = target.query_pairs().find(|(key, _)| key == "data") {
                        let _ = sender.try_send(data.into_owned());
                    }
                    return false;
                }
                target.host_str() == Some("127.0.0.1")
            }).build()?;
        assert!(!window.is_visible()?, "parser fixture must run without a visible window");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let result = receiver.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| "{\"status\":\"probe_timeout\"}".into());
            std::fs::write(output, &result).unwrap();
            println!("{result}");
            handle.exit(0);
        });
        Ok(())
    }).run(context).expect("run local parser probe");
}
