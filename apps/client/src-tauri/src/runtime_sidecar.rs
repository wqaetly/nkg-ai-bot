use std::{sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::{Host, Url};
use uuid::Uuid;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STARTUP_STDERR_BYTES: usize = 4_096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    base_url: String,
    token: String,
}

#[derive(Debug, Serialize)]
pub struct RuntimeCommandError {
    code: &'static str,
    message: String,
}

impl RuntimeCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Default)]
struct ProcessState {
    starting: bool,
    child: Option<CommandChild>,
    descriptor: Option<RuntimeDescriptor>,
}

#[derive(Debug, Default)]
pub struct RuntimeSidecarState {
    inner: Mutex<ProcessState>,
}

impl Drop for RuntimeSidecarState {
    fn drop(&mut self) {
        if let Ok(state) = self.inner.get_mut() {
            if let Some(child) = state.child.take() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct ReadyEvent {
    kind: String,
    url: String,
    port: u16,
}

#[tauri::command]
pub async fn runtime_sidecar_start(
    app: AppHandle,
    state: State<'_, RuntimeSidecarState>,
) -> Result<RuntimeDescriptor, RuntimeCommandError> {
    {
        let mut process = lock_state(&state)?;
        if let Some(descriptor) = &process.descriptor {
            return Ok(descriptor.clone());
        }
        if process.starting {
            return Err(RuntimeCommandError::new(
                "runtime.starting",
                "Runtime sidecar startup is already in progress",
            ));
        }
        process.starting = true;
    }

    let token = Uuid::new_v4().simple().to_string();
    let spawn_result = app.shell().sidecar("nkg-runtime").map(|command| {
        command
            .env("ANF_RUNTIME_TOKEN", &token)
            .env("ANF_HTTP_PORT", "0")
            .spawn()
    });

    let (mut receiver, child) = match spawn_result {
        Ok(Ok(spawned)) => spawned,
        Ok(Err(error)) | Err(error) => {
            reset_starting(&state);
            return Err(RuntimeCommandError::new(
                "runtime.spawn_failed",
                error.to_string(),
            ));
        }
    };
    let pid = child.pid();

    let ready = match tokio::time::timeout(STARTUP_TIMEOUT, wait_for_ready(&mut receiver)).await {
        Ok(Ok(event)) => event,
        Ok(Err(error)) => {
            let _ = child.kill();
            reset_starting(&state);
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill();
            reset_starting(&state);
            return Err(RuntimeCommandError::new(
                "runtime.startup_timeout",
                "Runtime sidecar did not report readiness within 15 seconds",
            ));
        }
    };

    let base_url = match validate_ready_event(&ready) {
        Ok(url) => url,
        Err(error) => {
            let _ = child.kill();
            reset_starting(&state);
            return Err(error);
        }
    };
    let descriptor = RuntimeDescriptor { base_url, token };

    {
        let mut process = lock_state(&state)?;
        process.starting = false;
        process.child = Some(child);
        process.descriptor = Some(descriptor.clone());
    }

    monitor_process(app, receiver, pid);
    Ok(descriptor)
}

#[tauri::command]
pub fn runtime_sidecar_stop(
    state: State<'_, RuntimeSidecarState>,
) -> Result<(), RuntimeCommandError> {
    let child = {
        let mut process = lock_state(&state)?;
        if process.starting {
            return Err(RuntimeCommandError::new(
                "runtime.starting",
                "Cannot stop the Runtime sidecar while startup is in progress",
            ));
        }
        process.descriptor = None;
        process.child.take()
    };

    if let Some(child) = child {
        child
            .kill()
            .map_err(|error| RuntimeCommandError::new("runtime.stop_failed", error.to_string()))?;
    }
    Ok(())
}

async fn wait_for_ready(
    receiver: &mut tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<ReadyEvent, RuntimeCommandError> {
    let mut stderr = String::new();

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let Ok(line) = std::str::from_utf8(&bytes) else {
                    continue;
                };
                let Ok(event) = serde_json::from_str::<ReadyEvent>(line.trim()) else {
                    continue;
                };
                if event.kind == "ready" {
                    return Ok(event);
                }
            }
            CommandEvent::Stderr(bytes) => {
                if stderr.len() < MAX_STARTUP_STDERR_BYTES {
                    let remaining = MAX_STARTUP_STDERR_BYTES - stderr.len();
                    stderr.push_str(&String::from_utf8_lossy(
                        &bytes[..bytes.len().min(remaining)],
                    ));
                }
            }
            CommandEvent::Error(message) => {
                return Err(RuntimeCommandError::new("runtime.process_error", message));
            }
            CommandEvent::Terminated(payload) => {
                return Err(RuntimeCommandError::new(
                    "runtime.exited_before_ready",
                    format!(
                        "Runtime sidecar exited before readiness (code: {:?}, signal: {:?}). {}",
                        payload.code,
                        payload.signal,
                        stderr.trim()
                    ),
                ));
            }
            _ => {}
        }
    }

    Err(RuntimeCommandError::new(
        "runtime.protocol_closed",
        "Runtime sidecar closed its event channel before readiness",
    ))
}

fn validate_ready_event(event: &ReadyEvent) -> Result<String, RuntimeCommandError> {
    let url = Url::parse(&event.url)
        .map_err(|error| RuntimeCommandError::new("runtime.invalid_ready", error.to_string()))?;
    let loopback = matches!(
        url.host(),
        Some(Host::Ipv4(address)) if address.is_loopback()
    ) || matches!(
        url.host(),
        Some(Host::Ipv6(address)) if address.is_loopback()
    );
    let valid = url.scheme() == "http"
        && loopback
        && url.port_or_known_default() == Some(event.port)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();

    if !valid {
        return Err(RuntimeCommandError::new(
            "runtime.invalid_ready",
            "Runtime sidecar reported a non-loopback or malformed endpoint",
        ));
    }

    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn monitor_process(
    app: AppHandle,
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    pid: u32,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            if matches!(event, CommandEvent::Terminated(_) | CommandEvent::Error(_)) {
                if let Ok(mut process) = app.state::<RuntimeSidecarState>().inner.lock() {
                    let is_current = process
                        .child
                        .as_ref()
                        .is_some_and(|child| child.pid() == pid);
                    if is_current {
                        process.child = None;
                        process.descriptor = None;
                        process.starting = false;
                    }
                }
                break;
            }
        }
    });
}

