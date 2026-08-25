//! AgentOS desktop shell.
//!
//! The app is a supervisor with a window attached. It ships a relocatable
//! Python runtime with AgentOS already installed, starts a loopback gateway
//! from it, and points a webview at the Control UI that gateway serves. Nothing
//! is installed on the user's machine, and the same `~/.agentos` home is used
//! as the CLI, so a session started here is the same session `agentos chat`
//! sees.

mod approvals;
mod config;
mod endpoint;
mod platform;
mod runtime;
mod supervisor;
mod tray;
mod updater;
mod window;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use approvals::ApprovalWatcher;
use runtime::BundledRuntime;
use supervisor::Supervisor;

/// Toggles the window from anywhere. Deliberately not Cmd+Shift+A or
/// Cmd+Space: both are already spoken for on a stock macOS install, and a
/// shortcut that silently fails to register is worse than an unfamiliar one.
fn toggle_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyA)
}

pub fn run() {
    // Before anything spawns a thread: a thread inherits the signal mask of
    // whoever created it, so this is the only point at which blocking on the
    // main thread makes the mask process-wide. See platform::on_terminate.
    platform::block_terminate_signals();

    tauri::Builder::default()
        // Must be first: a second launch has to hand its arguments over and
        // exit before any other plugin has taken a lock or bound a port.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            window::focus_main(app);
            follow_deep_link_arguments(app, &argv);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("agentos-desktop".to_string()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // The updater plugin is registered in `setup`, not here: its
        // initializer deserializes `plugins.updater` eagerly and aborts the
        // whole app when the key is absent, which is exactly the shape of every
        // build that ships without update signing.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut == &toggle_shortcut() && event.state() == ShortcutState::Pressed {
                        window::toggle_main(app);
                    }
                })
                .build(),
        )
        .setup(setup)
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("the AgentOS desktop app should build")
        .run(|app, event| {
            // Cleanup belongs on Exit, not ExitRequested: by Exit the decision
            // to quit is final, so the gateway is never stopped for a quit the
            // user went on to cancel.
            if matches!(event, RunEvent::Exit) {
                if let Some(supervisor) = app.try_state::<Supervisor>() {
                    supervisor.shutdown();
                }
                if let Some(watcher) = app.try_state::<ApprovalWatcher>() {
                    watcher.stop();
                }
            }
        });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let supervisor = Supervisor::new();
    app.manage(supervisor.clone());

    if let Err(error) = window::create_splash(&handle) {
        log::error!("could not create the splash window: {error}");
    }
    if let Err(error) = tray::build(&handle) {
        log::error!("could not create the tray icon: {error}");
    }

    match BundledRuntime::load(&handle) {
        Ok(bundled) => {
            log::info!(
                "bundled AgentOS {} ({}, python {}, {} profile)",
                bundled.manifest.agentos_version,
                bundled.manifest.platform_tag,
                bundled.manifest.python_version,
                bundled.manifest.profile
            );
            supervisor.spawn(handle.clone(), bundled);
            app.manage(ApprovalWatcher::spawn(handle.clone(), supervisor));
        }
        Err(error) => {
            // Nothing this app does works without the runtime, and no retry
            // will conjure one, so say so plainly instead of leaving a splash
            // spinning forever.
            log::error!("bundled runtime unavailable: {error:#}");
            window::on_gateway_failed(&handle);
            handle
                .dialog()
                .message(format!(
                    "AgentOS is missing its bundled runtime and cannot start.\n\n{error}"
                ))
                .kind(MessageDialogKind::Error)
                .title("AgentOS")
                .blocking_show();
        }
    }

    register_terminate_handler(&handle);
    register_shortcut(&handle);
    register_deep_links(&handle);
    updater::install_plugin(&handle);
    updater::check_on_startup(handle);

    Ok(())
}

/// Stop the gateway when the OS asks this process to quit.
///
/// `RunEvent::Exit` only fires when Tauri's own event loop unwinds -- a menu
/// Quit, or `app.exit`. A SIGTERM from a logout, a `kill`, or a process manager
/// never reaches it, and the gateway would be left running with no window
/// attached to it.
fn register_terminate_handler(app: &AppHandle) {
    let handle = app.clone();
    platform::on_terminate(move || {
        log::info!("terminate signal received; stopping the gateway");
        if let Some(supervisor) = handle.try_state::<Supervisor>() {
            supervisor.shutdown();
        }
        handle.exit(0);
    });
}

fn register_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // A shortcut already claimed by another app is a papercut, not a failure:
    // the tray and the dock both still open the window.
    if let Err(error) = app.global_shortcut().register(toggle_shortcut()) {
        log::warn!("could not register the show/hide shortcut: {error}");
    }
}

fn register_deep_links(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            follow_deep_link(&handle, &url);
        }
    });
}

/// Windows and Linux deliver a deep link as a process argument rather than
/// through the open-url callback, so a second launch forwards its argv here.
fn follow_deep_link_arguments(app: &AppHandle, argv: &[String]) {
    for argument in argv.iter().skip(1) {
        if let Ok(url) = url::Url::parse(argument) {
            if url.scheme() == "agentos" {
                follow_deep_link(app, &url);
            }
        }
    }
}

fn follow_deep_link(app: &AppHandle, url: &url::Url) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    match supervisor.status().endpoint {
        Some(endpoint) => window::route_deep_link(app, url, &endpoint),
        // Arriving before the gateway is up is normal — the link is what
        // launched the app. Surfacing the window is the best available answer;
        // it lands on the console root once the gateway reports ready.
        None => window::focus_main(app),
    }
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    // Closing the window hides it rather than quitting: the gateway is a
    // background service, and a running agent should survive a stray Cmd+W.
    // Quit is explicit, from the tray or the app menu.
    if window.label() == window::MAIN_WINDOW {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Quit for real, from the tray.
pub fn quit(app: &AppHandle) {
    if let Some(supervisor) = app.try_state::<Supervisor>() {
        supervisor.shutdown();
    }
    app.exit(0);
}
