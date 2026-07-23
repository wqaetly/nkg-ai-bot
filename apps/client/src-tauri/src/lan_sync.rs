use chacha20poly1305::{
    aead::{Aead, Payload},
    ChaCha20Poly1305, KeyInit, Nonce,
};
use rand::{rngs::OsRng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
use std::net::{SocketAddr, UdpSocket};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use x25519_dalek::{PublicKey, StaticSecret};

#[cfg(any(target_os = "ios", feature = "ios-bonjour-check"))]
mod ios_bonjour;
#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
mod non_ios_discovery;

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
const DISCOVERY_PORT: u16 = 47_654;
const PROTOCOL_VERSION: u8 = 1;
const MAX_BUNDLE_BYTES: usize = 128 * 1024 * 1024;
const SESSION_SECONDS: u64 = 10 * 60;

#[derive(Default)]
pub struct LanSyncState {
    current: Mutex<Option<Arc<ShareSession>>>,
}

struct ShareSession {
    session_id: String,
    pairing_code: String,
    device_name: String,
    payload: Vec<u8>,
    secret: [u8; 32],
    public_key: [u8; 32],
    port: u16,
    expires_at: u64,
    stopped: AtomicBool,
    transferred: AtomicBool,
    failed_attempts: AtomicU8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    session_id: String,
    pairing_code: String,
    port: u16,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    active: bool,
    transferred: bool,
    expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSyncOffer {
    kind: String,
    protocol: u8,
    session_id: String,
    device_name: String,
    host: String,
    port: u16,
    public_key: String,
    expires_at: u64,
}

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
#[derive(Deserialize)]
struct DiscoveryProbe {
    kind: String,
    protocol: u8,
}

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryOffer<'a> {
    kind: &'static str,
    protocol: u8,
    session_id: &'a str,
    device_name: &'a str,
    port: u16,
    public_key: String,
    expires_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    protocol: u8,
    session_id: String,
    client_public_key: String,
    proof: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferResponse {
    ok: bool,
    error: Option<String>,
    nonce: Option<String>,
    length: Option<usize>,
}

#[tauri::command]
pub fn lan_sync_start_share(
    state: tauri::State<'_, LanSyncState>,
    payload: String,
    device_name: String,
) -> Result<ShareInfo, String> {
    if payload.is_empty() || payload.len() > MAX_BUNDLE_BYTES {
        return Err("同步数据大小无效".to_string());
    }
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("无法启动局域网同步：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    #[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
    let udp_discovery = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT))
        .map_err(|error| format!("局域网发现端口不可用：{error}"))?;
    #[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
    udp_discovery
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let mut secret = [0_u8; 32];
    OsRng.fill_bytes(&mut secret);
    let public_key = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
    let mut session_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut session_bytes);
    let session_id = encode_hex(&session_bytes);
    let pairing_code = format!("{:06}", OsRng.gen_range(0..1_000_000_u32));
    let expires_at = unix_seconds().saturating_add(SESSION_SECONDS);
    let device_name = clean_device_name(&device_name);
    let session = Arc::new(ShareSession {
        session_id: session_id.clone(),
        pairing_code: pairing_code.clone(),
        device_name,
        payload: payload.into_bytes(),
        secret,
        public_key,
        port,
        expires_at,
        stopped: AtomicBool::new(false),
        transferred: AtomicBool::new(false),
        failed_attempts: AtomicU8::new(0),
    });
    #[cfg(any(target_os = "ios", feature = "ios-bonjour-check"))]
    let discovery = ios_bonjour::BonjourRegistration::register(&session)?;
    #[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
    let discovery = non_ios_discovery::NonIosDiscovery::register(udp_discovery, &session)?;

    let mut current = state
        .current
        .lock()
        .map_err(|_| "同步状态不可用".to_string())?;
    if let Some(previous) = current.replace(session.clone()) {
        previous.stopped.store(true, Ordering::Release);
    }
    thread::spawn(move || serve_session(session, listener, discovery));

    Ok(ShareInfo {
        session_id,
        pairing_code,
        port,
        expires_at,
    })
}

