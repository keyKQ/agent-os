//! Native notifications for tool-call approvals waiting on the user.
//!
//! An approval blocks the agent's turn until it is answered, so a request that
//! arrives while the window is in the background is dead time. The watcher
//! polls the gateway's own `/api/approvals` route and raises an OS
//! notification the first time it sees each pending request.
//!
//! Polling — rather than subscribing over the console's WebSocket — is a
//! deliberate trade. The RPC stream would be pushier, but consuming it means
//! reimplementing the handshake and protocol here, and the alternative of
//! injecting JavaScript into the console would require granting IPC to a
//! remote origin. On loopback, a poll every few seconds costs nothing.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::config::{self, GatewaySettings};
use crate::endpoint::Endpoint;
use crate::supervisor::{Phase, Supervisor};

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const IDLE_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Approval bodies quote the command being requested. Long ones are truncated
/// because notification centres clip silently and mid-word.
const BODY_LIMIT: usize = 160;

#[derive(Debug, Deserialize)]
struct ApprovalsResponse {
    #[serde(default)]
    pending: Vec<PendingApproval>,
}

#[derive(Debug, Deserialize)]
struct PendingApproval {
    id: String,
    #[serde(rename = "toolName", default)]
    tool_name: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    agent: String,
}

impl PendingApproval {
    fn title(&self) -> String {
        if self.tool_name.is_empty() {
            "AgentOS needs approval".to_string()
        } else {
            format!("Approve {}?", self.tool_name)
        }
    }

    fn body(&self) -> String {
        let detail = if self.command.is_empty() {
            "A tool call is waiting for your approval."
        } else {
            self.command.as_str()
        };
        let detail = truncate(detail, BODY_LIMIT);
        if self.agent.is_empty() {
            detail
        } else {
            format!("{} · {detail}", self.agent)
        }
    }
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let kept: String = value.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// A poll outcome, kept separate from the transport error so the loop can tell
/// "no approvals" from "cannot ask".
enum Poll {
    Pending(Vec<PendingApproval>),
    Unauthorized,
    Unavailable,
}

pub struct ApprovalWatcher {
    stopped: Arc<AtomicBool>,
}

impl ApprovalWatcher {
    pub fn spawn(app: AppHandle, supervisor: Supervisor) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = stopped.clone();
        std::thread::Builder::new()
            .name("agentos-approval-watcher".to_string())
            .spawn(move || watch(app, supervisor, flag))
            .expect("approval watcher thread should spawn");
        Self { stopped }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

fn watch(app: AppHandle, supervisor: Supervisor, stopped: Arc<AtomicBool>) {
    let mut notified: HashSet<String> = HashSet::new();
    let mut settings = config::load();
    let mut muted = false;

    while !stopped.load(Ordering::SeqCst) {
        let status = supervisor.status();
        let Some(endpoint) = status.endpoint.filter(|_| status.phase == Phase::Ready) else {
            // Nothing to poll. Drop what we have seen so a gateway restart
            // re-notifies for anything still pending afterwards.
            notified.clear();
            std::thread::sleep(IDLE_INTERVAL);
            continue;
        };

        match poll_once(&endpoint, &settings) {
            Poll::Pending(pending) => {
                muted = false;
                let live: HashSet<String> = pending.iter().map(|item| item.id.clone()).collect();

                for item in &pending {
                    if notified.insert(item.id.clone()) {
                        notify(&app, item);
                    }
                }
                // Forget resolved requests so the set tracks the queue rather
                // than growing for the life of the process.
                notified.retain(|id| live.contains(id));
                crate::tray::set_pending(&app, pending.len());
            }
            Poll::Unauthorized => {
                // The token may have been added or rotated since startup.
                let refreshed = config::load();
                let changed = refreshed.auth_token != settings.auth_token;
                settings = refreshed;
                if !changed && !muted {
                    muted = true;
                    log::warn!(
                        "approval notifications are off: the gateway requires a token and \
                         none is configured in {}",
                        config::config_path().display()
                    );
                }
            }
            Poll::Unavailable => {}
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

fn poll_once(endpoint: &Endpoint, settings: &GatewaySettings) -> Poll {
    let agent = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).build();
    let mut request = agent.get(&endpoint.approvals_url());
    if settings.requires_token() {
        match settings.auth_token.as_deref() {
            Some(token) => request = request.set("Authorization", &format!("Bearer {token}")),
            None => return Poll::Unauthorized,
        }
    }

    match request.call() {
        Ok(response) => match response.into_json::<ApprovalsResponse>() {
            Ok(parsed) => Poll::Pending(parsed.pending),
            Err(error) => {
                log::debug!("unreadable approvals payload: {error}");
                Poll::Unavailable
            }
        },
        Err(ureq::Error::Status(401 | 403, _)) => Poll::Unauthorized,
        Err(error) => {
            log::debug!("approvals poll failed: {error}");
            Poll::Unavailable
        }
    }
}

fn notify(app: &AppHandle, item: &PendingApproval) {
    if let Err(error) = app
        .notification()
        .builder()
        .title(item.title())
        .body(item.body())
        .show()
    {
        log::warn!("could not raise an approval notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(tool: &str, command: &str, agent: &str) -> PendingApproval {
        PendingApproval {
            id: "a1".to_string(),
            tool_name: tool.to_string(),
            command: command.to_string(),
            agent: agent.to_string(),
        }
    }

    #[test]
    fn parses_the_gateway_payload_shape() {
        let parsed: ApprovalsResponse = serde_json::from_str(
            r#"{"pending":[{"id":"x","toolName":"shell","command":"rm -rf build",
                "sessionKey":"s","agent":"main","argv":["rm","-rf","build"]}],
                "mode":"prompt","allowPatterns":[],"denyPatterns":[]}"#,
        )
        .expect("gateway payload should parse");

        assert_eq!(parsed.pending.len(), 1);
        assert_eq!(parsed.pending[0].tool_name, "shell");
    }

    #[test]
    fn an_empty_queue_parses() {
        let parsed: ApprovalsResponse =
            serde_json::from_str(r#"{"pending":[],"mode":"prompt"}"#).expect("should parse");
        assert!(parsed.pending.is_empty());
    }

    #[test]
    fn the_body_leads_with_the_agent_and_quotes_the_command() {
        let item = approval("shell", "rm -rf build", "researcher");
        assert_eq!(item.title(), "Approve shell?");
        assert_eq!(item.body(), "researcher · rm -rf build");
    }

    #[test]
    fn a_nameless_approval_still_reads_as_a_request() {
        let item = approval("", "", "");
        assert_eq!(item.title(), "AgentOS needs approval");
        assert_eq!(item.body(), "A tool call is waiting for your approval.");
    }

    #[test]
    fn long_commands_are_truncated_on_a_character_boundary() {
        let body = truncate(&"é".repeat(400), BODY_LIMIT);
        assert_eq!(body.chars().count(), BODY_LIMIT);
        assert!(body.ends_with('…'));
    }
}
