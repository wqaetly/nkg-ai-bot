//! Local-only WebView2 restart regression probe. Never uses marketplace profiles.
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[path = "../src/commerce_session.rs"]
mod commerce_session;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "usage: commerce_session_probe <profile> <write|read|delete> <default|remember>"
    );
    let profile = PathBuf::from(&args[1]);
    let write = args[2] == "write";
    let remember = args[3] == "remember";
    let delete = args[2] == "delete";
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut request = [0u8; 8192];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]);
        let session = request.contains("nkg_session_probe=session-test");
        let persistent = request.contains("nkg_persistent_probe=persistent-test");
        println!("session_cookie={session} persistent_cookie={persistent}");
        let cookies = if write {
            "Set-Cookie: nkg_session_probe=session-test; HttpOnly; Path=/\r\nSet-Cookie: nkg_persistent_probe=persistent-test; Max-Age=3600; HttpOnly; Path=/\r\n"
        } else if delete {
            "Set-Cookie: nkg_session_probe=; Max-Age=0; HttpOnly; Path=/\r\n"
        } else {
            ""
        };
        let body = "<!doctype html><title>Local session persistence probe</title>";
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{cookies}Connection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        write || (session && persistent)
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let exit_code = Arc::new(AtomicI32::new(3));
    let result_code = exit_code.clone();
    tauri::Builder::default()
        .setup(move |app| {
            let builder = WebviewWindowBuilder::new(
                app,
                "session-probe",
                WebviewUrl::External(url.parse().unwrap()),
            )
            .visible(false)
            .data_directory(profile);
            let window = builder.build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let passed = server.join().unwrap();
                // Let Chromium commit cookies before clean shutdown.
                std::thread::sleep(Duration::from_secs(3));
                if remember {
                    println!(
                        "remembered={}",
                        commerce_session::remember_session_cookies(&window, |host| host
                            == "127.0.0.1")
                        .unwrap()
                    );
                }
                result_code.store(if passed { 0 } else { 2 }, Ordering::SeqCst);
                handle.exit(0);
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(25));
                handle.exit(3);
            });
            Ok(())
        })
        .run(context)
        .expect("run local session probe");
    std::process::exit(exit_code.load(Ordering::SeqCst));
}
