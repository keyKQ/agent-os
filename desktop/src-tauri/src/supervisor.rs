//! Owns the gateway process for the lifetime of the app.
//!
//! Responsibilities, in the order they matter to a user:
//!
//! 1. Adopt a gateway this machine is already running rather than starting a
//!    second one. The gateway takes a pid lock over its state directory at
//!    boot, so a second instance against the same AgentOS home does not share
//!    the database — it exits within a fraction of a second. The cost of
//!    failing to adopt is therefore not corruption but a gateway nobody can
//!    reach: this app spawns a replacement that immediately dies, and the
//!    survivor is left running, orphaned, and no longer in any record.
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

/// How often a failed supervisor checks whether the user asked for another try.
/// Only a menu click ends that wait, so this trades nothing for being cheap.
const FAILED_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Accounting for automatic restarts, kept apart from the supervision loop so
/// the policy can be exercised without a gateway to supervise.
#[derive(Debug, Default)]
struct RestartBudget {
    starts: Vec<Instant>,
}

impl RestartBudget {
    /// Record an automatic (re)start. False once too many have happened inside
    /// the window, which means the gateway is failing on startup rather than
    /// crashing occasionally, and respawning it again only buries the real
    /// error deeper in the log.
    fn try_record(&mut self, now: Instant) -> bool {
        self.starts
            .retain(|start| now.saturating_duration_since(*start) < RESTART_WINDOW);
        if self.starts.len() >= MAX_STARTS {
            return false;
        }
        self.starts.push(now);
        true
    }

