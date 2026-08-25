//! Owns the gateway process for the lifetime of the app.
//!
//! Responsibilities, in the order they matter to a user:
//!
//! 1. Adopt a gateway this machine is already running rather than starting a
//!    second one. Two gateways would contend for the port and the SQLite
//!    database, and the second would lose in ways that read as data loss.
//! 2. Otherwise start one from the bundled runtime and hold the window back
//!    until `/ready` answers, so nobody sees a half-booted console.
//! 3. Restart it if it dies, with enough accounting that a gateway which
//!    cannot start does not become an infinite respawn loop.
//! 4. Stop it on quit, gracefully first.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use crate::config::{self, agentos_home};
use crate::endpoint::{self, Endpoint};
use crate::platform;
use crate::runtime::BundledRuntime;

/// A cold first boot can be slow: the router loads an ONNX model and memory
/// may build an index. Generous, because the failure mode of being too strict
/// is telling a user their working install is broken.
const READY_TIMEOUT: Duration = Duration::from_secs(120);

/// Restart budget. More than this many starts inside the window means the
/// gateway is failing on startup rather than crashing occasionally, and
/// respawning it again only buries the real error deeper in the log.
const MAX_STARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(120);
const RESTART_BACKOFF: Duration = Duration::from_secs(2);

/// How often an adopted gateway is re-probed. It is not our child, so process
/// exit is not observable; polling is the only way to notice it went away.
const ADOPTED_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Starting,
    Ready,
    Restarting,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub phase: Phase,
    pub message: String,
    pub endpoint: Option<Endpoint>,
    /// Whether the gateway was already running and got adopted, rather than
    /// started by this app during this run. Surfaced in the tray so an
    /// unfamiliar port is explicable.
    pub adopted: bool,
    /// Whether this app is able to stop the gateway. False for one the
    /// operator started from a terminal: restarting it from a menu that gives
    /// no hint of that would kill a process they own.
    pub restartable: bool,
    pub log_path: String,
}

struct Inner {
    child: Mutex<Option<Child>>,
    /// Set while running against a gateway a previous run of this app left
    /// behind: not our child, but ours to stop.
    adopted_pid: Mutex<Option<u32>>,
    status: Mutex<Status>,
    shutting_down: AtomicBool,
    restart_requested: AtomicBool,
    log_path: PathBuf,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    pub fn new() -> Self {
        let log_path = gateway_log_path();
        Self {
            inner: Arc::new(Inner {
                child: Mutex::new(None),
                adopted_pid: Mutex::new(None),
                status: Mutex::new(Status {
                    phase: Phase::Starting,
                    message: "Starting AgentOS…".to_string(),
                    endpoint: None,
                    adopted: false,
                    restartable: true,
                    log_path: log_path.display().to_string(),
                }),
                shutting_down: AtomicBool::new(false),
                restart_requested: AtomicBool::new(false),
                log_path,
            }),
        }
    }

    pub fn status(&self) -> Status {
        self.inner.status.lock().expect("status lock").clone()
    }

    pub fn log_path(&self) -> PathBuf {
        self.inner.log_path.clone()
    }

    /// Start supervising on a background thread.
    ///
    /// Everything here blocks — process spawn, readiness polling, waiting on
    /// exit — so it must stay off the main thread, which is driving the UI.
    pub fn spawn(&self, app: AppHandle, runtime: BundledRuntime) {
        let supervisor = self.clone();
        std::thread::Builder::new()
            .name("agentos-gateway-supervisor".to_string())
            .spawn(move || supervisor.run(app, runtime))
            .expect("supervisor thread should spawn");
    }

    /// Ask for a restart. The running gateway is stopped; the supervision loop
    /// starts a fresh one without counting this against the restart budget.
    pub fn request_restart(&self) {
        self.inner.restart_requested.store(true, Ordering::SeqCst);
        self.stop_child();
    }

    /// Stop a gateway adopted from a previous run of this app.
    fn stop_adopted(&self) {
        let pid = self
            .inner
            .adopted_pid
            .lock()
            .expect("adopted pid lock")
            .take();
        if let Some(pid) = pid {
            platform::stop_pid(pid);
        }
    }

    /// Stop supervising and stop the gateway. Idempotent: quit paths can reach
    /// this from the tray, the window handler, and app exit.
    pub fn shutdown(&self) {
        if self.inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop_child();
        self.stop_adopted();
    }

