use super::{encode_hex, unix_seconds, LanSyncOffer, ShareSession, PROTOCOL_VERSION};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::{
    collections::HashMap,
    net::UdpSocket,
    time::{Duration, Instant},
};

const SERVICE_TYPE: &str = "_nkg-sync._tcp.local.";

pub struct NonIosDiscovery {
    udp: UdpSocket,
    mdns: ServiceDaemon,
    fullname: String,
}

impl NonIosDiscovery {
    pub fn register(udp: UdpSocket, session: &ShareSession) -> Result<Self, String> {
        let daemon =
            ServiceDaemon::new().map_err(|error| format!("无法启动 Bonjour 兼容发现：{error}"))?;
        let instance = format!("NKG-{}", &session.session_id[..8]);
        let hostname = format!("nkg-{}.local.", &session.session_id[..8]);
        let properties = HashMap::from([
            ("v".to_string(), PROTOCOL_VERSION.to_string()),
            ("sid".to_string(), session.session_id.clone()),
            ("name".to_string(), session.device_name.clone()),
            ("pk".to_string(), encode_hex(&session.public_key)),
            ("exp".to_string(), session.expires_at.to_string()),
        ]);
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &instance,
            &hostname,
            "",
            session.port,
            properties,
        )
        .map_err(|error| format!("Bonjour 同步服务信息无效：{error}"))?
        .enable_addr_auto();
        let fullname = service.get_fullname().to_string();
        daemon
            .register(service)
            .map_err(|error| format!("无法发布 Bonjour 同步服务：{error}"))?;
        Ok(Self {
            udp,
            mdns: daemon,
            fullname,
        })
    }

    pub fn udp(&self) -> &UdpSocket {
        &self.udp
    }
}

impl Drop for NonIosDiscovery {
    fn drop(&mut self) {
        let _ = self.mdns.unregister(&self.fullname);
        let _ = self.mdns.shutdown();
    }
}

pub fn discover_sessions(wait: Duration) -> Result<Vec<LanSyncOffer>, String> {
    let daemon =
        ServiceDaemon::new().map_err(|error| format!("无法启动 Bonjour 兼容搜索：{error}"))?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|error| format!("无法搜索 Bonjour 同步服务：{error}"))?;
    let deadline = Instant::now() + wait;
    let mut offers = Vec::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = match receiver.recv_timeout(remaining.min(Duration::from_millis(220))) {
            Ok(event) => event,
            Err(_) => continue,
        };
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        let Some(offer) = resolved_offer(&info) else {
            continue;
        };
        if !offers
            .iter()
            .any(|item: &LanSyncOffer| item.session_id == offer.session_id)
        {
            offers.push(offer);
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    Ok(offers)
}

fn resolved_offer(info: &mdns_sd::ResolvedService) -> Option<LanSyncOffer> {
    let protocol = info.get_property_val_str("v")?.parse::<u8>().ok()?;
    let expires_at = info.get_property_val_str("exp")?.parse::<u64>().ok()?;
    if protocol != PROTOCOL_VERSION || expires_at <= unix_seconds() {
        return None;
    }
    let host = info
        .get_addresses_v4()
        .into_iter()
        .next()
        .map(|address| address.to_string())
        .unwrap_or_else(|| info.get_hostname().to_string());
    Some(LanSyncOffer {
        kind: "nkg-sync-offer".to_string(),
        protocol,
        session_id: info.get_property_val_str("sid")?.to_string(),
        device_name: info.get_property_val_str("name")?.to_string(),
        host,
        port: info.get_port(),
        public_key: info.get_property_val_str("pk")?.to_string(),
        expires_at,
    })
}
