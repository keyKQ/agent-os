//! Choosing, probing, and addressing the loopback gateway.

use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::agentos_home;

pub const LOOPBACK: &str = "127.0.0.1";

/// The port `agentos gateway run` uses by default. Preferring it means a
/// desktop launch and a terminal launch land on the same URL, so bookmarks,
/// docs, and `agentos` CLI defaults keep working.
pub const DEFAULT_PORT: u16 = 18791;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub base_path: String,
}

impl Endpoint {
    pub fn new(port: u16, base_path: impl Into<String>) -> Self {
        Self {
            host: LOOPBACK.to_string(),
            port,
            base_path: base_path.into(),
        }
    }

    pub fn origin(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// The window's landing URL. The trailing slash matters: the Control UI's
    /// asset base is derived from it, and `/control` without it redirects.
    pub fn control_url(&self) -> String {
        format!("{}{}/", self.origin(), self.base_path)
    }

    /// Readiness rather than liveness — `/health` answers as soon as the ASGI
    /// app is mounted, while `/ready` stays 503 until the gateway has actually
    /// finished booting. Showing the window on liveness gives the user a
    /// half-initialized console.
    pub fn ready_url(&self) -> String {
        format!("{}/ready", self.origin())
    }

    pub fn approvals_url(&self) -> String {
        format!("{}/api/approvals", self.origin())
    }
}

/// Reserve a port for the gateway, preferring the conventional one.
///
/// There is an unavoidable race between releasing the probe listener and the
/// gateway binding: the check is a courtesy that keeps the common "port is
/// already taken" case out of the crash path, not a lock. A lost race surfaces
/// as a normal start failure with the bind error in the log.
pub fn pick_port() -> std::io::Result<u16> {
    if let Ok(listener) = TcpListener::bind((LOOPBACK, DEFAULT_PORT)) {
        drop(listener);
        return Ok(DEFAULT_PORT);
    }
    let listener = TcpListener::bind((LOOPBACK, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Where `agentos gateway start` records its managed background gateway.
pub fn pidfile_path() -> PathBuf {
    agentos_home()
        .join("state")
        .join("gateway")
        .join("gateway.json")
}

/// Where the desktop app records the gateway it started.
///
/// `agentos gateway run` — which is what the app spawns — writes no pidfile;
/// only the managed `gateway start` path does. So a gateway the app leaves
/// behind (SIGKILL, force quit, a power cut) would be invisible to the next
/// launch, which would then start a second gateway against the same SQLite
/// database. This record is what makes that survivor discoverable.
pub fn desktop_record_path() -> PathBuf {
    agentos_home()
        .join("state")
        .join("desktop")
        .join("gateway.json")
}

/// A gateway found already running, and whether this app can stop it.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub endpoint: Endpoint,
    /// Known only for gateways this app started in an earlier run. A gateway
    /// the operator launched from a terminal is deliberately left alone.
    pub pid: Option<u32>,
}

pub fn write_desktop_record(endpoint: &Endpoint, pid: u32) {
    let path = desktop_record_path();
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let record = serde_json::json!({
        "host": endpoint.host,
        "port": endpoint.port,
        "pid": pid,
    });
    if let Err(error) = std::fs::write(&path, record.to_string()) {
        log::warn!("could not record the desktop gateway: {error}");
    }
}

pub fn clear_desktop_record() {
    let path = desktop_record_path();
    if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::debug!("could not clear the desktop gateway record: {error}");
        }
    }
}

/// A gateway this machine already has running, if any.
///
/// Attaching instead of spawning is what keeps the desktop app and a
/// terminal-run gateway from fighting over the port and the SQLite database.
/// Both records only state intent, so the recorded port is probed before it is
/// trusted — a stale file from a crashed run must not strand the app.
///
/// The app's own record is checked first: adopting a gateway we started means
/// we know its pid and can restart it, while one the operator started from a
/// terminal is theirs to manage.
pub fn running_gateway(base_path: &str) -> Option<Discovered> {
    read_record(&desktop_record_path(), base_path, true)
        .or_else(|| read_record(&pidfile_path(), base_path, false))
}

fn read_record(path: &PathBuf, base_path: &str, keep_pid: bool) -> Option<Discovered> {
    let raw = std::fs::read_to_string(path).ok()?;
    let record: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let host = record.get("host").and_then(|value| value.as_str())?;
    if host != LOOPBACK && host != "localhost" {
        // A gateway bound to a public interface is not ours to adopt.
        return None;
    }
    let port = u16::try_from(record.get("port").and_then(|value| value.as_u64())?).ok()?;

    let endpoint = Endpoint::new(port, base_path);
    if !is_ready(&endpoint) {
        return None;
    }
    // Readiness proves the *port*, not the pid: after a reboot the record's
    // pid is dead while an operator's own `agentos gateway run` may answer on
    // the recorded port. Adopting that pid would label their gateway as ours
    // — Restart enabled — and eventually SIGTERM whatever process now holds
    // the number. A dead pid demotes the discovery to attach-only.
    let pid = keep_pid
        .then(|| record.get("pid").and_then(|value| value.as_u64()))
        .flatten()
        .and_then(|pid| u32::try_from(pid).ok())
        // pid 0 addresses the caller's own process group on unix, so a
        // corrupted record would pass the liveness probe and a later stop
        // would signal the app itself.
        .filter(|pid| *pid != 0 && crate::platform::pid_alive(*pid));
    Some(Discovered { endpoint, pid })
}

pub fn is_ready(endpoint: &Endpoint) -> bool {
    ureq::AgentBuilder::new()
        .timeout(PROBE_TIMEOUT)
        .build()
        .get(&endpoint.ready_url())
        .call()
        .is_ok()
}

/// Block until the gateway reports ready, or the deadline passes.
///
/// `cancelled` lets a quit request interrupt a slow first boot — a cold start
/// that has to build an index can outlast a user's patience, and a shell that
/// ignores Quit until the timeout expires reads as a hang.
pub fn wait_until_ready<F>(endpoint: &Endpoint, timeout: Duration, cancelled: F) -> bool
where
    F: Fn() -> bool,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cancelled() {
            return false;
        }
        if is_ready(endpoint) {
            return true;
        }
        std::thread::sleep(READY_POLL_INTERVAL);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_built_from_the_configured_mount() {
        let endpoint = Endpoint::new(18791, "/console");
        assert_eq!(endpoint.control_url(), "http://127.0.0.1:18791/console/");
        assert_eq!(endpoint.ready_url(), "http://127.0.0.1:18791/ready");
        assert_eq!(
            endpoint.approvals_url(),
            "http://127.0.0.1:18791/api/approvals"
        );
    }

    #[test]
    fn a_root_mount_still_produces_one_slash() {
        assert_eq!(
            Endpoint::new(9000, "").control_url(),
            "http://127.0.0.1:9000/"
        );
    }

    #[test]
    fn pick_port_falls_back_when_the_default_is_taken() {
        // Held for the whole test either way: if this bind succeeds the test
        // itself is the occupant, and if it fails some other process is. Both
        // leave the default port unavailable, which is the case under test.
        let holder = TcpListener::bind((LOOPBACK, DEFAULT_PORT));

        let port = pick_port().expect("a loopback port should always be available");
        assert_ne!(
            port, DEFAULT_PORT,
            "an occupied default must not be handed out"
        );
        assert_ne!(port, 0);

        drop(holder);
    }
}