    fn stop_child(&self) {
        let mut guard = self.inner.child.lock().expect("child lock");
        if let Some(mut child) = guard.take() {
            platform::stop_child(&mut child);
        }
        drop(guard);
        // Written only while a gateway of ours is running, so a clean stop must
        // retract it: a stale record would make the next launch probe a port
        // that some unrelated process may since have taken.
        endpoint::clear_desktop_record();
    }

    fn shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    fn publish(&self, app: &AppHandle, status: Status) {
        *self.inner.status.lock().expect("status lock") = status.clone();
        crate::tray::apply_status(app, &status);
        crate::window::push_status(app, &status);
    }

    fn run(self, app: AppHandle, runtime: BundledRuntime) {
        let mut starts: Vec<Instant> = Vec::new();

        while !self.shutting_down() {
            let settings = config::load();

            if let Some(found) = endpoint::running_gateway(&settings.base_path) {
                let endpoint = found.endpoint.clone();
                // A gateway left behind by an earlier run of this app carries a
                // pid we can act on; one the operator started from a terminal
                // does not, and is left alone.
                let ours = found.pid.is_some();
                *self.inner.adopted_pid.lock().expect("adopted pid lock") = found.pid;
                log::info!(
                    "adopted an already-running gateway on port {} ({})",
                    endpoint.port,
                    if ours {
                        "left by a previous run"
                    } else {
                        "started elsewhere"
                    }
                );

                self.publish(
                    &app,
                    Status {
                        phase: Phase::Ready,
                        message: if ours {
                            "Reconnected to the gateway left running by a previous session."
                                .to_string()
                        } else {
                            "Connected to the gateway already running on this machine.".to_string()
                        },
                        endpoint: Some(endpoint.clone()),
                        adopted: true,
                        restartable: ours,
                        log_path: self.inner.log_path.display().to_string(),
                    },
                );
                crate::window::on_gateway_ready(&app, &endpoint);

                while !self.shutting_down() && endpoint::is_ready(&endpoint) {
                    if self.inner.restart_requested.swap(false, Ordering::SeqCst) {
                        self.stop_adopted();
                        break;
                    }
                    std::thread::sleep(ADOPTED_POLL_INTERVAL);
                }
                *self.inner.adopted_pid.lock().expect("adopted pid lock") = None;
                if self.shutting_down() {
                    break;
                }
                // The adopted gateway went away. Loop round and start our own.
                starts.clear();
                continue;
            }

            starts.retain(|start| start.elapsed() < RESTART_WINDOW);
            if starts.len() >= MAX_STARTS {
                self.fail(
                    &app,
                    format!(
                        "The AgentOS gateway stopped {MAX_STARTS} times in a row. \
                         The last error is at the end of the log."
                    ),
                );
                return;
            }
            starts.push(Instant::now());

            match self.launch(&app, &runtime, &settings.base_path) {
                Ok(active) => {
                    self.publish(
                        &app,
                        Status {
                            phase: Phase::Ready,
                            message: "AgentOS is running.".to_string(),
                            endpoint: Some(active.clone()),
                            adopted: false,
                            restartable: true,
                            log_path: self.inner.log_path.display().to_string(),
                        },
                    );
                    crate::window::on_gateway_ready(&app, &active);
                    self.await_exit(&app);
                }
                Err(error) => {
                    log::error!("gateway launch failed: {error:#}");
                    self.publish(
                        &app,
                        Status {
                            phase: Phase::Restarting,
                            message: format!("{error}"),
                            endpoint: None,
                            adopted: false,
                            restartable: true,
                            log_path: self.inner.log_path.display().to_string(),
                        },
                    );
                }
            }

            if self.shutting_down() {
                break;
            }
            std::thread::sleep(RESTART_BACKOFF);
        }

        self.publish(
            &app,
            Status {
                phase: Phase::Stopped,
                message: "AgentOS stopped.".to_string(),
                endpoint: None,
                adopted: false,
                restartable: true,
                log_path: self.inner.log_path.display().to_string(),
            },
        );
    }

