// Read-only diagnostic for the application's configured default search service.
// Uses only its saved search key; never prints credentials or saves the vault.
use serde_json::{json, Value};
use std::{path::PathBuf, time::{Duration, Instant}};
use tauri_plugin_http::reqwest;

fn main() {
    if let Err(stage) = run() {
        eprintln!("diagnostic failed: {stage}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("local directory unavailable")?).join("com.nkg.ai.bot");
    let roaming = PathBuf::from(std::env::var_os("APPDATA").ok_or("app directory unavailable")?).join("com.nkg.ai.bot");
    let salt = local.join("stronghold-salt");
    let snapshot = roaming.join("secrets-auto.hold");
    if !salt.is_file() || !snapshot.is_file() { return Err("existing vault files required"); }
    let password = std::fs::read_to_string(local.join("vault-device.key")).map_err(|_| "device key unavailable")?;
    let hash = tauri_plugin_stronghold::kdf::KeyDerivation::argon2(password.trim(), &salt);
    let vault = tauri_plugin_stronghold::stronghold::Stronghold::new(snapshot, hash).map_err(|_| "vault load failed")?;
    let client = vault.load_client(b"nkg-ai-bot").map_err(|_| "vault client unavailable")?;
    let key = client.store().get(b"search:searxng:api-key").map_err(|_| "search key unavailable")?.ok_or("search key absent")?;
    let mut header = reqwest::header::HeaderValue::from_bytes(&key).map_err(|_| "search key invalid")?;
    header.set_sensitive(true);
    tauri::async_runtime::block_on(async move {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "http client failed")?;
        if std::env::args().any(|arg| arg == "--config") {
            let response = http.get("https://search.lfzxb.top/config").header("X-API-Key", header.clone())
                .send().await.map_err(|_| "config request failed")?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|_| "config response failed")?;
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| "config is not JSON")?;
            let engines = body.get("engines").and_then(Value::as_array).map(|rows| rows.iter()
                .filter(|row| row.get("categories").and_then(Value::as_array).is_some_and(|cats| cats.iter().any(|c| c == "general")))
                .map(|row| json!({"name":row.get("name"),"enabled":row.get("enabled"),"categories":row.get("categories")})).collect::<Vec<_>>());
            println!("{}", json!({"status":status,"generalEngines":engines}));
            return Ok(());
        }
        let alternative_engines = std::env::args().any(|arg| arg == "--alternatives");
        let queries = if alternative_engines { ["AMD 7500F", "AMD 7500F", "AMD 7500F"] }
            else { ["python", "AMD 7500F", "8000元 2K 游戏 编程 电脑配置"] };
        let mut outputs = Vec::new();
        for (index, query) in queries.into_iter().enumerate() {
            let start = Instant::now();
            let engine = if alternative_engines { ["bing", "qwant", "yahoo"][index] } else { "" };
            let mut request = http.get("https://search.lfzxb.top/search").query(&[("q", query), ("format", "json")]);
            if !engine.is_empty() { request = request.query(&[("engines", engine)]); }
            let response = request
                .header("Accept", "application/json").header("X-API-Key", header.clone()).send().await;
            let mut output = match response {
                Err(error) => json!({"query":query,"error":if error.is_timeout() {"timeout"} else {"transport_error"}}),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
                    let body = response.bytes().await.ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                    match body {
                        None => json!({"query":query,"status":status,"contentType":content_type,"json":false}),
                        Some(body) => {
                            let rows = body.get("results").and_then(Value::as_array);
                            let usable = rows.map(|rows| rows.iter().filter(|row| row.get("title").and_then(Value::as_str).is_some()
                                && row.get("url").and_then(Value::as_str).is_some_and(|url| reqwest::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")))).count());
                            json!({"query":query,"status":status,"contentType":content_type,
                                "elapsedSeconds":start.elapsed().as_secs_f64(),
                                "keys":body.as_object().map(|v| v.keys().cloned().collect::<Vec<_>>()),
                                "resultsCount":rows.map(Vec::len),"usableCount":usable,
                                "unresponsiveEngines":body.get("unresponsive_engines"),
                                "examples":rows.map(|r| r.iter().take(2).map(|r| json!({"title":r.get("title"),"engine":r.get("engine")})).collect::<Vec<_>>())})
                        }
                    }
                }
            };
            output["requestedEngine"] = json!(engine);
            println!("{}", output);
            outputs.push(output);
        }
        let report = if alternative_engines { "artifacts/diagnostics/searxng-alternatives-probe.json" } else { "artifacts/diagnostics/searxng-authenticated-probe.json" };
        std::fs::write(report, serde_json::to_vec_pretty(&outputs).map_err(|_| "diagnostic serialization failed")?)
            .map_err(|_| "diagnostic write failed")?;
        Ok(())
    })
}