#[tauri::command]
pub fn lan_sync_cancel_share(state: tauri::State<'_, LanSyncState>) -> Result<(), String> {
    if let Some(session) = state
        .current
        .lock()
        .map_err(|_| "同步状态不可用".to_string())?
        .take()
    {
        session.stopped.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn lan_sync_share_status(state: tauri::State<'_, LanSyncState>) -> Result<ShareStatus, String> {
    let current = state
        .current
        .lock()
        .map_err(|_| "同步状态不可用".to_string())?;
    let Some(session) = current.as_ref() else {
        return Ok(ShareStatus {
            active: false,
            transferred: false,
            expires_at: None,
        });
    };
    let transferred = session.transferred.load(Ordering::Acquire);
    let active = !transferred
        && !session.stopped.load(Ordering::Acquire)
        && unix_seconds() < session.expires_at;
    Ok(ShareStatus {
        active,
        transferred,
        expires_at: Some(session.expires_at),
    })
}

#[tauri::command]
pub async fn lan_sync_discover() -> Result<Vec<LanSyncOffer>, String> {
    tauri::async_runtime::spawn_blocking(discover_sessions)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn lan_sync_receive(offer: LanSyncOffer, pairing_code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || receive_bundle(offer, pairing_code))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
fn serve_session(
    session: Arc<ShareSession>,
    listener: TcpListener,
    discovery: non_ios_discovery::NonIosDiscovery,
) {
    let mut buffer = [0_u8; 2048];
    while !session.stopped.load(Ordering::Acquire)
        && !session.transferred.load(Ordering::Acquire)
        && unix_seconds() < session.expires_at
    {
        match discovery.udp().recv_from(&mut buffer) {
            Ok((length, peer)) => {
                respond_to_probe(&session, discovery.udp(), peer, &buffer[..length])
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {}
        }
        match listener.accept() {
            Ok((stream, _)) => handle_transfer(&session, stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {}
        }
        thread::sleep(Duration::from_millis(35));
    }
    session.stopped.store(true, Ordering::Release);
}

#[cfg(any(target_os = "ios", feature = "ios-bonjour-check"))]
fn serve_session(
    session: Arc<ShareSession>,
    listener: TcpListener,
    mut discovery: ios_bonjour::BonjourRegistration,
) {
    while !session.stopped.load(Ordering::Acquire)
        && !session.transferred.load(Ordering::Acquire)
        && unix_seconds() < session.expires_at
    {
        discovery.process_pending();
        match listener.accept() {
            Ok((stream, _)) => handle_transfer(&session, stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {}
        }
        thread::sleep(Duration::from_millis(35));
    }
    session.stopped.store(true, Ordering::Release);
}

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
fn respond_to_probe(session: &ShareSession, socket: &UdpSocket, peer: SocketAddr, bytes: &[u8]) {
    let Ok(probe) = serde_json::from_slice::<DiscoveryProbe>(bytes) else {
        return;
    };
    if probe.kind != "nkg-sync-discover" || probe.protocol != PROTOCOL_VERSION {
        return;
    }
    let offer = DiscoveryOffer {
        kind: "nkg-sync-offer",
        protocol: PROTOCOL_VERSION,
        session_id: &session.session_id,
        device_name: &session.device_name,
        port: session.port,
        public_key: encode_hex(&session.public_key),
        expires_at: session.expires_at,
    };
    if let Ok(payload) = serde_json::to_vec(&offer) {
        let _ = socket.send_to(&payload, peer);
    }
}

fn handle_transfer(session: &ShareSession, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let request = {
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(length) if length <= 4096 => serde_json::from_str::<TransferRequest>(&line).ok(),
            _ => None,
        }
    };
    let Some(request) = request else {
        let _ = write_response(&mut stream, TransferResponse::error("同步请求无效"));
        return;
    };
    if request.protocol != PROTOCOL_VERSION || request.session_id != session.session_id {
        let _ = write_response(&mut stream, TransferResponse::error("同步会话已失效"));
        return;
    }
    let Some(client_public) = decode_array::<32>(&request.client_public_key) else {
        let _ = write_response(&mut stream, TransferResponse::error("接收设备密钥无效"));
        return;
    };
    let shared = StaticSecret::from(session.secret).diffie_hellman(&PublicKey::from(client_public));
    let expected = derive_material(
        b"nkg-sync-auth-v1",
        shared.as_bytes(),
        &session.pairing_code,
        &session.session_id,
    );
    let Some(received_proof) = decode_array::<32>(&request.proof) else {
        reject_attempt(session, &mut stream);
        return;
    };
    if !constant_time_equal(&expected, &received_proof) {
        reject_attempt(session, &mut stream);
        return;
    }

    let key = derive_material(
        b"nkg-sync-data-v1",
        shared.as_bytes(),
        &session.pairing_code,
        &session.session_id,
    );
    let cipher = ChaCha20Poly1305::new((&key).into());
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let Ok(ciphertext) = cipher.encrypt(
        Nonce::from_slice(&nonce_bytes),
        Payload {
            msg: &session.payload,
            aad: session.session_id.as_bytes(),
        },
    ) else {
        let _ = write_response(&mut stream, TransferResponse::error("同步数据加密失败"));
        return;
    };
    let header = TransferResponse {
        ok: true,
        error: None,
        nonce: Some(encode_hex(&nonce_bytes)),
        length: Some(ciphertext.len()),
    };
    if write_response(&mut stream, header).is_ok()
        && stream.write_all(&ciphertext).is_ok()
        && stream.flush().is_ok()
    {
        session.transferred.store(true, Ordering::Release);
    }
}

fn reject_attempt(session: &ShareSession, stream: &mut TcpStream) {
    let failures = session
        .failed_attempts
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
    let _ = write_response(stream, TransferResponse::error("配对码不正确"));
    if failures >= 5 {
        session.stopped.store(true, Ordering::Release);
    }
}

#[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
fn discover_sessions() -> Result<Vec<LanSyncOffer>, String> {
    let bonjour =
        thread::spawn(|| non_ios_discovery::discover_sessions(Duration::from_millis(1_450)));
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("无法启动局域网发现：{error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| error.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(180)))
        .map_err(|error| error.to_string())?;
    let probe =
        serde_json::json!({"kind":"nkg-sync-discover","protocol":PROTOCOL_VERSION}).to_string();
    let target = (Ipv4Addr::BROADCAST, DISCOVERY_PORT);
    let mut offers = Vec::<LanSyncOffer>::new();
    let mut buffer = [0_u8; 4096];
    for _ in 0..6 {
        let _ = socket.send_to(probe.as_bytes(), target);
        loop {
            match socket.recv_from(&mut buffer) {
                Ok((length, source)) => {
                    let Ok(mut offer) = serde_json::from_slice::<LanSyncOffer>(&buffer[..length])
                    else {
                        continue;
                    };
                    if offer.kind != "nkg-sync-offer"
                        || offer.protocol != PROTOCOL_VERSION
                        || offer.expires_at <= unix_seconds()
                    {
                        continue;
                    }
                    offer.host = source.ip().to_string();
                    if !offers
                        .iter()
                        .any(|item| item.session_id == offer.session_id)
                    {
                        offers.push(offer);
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    if let Ok(Ok(bonjour_offers)) = bonjour.join() {
        for offer in bonjour_offers {
            if !offers
                .iter()
                .any(|item| item.session_id == offer.session_id)
            {
                offers.push(offer);
            }
        }
    }
    Ok(offers)
}

#[cfg(any(target_os = "ios", feature = "ios-bonjour-check"))]
fn discover_sessions() -> Result<Vec<LanSyncOffer>, String> {
    ios_bonjour::discover_sessions()
}

fn receive_bundle(offer: LanSyncOffer, pairing_code: String) -> Result<String, String> {
    if offer.kind != "nkg-sync-offer"
        || offer.protocol != PROTOCOL_VERSION
        || offer.expires_at <= unix_seconds()
    {
        return Err("同步会话已失效，请重新搜索".to_string());
    }
    if pairing_code.len() != 6 || !pairing_code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("请输入发送设备显示的 6 位配对码".to_string());
    }
    let server_public =
        decode_array::<32>(&offer.public_key).ok_or_else(|| "发送设备密钥无效".to_string())?;
    let mut client_secret_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut client_secret_bytes);
    let client_secret = StaticSecret::from(client_secret_bytes);
    let client_public = PublicKey::from(&client_secret).to_bytes();
    let shared = client_secret.diffie_hellman(&PublicKey::from(server_public));
    let proof = derive_material(
        b"nkg-sync-auth-v1",
        shared.as_bytes(),
        &pairing_code,
        &offer.session_id,
    );
    let request = TransferRequest {
        protocol: PROTOCOL_VERSION,
        session_id: offer.session_id.clone(),
        client_public_key: encode_hex(&client_public),
        proof: encode_hex(&proof),
    };
    let mut stream = connect_to_offer(&offer)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(35)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|error| error.to_string())?;
    let mut request_bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    request_bytes.push(b'\n');
    stream
        .write_all(&request_bytes)
        .map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut header_line = String::new();
    reader
        .read_line(&mut header_line)
        .map_err(|error| error.to_string())?;
    if header_line.len() > 4096 {
        return Err("发送设备响应无效".to_string());
    }
    let header: TransferResponse =
        serde_json::from_str(&header_line).map_err(|_| "发送设备响应无效".to_string())?;
    if !header.ok {
        return Err(header
            .error
            .unwrap_or_else(|| "发送设备拒绝了同步".to_string()));
    }
    let length = header
        .length
        .filter(|length| *length <= MAX_BUNDLE_BYTES + 16)
        .ok_or_else(|| "同步数据大小无效".to_string())?;
    let nonce = header
        .nonce
        .as_deref()
        .and_then(decode_array::<12>)
        .ok_or_else(|| "同步数据随机数无效".to_string())?;
    let mut ciphertext = vec![0_u8; length];
    reader
        .read_exact(&mut ciphertext)
        .map_err(|error| format!("同步数据接收不完整：{error}"))?;
    let key = derive_material(
        b"nkg-sync-data-v1",
        shared.as_bytes(),
        &pairing_code,
        &offer.session_id,
    );
    let cipher = ChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: offer.session_id.as_bytes(),
            },
        )
        .map_err(|_| "同步数据校验失败，请重新配对".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "同步数据格式无效".to_string())
}

fn connect_to_offer(offer: &LanSyncOffer) -> Result<TcpStream, String> {
    let addresses = (offer.host.as_str(), offer.port)
        .to_socket_addrs()
        .map_err(|_| "发送设备地址无效".to_string())?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(6)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .map(|error| format!("无法连接发送设备：{error}"))
        .unwrap_or_else(|| "发送设备没有可连接的局域网地址".to_string()))
}

impl TransferResponse {
    fn error(message: &str) -> Self {
        Self {
            ok: false,
            error: Some(message.to_string()),
            nonce: None,
            length: None,
        }
    }
}

fn write_response(stream: &mut TcpStream, response: TransferResponse) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|error| error.to_string())
}

fn derive_material(label: &[u8], shared: &[u8; 32], code: &str, session_id: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(label);
    hash.update(shared);
    hash.update(code.as_bytes());
    hash.update(session_id.as_bytes());
    hash.finalize().into()
}

fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn clean_device_name(value: &str) -> String {
    let value = value.trim().chars().take(48).collect::<String>();
    if value.is_empty() {
        "NKG 设备".to_string()
    } else {
        value
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_array<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut result = [0_u8; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_keys_bind_shared_secret_code_and_session() {
        let shared = [7_u8; 32];
        let first = derive_material(b"nkg-sync-data-v1", &shared, "123456", "session-a");
        assert_ne!(
            first,
            derive_material(b"nkg-sync-data-v1", &shared, "654321", "session-a")
        );
        assert_ne!(
            first,
            derive_material(b"nkg-sync-data-v1", &shared, "123456", "session-b")
        );
    }

    #[test]
    fn hex_arrays_are_strictly_validated() {
        let value = [42_u8; 32];
        assert_eq!(decode_array::<32>(&encode_hex(&value)), Some(value));
        assert_eq!(decode_array::<32>("xyz"), None);
    }

    #[test]
    fn transfers_an_authenticated_encrypted_bundle() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind transfer listener");
        let port = listener.local_addr().expect("listener address").port();
        let mut secret = [0_u8; 32];
        OsRng.fill_bytes(&mut secret);
        let public_key = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let session = Arc::new(ShareSession {
            session_id: "test-session".to_string(),
            pairing_code: "042759".to_string(),
            device_name: "Test device".to_string(),
            payload: br#"{"format":"nkg-ai-bot-portable-backup"}"#.to_vec(),
            secret,
            public_key,
            port,
            expires_at: unix_seconds() + 60,
            stopped: AtomicBool::new(false),
            transferred: AtomicBool::new(false),
            failed_attempts: AtomicU8::new(0),
        });
        let server_session = session.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept receiver");
            handle_transfer(&server_session, stream);
        });
        let received = receive_bundle(
            LanSyncOffer {
                kind: "nkg-sync-offer".to_string(),
                protocol: PROTOCOL_VERSION,
                session_id: session.session_id.clone(),
                device_name: session.device_name.clone(),
                host: Ipv4Addr::LOCALHOST.to_string(),
                port,
                public_key: encode_hex(&session.public_key),
                expires_at: session.expires_at,
            },
            session.pairing_code.clone(),
        )
        .expect("receive encrypted payload");
        server.join().expect("join transfer server");
        assert_eq!(
            received,
            String::from_utf8(session.payload.clone()).unwrap()
        );
        assert!(session.transferred.load(Ordering::Acquire));
    }

    #[cfg(not(any(target_os = "ios", feature = "ios-bonjour-check")))]
    #[test]
    fn publishes_and_discovers_a_bonjour_compatible_service() {
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind discovery fallback");
        let session = Arc::new(ShareSession {
            session_id: "0123456789abcdef01234567".to_string(),
            pairing_code: "123456".to_string(),
            device_name: "Bonjour test device".to_string(),
            payload: b"test".to_vec(),
            secret: [3_u8; 32],
            public_key: [4_u8; 32],
            port: 47_777,
            expires_at: unix_seconds() + 60,
            stopped: AtomicBool::new(false),
            transferred: AtomicBool::new(false),
            failed_attempts: AtomicU8::new(0),
        });
        let _registration =
            non_ios_discovery::NonIosDiscovery::register(udp, &session).expect("register mDNS");
        let offers = non_ios_discovery::discover_sessions(Duration::from_millis(2_500))
            .expect("browse mDNS");
        let offer = offers
            .iter()
            .find(|offer| offer.session_id == session.session_id)
            .expect("discover registered service");
        assert_eq!(offer.device_name, session.device_name);
        assert_eq!(offer.port, session.port);
        assert_eq!(offer.public_key, encode_hex(&session.public_key));
    }
}