    fn launch(
        &self,
        app: &AppHandle,
        runtime: &BundledRuntime,
        base_path: &str,
    ) -> anyhow::Result<Endpoint> {
        let port = endpoint::pick_port()?;
        let active = Endpoint::new(port, base_path);

        self.publish(
            app,
            Status {
                phase: Phase::Starting,
                message: "Starting the AgentOS gateway…".to_string(),
                endpoint: Some(active.clone()),
                adopted: false,
                restartable: true,
                log_path: self.inner.log_path.display().to_string(),
            },
        );

        let log = open_log(&self.inner.log_path)?;
        let mut command = runtime.gateway_command(&active.host, active.port);
        command
            // A GUI app inherits an arbitrary working directory — `/` when
            // launched from Finder. Anchoring it at the AgentOS home makes
            // config discovery and relative paths deterministic.
            .current_dir(working_directory())
            .stdin(Stdio::null())
            .stderr(log.try_clone()?)
            .stdout(log);

        let child = command
            .spawn()
            .inspect(|child| {
                // Recorded before readiness, not after: a gateway that is booting
                // still holds the port and the database, so a launch that is
                // interrupted mid-boot must still leave a trail to find it by.
                endpoint::write_desktop_record(&active, child.id());
            })
            .map_err(|error| {
                anyhow::anyhow!(
                    "Could not start the bundled AgentOS runtime ({}): {error}",
                    runtime.python.display()
                )
            })?;
        *self.inner.child.lock().expect("child lock") = Some(child);

        if endpoint::wait_until_ready(&active, READY_TIMEOUT, || self.shutting_down()) {
            return Ok(active);
        }

        self.stop_child();
        if self.shutting_down() {
            return Err(anyhow::anyhow!("Startup cancelled."));
        }
        Err(anyhow::anyhow!(
            "The AgentOS gateway did not become ready within {} seconds.",
            READY_TIMEOUT.as_secs()
        ))
    }

    /// Block until the running gateway exits, then classify why.
    fn await_exit(&self, app: &AppHandle) {
        loop {
            {
                let mut guard = self.inner.child.lock().expect("child lock");
                match guard.as_mut() {
                    None => break,
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            guard.take();
                            log::warn!("gateway exited: {status}");
                            break;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            log::error!("could not wait on the gateway process: {error}");
                            guard.take();
                            break;
                        }
                    },
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        }

        if self.shutting_down() {
            return;
        }
        let requested = self.inner.restart_requested.swap(false, Ordering::SeqCst);
        self.publish(
            app,
            Status {
                phase: Phase::Restarting,
                message: if requested {
                    "Restarting the AgentOS gateway…".to_string()
                } else {
                    "The AgentOS gateway stopped. Restarting…".to_string()
                },
                endpoint: None,
                adopted: false,
                restartable: true,
                log_path: self.inner.log_path.display().to_string(),
            },
        );
    }

    fn fail(&self, app: &AppHandle, message: String) {
        log::error!("{message}");
        self.publish(
            app,
            Status {
                phase: Phase::Failed,
                message,
                endpoint: None,
                adopted: false,
                restartable: true,
                log_path: self.inner.log_path.display().to_string(),
            },
        );
        crate::window::on_gateway_failed(app);
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

/// Separate from the CLI's own `logs/gateway.log` so a desktop-launched
/// gateway and a terminal-launched one never interleave into one file.
fn gateway_log_path() -> PathBuf {
    agentos_home().join("logs").join("desktop-gateway.log")
}

fn working_directory() -> PathBuf {
    let home = agentos_home();
    let _ = std::fs::create_dir_all(&home);
    home
}

fn open_log(path: &PathBuf) -> anyhow::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(OpenOptions::new().create(true).append(true).open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_supervisor_reports_starting() {
        let supervisor = Supervisor::new();
        let status = supervisor.status();
        assert_eq!(status.phase, Phase::Starting);
        assert!(!status.adopted);
    }

    #[test]
    fn shutdown_is_idempotent() {
        let supervisor = Supervisor::new();
        supervisor.shutdown();
        supervisor.shutdown();
        assert!(supervisor.shutting_down());
    }

    #[test]
    fn the_desktop_log_is_not_the_cli_log() {
        assert!(gateway_log_path().ends_with("logs/desktop-gateway.log"));
    }

    #[test]
    fn phases_serialize_in_the_shape_the_splash_matches_on() {
        let rendered = serde_json::to_string(&Phase::Restarting).expect("phase should serialize");
        assert_eq!(rendered, "\"restarting\"");
    }
}