fn reset_starting(state: &State<'_, RuntimeSidecarState>) {
    if let Ok(mut process) = state.inner.lock() {
        process.starting = false;
    }
}

fn lock_state<'a>(
    state: &'a State<'_, RuntimeSidecarState>,
) -> Result<std::sync::MutexGuard<'a, ProcessState>, RuntimeCommandError> {
    state.inner.lock().map_err(|_| {
        RuntimeCommandError::new(
            "runtime.state_poisoned",
            "Runtime process state is unavailable",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_ready_event() {
        let event = ReadyEvent {
            kind: "ready".into(),
            url: "http://127.0.0.1:43123".into(),
            port: 43123,
        };
        assert_eq!(
            validate_ready_event(&event).expect("valid loopback URL"),
            "http://127.0.0.1:43123"
        );
    }

    #[test]
    fn rejects_remote_ready_event() {
        let event = ReadyEvent {
            kind: "ready".into(),
            url: "http://192.168.1.5:43123".into(),
            port: 43123,
        };
        assert!(validate_ready_event(&event).is_err());
    }

    #[test]
    fn rejects_port_mismatch() {
        let event = ReadyEvent {
            kind: "ready".into(),
            url: "http://127.0.0.1:43123".into(),
            port: 43124,
        };
        assert!(validate_ready_event(&event).is_err());
    }
}