    /// Forget the history. A restart the operator asked for is not evidence of
    /// a broken gateway, and neither is a gateway that ran fine until it was
    /// adopted away.
    fn forgive(&mut self) {
        self.starts.clear();
    }
}

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
        let stopped = match guard.take() {
            Some(mut child) => {
                platform::stop_child(&mut child);
                true
            }
            None => false,
        };
        drop(guard);
        // Written only while a gateway of ours is running, so a clean stop must
        // retract it: a stale record would make the next launch probe a port
        // that some unrelated process may since have taken.
        //
        // Only when there really was a child, though. The record describes the
        // gateway *this* supervisor spawned, so retracting it without having
        // stopped anything deletes someone else's -- which is exactly what a
        // `cargo test` run used to do to a developer's running desktop app,
        // leaving its gateway alive and unfindable.
        if stopped {
            endpoint::clear_desktop_record();
        }
    }

    fn shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    /// True once the gateway child is gone.
    ///
    /// Readiness polling cannot tell "still booting" from "exited a moment
    /// ago" -- an unanswered probe looks identical either way -- so without
    /// this a gateway that refuses to start is waited on for the full
    /// `READY_TIMEOUT`. That is not a rare path: a second gateway against a
    /// state directory another one already holds is turned away by the pid
    /// lock within a fraction of a second.
    fn child_has_exited(&self) -> bool {
        let mut guard = self.inner.child.lock().expect("child lock");
        match guard.as_mut() {
            None => true,
            // A `try_wait` that errors leaves the child unobservable, which is
            // the same dead end as an exit and is how `await_exit` treats it.
            Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
        }
    }

    /// Block until the user asks for another try, or the app quits.
    ///
    /// `restart_requested` is only ever set by `request_restart`, whose sole
    /// caller is the tray menu, so waiting on it is waiting on a human -- and
    /// a human clicking a button is its own rate limit.
    fn wait_for_restart_request(&self) {
        while !self.shutting_down() {
            if self.inner.restart_requested.swap(false, Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(FAILED_POLL_INTERVAL);
        }
    }

    fn publish(&self, app: &AppHandle, status: Status) {
        *self.inner.status.lock().expect("status lock") = status.clone();
        crate::tray::apply_status(app, &status);
        crate::window::push_status(app, &status);
    }

    fn run(self, app: AppHandle, runtime: BundledRuntime) {
        let mut budget = RestartBudget::default();
        // Carried across an iteration because the accounting happens at the top
        // of the loop and the answer is only known at the bottom of the last
        // one: a restart the user asked for must not spend the crash budget.
        let mut by_request = false;

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
                budget.forgive();
                continue;
            }

            if by_request {
                // Not evidence of anything being broken, so it neither spends
                // the budget nor inherits one already spent.
                budget.forgive();
                by_request = false;
            }
            if !budget.try_record(Instant::now()) {
                self.fail(
                    &app,
                    format!(
                        "The AgentOS gateway stopped {MAX_STARTS} times in a row. \
                         The last error is at the end of the log."
                    ),
                );
                // Park rather than return. The tray keeps Restart enabled in
                // this phase, and a loop that has returned turns that into a
                // button which quietly does nothing -- leaving quitting the app
                // as the only way out of a state the user can often fix.
                self.wait_for_restart_request();
                if self.shutting_down() {
                    break;
                }
                budget.forgive();
                continue;
            }

            match self.launch(&app, &runtime, &settings) {
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
                    by_request = self.await_exit(&app);
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
        settings: &config::GatewaySettings,
    ) -> anyhow::Result<Endpoint> {
        let port = endpoint::pick_port()?;
        let active = Endpoint::new(port, &settings.base_path);

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
            // A GUI app inherits an arbitrary working directory -- `/` when
            // launched from Finder. Anchoring it at the configured workspace
            // makes config discovery deterministic and, more importantly, lines
            // `Path.cwd()` up with `workspace_dir`: several tools fall back to
            // the process cwd when a call carries no workspace of its own, and
            // pointing that at the AgentOS home would have let the agent write
            // among config.toml, .env, and state/.
            .current_dir(working_directory(&settings.workspace_dir))
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

        if endpoint::wait_until_ready(&active, READY_TIMEOUT, || {
            self.shutting_down() || self.child_has_exited()
        }) {
            return Ok(active);
        }

        // Read before stopping, which drops the child and would make every
        // failure look like an early exit.
        let exited_early = self.child_has_exited();
        self.stop_child();
        if self.shutting_down() {
            return Err(anyhow::anyhow!("Startup cancelled."));
        }
        if exited_early {
            // Deliberately not the timeout wording: a gateway that refused to
            // start has a reason waiting in the log, and telling the user to
            // wait longer sends them looking for a problem that is not there.
            return Err(anyhow::anyhow!(
                "The AgentOS gateway stopped before it finished starting. \
                 The reason is at the end of the log."
            ));
        }
        Err(anyhow::anyhow!(
            "The AgentOS gateway did not become ready within {} seconds.",
            READY_TIMEOUT.as_secs()
        ))
    }

    /// Block until the running gateway exits, then classify why.
    ///
    /// Returns whether the exit was one the user asked for, which decides
    /// whether the next start counts against the crash budget.
    fn await_exit(&self, app: &AppHandle) -> bool {
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
            return false;
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
        requested
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

/// The gateway's working directory: the configured workspace, created if it
/// does not exist yet. Falls back to the AgentOS home only if the workspace
/// cannot be created, since a non-existent cwd fails the spawn outright.
fn working_directory(workspace: &PathBuf) -> PathBuf {
    if std::fs::create_dir_all(workspace).is_ok() {
        return workspace.clone();
    }
    log::warn!("could not create the workspace {}", workspace.display());
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

    #[test]
    fn a_supervisor_with_no_child_counts_as_exited() {
        // The launch path asks this while waiting for readiness, so "there is
        // nothing to wait for" has to answer the same way as "it has stopped".
        assert!(Supervisor::new().child_has_exited());
    }

    /// Kill and reap whatever the supervisor is holding, without going through
    /// `shutdown`: that path also clears the desktop record, which on a
    /// developer's machine is a real file belonging to a real running app.
    #[cfg(unix)]
    fn discard_child(supervisor: &Supervisor) {
        let mut guard = supervisor.inner.child.lock().expect("child lock");
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.take();
    }

    #[cfg(unix)]
    #[test]
    fn a_gateway_that_exits_during_boot_is_noticed() {
        // The regression this guards is the expensive one: readiness polling
        // alone cannot see an exit, so a gateway that refuses to start used to
        // be waited on for the full two-minute timeout before anyone found out.
        let supervisor = Supervisor::new();
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 3"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("/bin/sh should spawn");
        *supervisor.inner.child.lock().expect("child lock") = Some(child);

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if supervisor.child_has_exited() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        discard_child(&supervisor);
        panic!("a gateway that had already exited was still reported as running");
    }

    #[cfg(unix)]
    #[test]
    fn a_gateway_still_booting_is_not_mistaken_for_a_dead_one() {
        // The other half: a slow cold start must still get its full timeout.
        let supervisor = Supervisor::new();
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("/bin/sh should spawn");
        *supervisor.inner.child.lock().expect("child lock") = Some(child);

        let still_running = !supervisor.child_has_exited();
        discard_child(&supervisor);
        assert!(still_running, "a live gateway must not be given up on");
    }

    #[test]
    fn the_budget_gives_up_after_enough_starts_in_the_window() {
        let mut budget = RestartBudget::default();
        let now = Instant::now();

        for attempt in 0..MAX_STARTS {
            assert!(budget.try_record(now), "start {attempt} should be allowed");
        }
        assert!(
            !budget.try_record(now),
            "a gateway failing this fast must not be respawned again"
        );
    }

    #[test]
    fn starts_older_than_the_window_stop_counting() {
        // The regression this guards: while a failed launch took longer than
        // the window, every previous start aged out before it could be counted
        // and the budget could never be reached at all.
        let mut budget = RestartBudget::default();
        let now = Instant::now();
        for _ in 0..MAX_STARTS {
            budget.try_record(now);
        }

        let later = now + RESTART_WINDOW + Duration::from_secs(1);
        assert!(budget.try_record(later));
    }

    #[test]
    fn a_restart_the_user_asked_for_does_not_spend_the_budget() {
        let mut budget = RestartBudget::default();
        let now = Instant::now();
        for _ in 0..MAX_STARTS {
            budget.try_record(now);
        }

        budget.forgive();

        assert!(
            budget.try_record(now),
            "clicking Restart must not be able to exhaust the crash budget"
        );
    }
}
