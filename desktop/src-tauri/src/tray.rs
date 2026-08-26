//! Menu-bar / system-tray presence.
//!
//! The tray is where the app admits what it is: a supervised background
//! service with a window attached. Gateway state, a restart, the log file, and
//! quit all live here, so none of them depend on the Control UI being
//! reachable — which is exactly when a user needs them.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::supervisor::{Phase, Status, Supervisor};

pub const TRAY_ID: &str = "agentos";

const ITEM_OPEN: &str = "open";
const ITEM_STATUS: &str = "status";
const ITEM_RESTART: &str = "restart";
const ITEM_LOGS: &str = "logs";
const ITEM_AUTOSTART: &str = "autostart";
const ITEM_UPDATE: &str = "update";
const ITEM_QUIT: &str = "quit";

// macOS renders menu-bar icons from their alpha channel, recoloring for light
// and dark menu bars, so it gets the black template. Everywhere else the icon
// is drawn as-is and a black mark would vanish into a dark taskbar.
#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-color.png");

/// Handles kept so the menu can be updated after it is built.
struct TrayItems {
    status: MenuItem<Wry>,
    restart: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ITEM_OPEN, "Open AgentOS", true, None::<&str>)?;
    let status = MenuItem::with_id(app, ITEM_STATUS, "Starting…", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, ITEM_RESTART, "Restart Gateway", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, ITEM_LOGS, "Open Log File", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        ITEM_AUTOSTART,
        "Launch at Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, ITEM_UPDATE, "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quit AgentOS", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &restart,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    app.manage(TrayItems {
        status,
        restart,
        autostart,
    });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("AgentOS")
        .menu(&menu)
        // Left click opens the app; the menu stays on the right button, which
        // is what a menu-bar utility is expected to do on every platform.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::window::focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        ITEM_OPEN => crate::window::focus_main(app),
        ITEM_RESTART => {
            if let Some(supervisor) = app.try_state::<Supervisor>() {
                supervisor.request_restart();
            }
        }
        ITEM_LOGS => open_log(app),
        ITEM_AUTOSTART => toggle_autostart(app),
        ITEM_UPDATE => crate::updater::check_interactively(app.clone()),
        ITEM_QUIT => crate::quit(app),
        _ => {}
    }
}

fn open_log(app: &AppHandle) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    let path = supervisor.log_path();
    if !path.exists() {
        app.dialog()
            .message("No gateway log has been written yet.")
            .kind(MessageDialogKind::Info)
            .title("AgentOS")
            .blocking_show();
        return;
    }
    if let Err(error) = app.opener().open_path(path.to_string_lossy(), None::<&str>) {
        log::warn!("could not open the log file: {error}");
    }
}

fn toggle_autostart(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else {
        return;
    };
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);

    let result = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };

    match result {
        Ok(()) => {
            let _ = items.autostart.set_checked(!enabled);
        }
        Err(error) => {
            log::warn!("could not change the launch-at-login setting: {error}");
            // Put the checkbox back where the OS actually left it rather than
            // where the click implied.
            let _ = items
                .autostart
                .set_checked(manager.is_enabled().unwrap_or(enabled));
            app.dialog()
                .message(format!("Could not change Launch at Login:\n{error}"))
                .kind(MessageDialogKind::Error)
                .title("AgentOS")
                .blocking_show();
        }
    }
}

/// Mirror supervisor state into the menu.
pub fn apply_status(app: &AppHandle, status: &Status) {
    let Some(items) = app.try_state::<TrayItems>() else {
        return;
    };
    let _ = items.status.set_text(status_label(status));
    let _ = items.restart.set_enabled(status.restartable);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(status)));
    }
}

fn status_label(status: &Status) -> String {
    match status.phase {
        Phase::Starting => "Starting…".to_string(),
        // Two different situations, and the menu has to distinguish them: the
        // Restart item is enabled for one and not the other, so labelling both
        // "Attached" would make that difference look arbitrary.
        Phase::Ready if status.adopted => {
            let word = if status.restartable {
                // A gateway this app started in an earlier run and can stop.
                "Reconnected"
            } else {
                // Someone else's, started from a terminal. Not ours to restart.
                "Attached"
            };
            match &status.endpoint {
                Some(endpoint) => format!("{word} · port {}", endpoint.port),
                None => word.to_string(),
            }
        }
        Phase::Ready => match &status.endpoint {
            Some(endpoint) => format!("Running · port {}", endpoint.port),
            None => "Running".to_string(),
        },
        Phase::Restarting => "Restarting…".to_string(),
        Phase::Failed => "Stopped — see the log".to_string(),
        Phase::Stopped => "Stopped".to_string(),
    }
}

fn tooltip(status: &Status) -> String {
    format!("AgentOS — {}", status_label(status))
}

/// Show the number of approvals waiting, so a background app can still say it
/// needs something.
pub fn set_pending(app: &AppHandle, pending: usize) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let base = app
        .try_state::<Supervisor>()
        .map(|supervisor| tooltip(&supervisor.status()))
        .unwrap_or_else(|| "AgentOS".to_string());

    let tooltip = match pending {
        0 => base,
        1 => format!("{base} · 1 approval waiting"),
        many => format!("{base} · {many} approvals waiting"),
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::Endpoint;

    fn status(phase: Phase, adopted: bool, port: Option<u16>) -> Status {
        restartable_status(phase, adopted, port, !adopted)
    }

    fn restartable_status(
        phase: Phase,
        adopted: bool,
        port: Option<u16>,
        restartable: bool,
    ) -> Status {
        Status {
            phase,
            message: String::new(),
            endpoint: port.map(|port| Endpoint::new(port, "/control")),
            adopted,
            restartable,
            log_path: String::new(),
        }
    }

    #[test]
    fn a_running_gateway_shows_its_port() {
        let label = status_label(&status(Phase::Ready, false, Some(18791)));
        assert_eq!(label, "Running · port 18791");
    }

    #[test]
    fn a_gateway_started_elsewhere_reads_as_attached() {
        // Not ours to stop, and the Restart item is disabled to match.
        let label = status_label(&restartable_status(Phase::Ready, true, Some(9000), false));
        assert_eq!(label, "Attached · port 9000");
    }

    #[test]
    fn a_gateway_left_by_a_previous_run_reads_as_reconnected() {
        // This one the app can stop, so the label must not claim otherwise --
        // an enabled Restart under an "Attached" label looks arbitrary.
        let label = status_label(&restartable_status(Phase::Ready, true, Some(9000), true));
        assert_eq!(label, "Reconnected · port 9000");
    }

    #[test]
    fn failure_points_at_the_log() {
        assert_eq!(
            status_label(&status(Phase::Failed, false, None)),
            "Stopped — see the log"
        );
    }

    #[test]
    fn the_tooltip_is_prefixed_with_the_product_name() {
        assert!(tooltip(&status(Phase::Starting, false, None)).starts_with("AgentOS — "));
    }
}
