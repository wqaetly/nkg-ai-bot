use super::{encode_hex, unix_seconds, LanSyncOffer, ShareSession, PROTOCOL_VERSION};
use libc::{c_char, c_int, c_short, c_void};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    ptr,
    time::{Duration, Instant},
};

const SERVICE_TYPE: &str = "_nkg-sync._tcp";
const DNS_SERVICE_NO_ERROR: i32 = 0;
const DNS_SERVICE_FLAGS_ADD: u32 = 0x2;
const DNS_SERVICE_FLAGS_INCLUDE_P2P: u32 = 0x2_0000;
const POLL_IN: c_short = 0x0001;

type DNSServiceRef = *mut c_void;
type DNSServiceFlags = u32;
type DNSServiceErrorType = i32;

type RegisterCallback = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type BrowseCallback = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveCallback = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const CUchar,
    *mut c_void,
);
type CUchar = u8;

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

unsafe extern "C" {
    fn poll(fds: *mut PollFd, count: u32, timeout: c_int) -> c_int;
}

#[link(name = "dns_sd")]
unsafe extern "C" {
    fn DNSServiceRegister(
        sd_ref: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: Option<RegisterCallback>,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceBrowse(
        sd_ref: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: Option<BrowseCallback>,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceResolve(
        sd_ref: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: Option<ResolveCallback>,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceRefSockFD(sd_ref: DNSServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd_ref: DNSServiceRef) -> DNSServiceErrorType;
    fn DNSServiceRefDeallocate(sd_ref: DNSServiceRef);
}

pub struct BonjourRegistration {
    service_ref: DNSServiceRef,
}

unsafe impl Send for BonjourRegistration {}

impl BonjourRegistration {
    pub fn register(session: &ShareSession) -> Result<Self, String> {
        let service_type = c_string(SERVICE_TYPE)?;
        let service_name = c_string(&format!("NKG-{}", &session.session_id[..8]))?;
        let txt = encode_txt(&[
            ("v", PROTOCOL_VERSION.to_string()),
            ("sid", session.session_id.clone()),
            ("name", session.device_name.clone()),
            ("pk", encode_hex(&session.public_key)),
            ("exp", session.expires_at.to_string()),
        ])?;
        let mut service_ref = ptr::null_mut();
        let error = unsafe {
            DNSServiceRegister(
                &mut service_ref,
                DNS_SERVICE_FLAGS_INCLUDE_P2P,
                0,
                service_name.as_ptr(),
                service_type.as_ptr(),
                ptr::null(),
                ptr::null(),
                session.port.to_be(),
                txt.len() as u16,
                txt.as_ptr().cast(),
                Some(register_callback),
                ptr::null_mut(),
            )
        };
        if error != DNS_SERVICE_NO_ERROR || service_ref.is_null() {
            return Err(format!("无法发布 iOS Bonjour 同步服务（{error}）"));
        }
        Ok(Self { service_ref })
    }

    pub fn process_pending(&mut self) {
        if poll_service(self.service_ref, Duration::ZERO).unwrap_or(false) {
            let _ = unsafe { DNSServiceProcessResult(self.service_ref) };
        }
    }
}

impl Drop for BonjourRegistration {
    fn drop(&mut self) {
        if !self.service_ref.is_null() {
            unsafe { DNSServiceRefDeallocate(self.service_ref) };
        }
    }
}

#[derive(Clone)]
struct ServiceDescriptor {
    interface_index: u32,
    name: String,
    regtype: String,
    domain: String,
}

#[derive(Default)]
struct ResolvedService {
    host: String,
    port: u16,
    txt: HashMap<String, String>,
}

pub fn discover_sessions() -> Result<Vec<LanSyncOffer>, String> {
    let service_type = c_string(SERVICE_TYPE)?;
    let mut descriptors = Vec::<ServiceDescriptor>::new();
    let mut service_ref = ptr::null_mut();
    let error = unsafe {
        DNSServiceBrowse(
            &mut service_ref,
            DNS_SERVICE_FLAGS_INCLUDE_P2P,
            0,
            service_type.as_ptr(),
            ptr::null(),
            Some(browse_callback),
            (&mut descriptors as *mut Vec<ServiceDescriptor>).cast(),
        )
    };
    if error != DNS_SERVICE_NO_ERROR || service_ref.is_null() {
        return Err(format!("无法搜索 iOS Bonjour 同步服务（{error}）"));
    }
    process_for(service_ref, Duration::from_millis(1_250));
    unsafe { DNSServiceRefDeallocate(service_ref) };

    let mut offers = Vec::new();
    for descriptor in descriptors {
        if let Ok(resolved) = resolve_service(&descriptor) {
            if let Some(offer) = resolved_offer(resolved) {
                if !offers
                    .iter()
                    .any(|item: &LanSyncOffer| item.session_id == offer.session_id)
                {
                    offers.push(offer);
                }
            }
        }
    }
    Ok(offers)
}

fn resolve_service(descriptor: &ServiceDescriptor) -> Result<ResolvedService, String> {
    let name = c_string(&descriptor.name)?;
    let regtype = c_string(&descriptor.regtype)?;
    let domain = c_string(&descriptor.domain)?;
    let mut resolved = ResolvedService::default();
    let mut service_ref = ptr::null_mut();
    let error = unsafe {
        DNSServiceResolve(
            &mut service_ref,
            DNS_SERVICE_FLAGS_INCLUDE_P2P,
            descriptor.interface_index,
            name.as_ptr(),
            regtype.as_ptr(),
            domain.as_ptr(),
            Some(resolve_callback),
            (&mut resolved as *mut ResolvedService).cast(),
        )
    };
    if error != DNS_SERVICE_NO_ERROR || service_ref.is_null() {
        return Err(format!("无法解析 Bonjour 同步服务（{error}）"));
    }
    process_for(service_ref, Duration::from_millis(800));
    unsafe { DNSServiceRefDeallocate(service_ref) };
    if resolved.host.is_empty() || resolved.port == 0 {
        return Err("Bonjour 同步服务没有可连接地址".to_string());
    }
    Ok(resolved)
}

fn resolved_offer(resolved: ResolvedService) -> Option<LanSyncOffer> {
    let protocol = resolved.txt.get("v")?.parse::<u8>().ok()?;
    let expires_at = resolved.txt.get("exp")?.parse::<u64>().ok()?;
    if protocol != PROTOCOL_VERSION || expires_at <= unix_seconds() {
        return None;
    }
    Some(LanSyncOffer {
        kind: "nkg-sync-offer".to_string(),
        protocol,
        session_id: resolved.txt.get("sid")?.clone(),
        device_name: resolved.txt.get("name")?.clone(),
        host: resolved.host,
        port: resolved.port,
        public_key: resolved.txt.get("pk")?.clone(),
        expires_at,
    })
}

fn process_for(service_ref: DNSServiceRef, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match poll_service(service_ref, remaining.min(Duration::from_millis(180))) {
            Ok(true) => {
                if unsafe { DNSServiceProcessResult(service_ref) } != DNS_SERVICE_NO_ERROR {
                    break;
                }
            }
            Ok(false) => {}
            Err(_) => break,
        }
    }
}

fn poll_service(service_ref: DNSServiceRef, timeout: Duration) -> Result<bool, String> {
    let socket = unsafe { DNSServiceRefSockFD(service_ref) };
    if socket < 0 {
        return Err("Bonjour 服务套接字无效".to_string());
    }
    let mut descriptor = PollFd {
        fd: socket,
        events: POLL_IN,
        revents: 0,
    };
    let milliseconds = timeout.as_millis().min(c_int::MAX as u128) as c_int;
    let result = unsafe { poll(&mut descriptor, 1, milliseconds) };
    if result < 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(result > 0 && descriptor.revents & POLL_IN != 0)
    }
}

unsafe extern "C" fn register_callback(
    _service_ref: DNSServiceRef,
    _flags: DNSServiceFlags,
    _error: DNSServiceErrorType,
    _name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    _context: *mut c_void,
) {
}

unsafe extern "C" fn browse_callback(
    _service_ref: DNSServiceRef,
    flags: DNSServiceFlags,
    interface_index: u32,
    error: DNSServiceErrorType,
    service_name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    context: *mut c_void,
) {
    if error != DNS_SERVICE_NO_ERROR || flags & DNS_SERVICE_FLAGS_ADD == 0 || context.is_null() {
        return;
    }
    let Some(name) = read_c_string(service_name) else {
        return;
    };
    let Some(regtype) = read_c_string(regtype) else {
        return;
    };
    let Some(domain) = read_c_string(domain) else {
        return;
    };
    let descriptors = unsafe { &mut *context.cast::<Vec<ServiceDescriptor>>() };
    descriptors.push(ServiceDescriptor {
        interface_index,
        name,
        regtype,
        domain,
    });
}

unsafe extern "C" fn resolve_callback(
    _service_ref: DNSServiceRef,
    _flags: DNSServiceFlags,
    _interface_index: u32,
    error: DNSServiceErrorType,
    _fullname: *const c_char,
    host_target: *const c_char,
    port: u16,
    txt_len: u16,
    txt_record: *const CUchar,
    context: *mut c_void,
) {
    if error != DNS_SERVICE_NO_ERROR || context.is_null() {
        return;
    }
    let Some(host) = read_c_string(host_target) else {
        return;
    };
    let resolved = unsafe { &mut *context.cast::<ResolvedService>() };
    resolved.host = host;
    resolved.port = u16::from_be(port);
    resolved.txt = unsafe { parse_txt(txt_record, txt_len as usize) };
}

fn encode_txt(entries: &[(&str, String)]) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    for (key, value) in entries {
        let entry = format!("{key}={value}");
        if entry.is_empty() || entry.len() > u8::MAX as usize {
            return Err("Bonjour 同步元数据过长".to_string());
        }
        result.push(entry.len() as u8);
        result.extend_from_slice(entry.as_bytes());
    }
    Ok(result)
}

unsafe fn parse_txt(record: *const CUchar, length: usize) -> HashMap<String, String> {
    if record.is_null() || length == 0 {
        return HashMap::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(record, length) };
    let mut result = HashMap::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let item_length = bytes[offset] as usize;
        offset += 1;
        if item_length == 0 || offset + item_length > bytes.len() {
            break;
        }
        if let Ok(item) = std::str::from_utf8(&bytes[offset..offset + item_length]) {
            if let Some((key, value)) = item.split_once('=') {
                result.insert(key.to_string(), value.to_string());
            }
        }
        offset += item_length;
    }
    result
}

fn c_string(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Bonjour 文本包含无效字符".to_string())
}

fn read_c_string(value: *const c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .ok()
        .map(ToOwned::to_owned)
}
