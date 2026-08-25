//! In-app updates.
//!
//! Updates are gated on the build actually carrying updater configuration.
//! Release builds inject a signing public key and endpoint; a developer build
//! and a distro-packaged build carry neither, and offering "Check for
//! Updates…" there would either error confusingly or fight the system package
//! manager. So the menu item explains itself instead.
//!
//! Payloads are whole-bundle, not deltas: the app ships a Python runtime and
//! ONNX models, so an update is a few hundred megabytes. That is why the
//! startup check is silent unless something is actually available, and why the
//! user is asked before anything downloads.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const TITLE: &str = "AgentOS";

/// Managed once the updater plugin has registered successfully.
///
/// Its presence is the only safe signal that `app.updater()` may be called:
/// that accessor resolves the plugin's managed state and **panics** when the
/// plugin is absent. With `panic = "abort"` in the release profile, a panic on
/// the update-check task takes the whole app down at launch — so a release
/// built with a malformed endpoint or public key would crash for every user,
/// not merely fail to find updates.
struct UpdaterReady;

/// True when this build was packaged with a signing key for update artifacts.
pub fn is_configured(app: &AppHandle) -> bool {
    serde_json::to_value(&app.config().plugins)
        .ok()
        .and_then(|plugins| plugins.get("updater").cloned())
        .and_then(|updater| updater.get("pubkey").cloned())
        .and_then(|pubkey| pubkey.as_str().map(str::to_owned))
        .is_some_and(|pubkey| !pubkey.trim().is_empty())
}

/// Register the updater plugin, but only on a build that can actually use it.
///
/// `tauri_plugin_updater`'s initializer deserializes `plugins.updater` eagerly
/// and returns an error when the key is missing, which `tauri::Builder::build`
/// turns into a panic. Since the committed configuration deliberately carries
/// no updater key — release CI injects one — registering it unconditionally at
/// build time aborts every developer and distro build on launch.
pub fn install_plugin(app: &AppHandle) {
    if !is_configured(app) {
        log::info!("no updater configuration; in-app updates are disabled for this build");
        return;
    }
    match app.plugin(tauri_plugin_updater::Builder::new().build()) {
        // Registration can still fail on a configuration the deserializer
        // rejects — an endpoint that is not https, a malformed public key. That
        // must degrade to "no in-app updates", never to a crash, so nothing
        // marks the updater ready and every caller below stays away from it.
        Err(error) => log::error!("could not initialize the updater: {error}"),
        Ok(()) => {
            app.manage(UpdaterReady);
        }
    }
}

/// True when the plugin registered and `app.updater()` is safe to call.
fn is_available(app: &AppHandle) -> bool {
    app.try_state::<UpdaterReady>().is_some()
}

/// Check once at launch, prompting only when there is something to install.
pub fn check_on_startup(app: AppHandle) {
    if !is_available(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        match fetch(&app).await {
            Ok(Some(update)) => prompt(app, update),
            Ok(None) => {}
            Err(error) => log::warn!("startup update check failed: {error}"),
        }
    });
}

/// Check because the user asked, which means every outcome needs a dialog.
pub fn check_interactively(app: AppHandle) {
    if !is_available(&app) {
        // Same wording whether the build carries no updater configuration or
        // carries one the plugin refused: from here the two are the same
        // outcome, and the refusal is already in the log with its reason.
        message(
            &app,
            "This build does not receive automatic updates.\n\nInstall a release build from \
             the AgentOS downloads page to get them.",
            MessageDialogKind::Info,
        );
        return;
    }

    tauri::async_runtime::spawn(async move {
        match fetch(&app).await {
            Ok(Some(update)) => prompt(app, update),
            Ok(None) => message(&app, "AgentOS is up to date.", MessageDialogKind::Info),
            Err(error) => message(
                &app,
                &format!("Could not check for updates:\n{error}"),
                MessageDialogKind::Error,
            ),
        }
    });
}

async fn fetch(
    app: &AppHandle,
) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    app.updater()?.check().await
}

fn prompt(app: AppHandle, update: tauri_plugin_updater::Update) {
    let version = update.version.clone();
    let handle = app.clone();

    // Reaching here means the endpoint answered, the payload parsed, and its
    // signature verified against the built-in public key -- everything that can
    // fail silently before a user ever sees a dialog.
    log::info!(
        "update {} available (currently {})",
        version,
        update.current_version
    );

    app.dialog()
        .message(format!(
            "AgentOS {version} is available.\n\nThe download replaces the whole app, including \
             its bundled runtime, so it is large. AgentOS will restart when it finishes."
        ))
        .title(TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download and Install".to_string(),
            "Later".to_string(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            tauri::async_runtime::spawn(async move {
                install(handle, update).await;
            });
        });
}

async fn install(app: AppHandle, update: tauri_plugin_updater::Update) {
    // The gateway holds the SQLite database and a listening socket, and the
    // installer is about to replace the interpreter running it. Stopping first
    // turns a possible mid-write replacement into an ordinary shutdown.
    if let Some(supervisor) = app.try_state::<crate::supervisor::Supervisor>() {
        supervisor.shutdown();
    }

    match update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        Ok(()) => app.restart(),
        Err(error) => {
            log::error!("update install failed: {error}");
            message(
                &app,
                &format!("The update could not be installed:\n{error}"),
                MessageDialogKind::Error,
            );
        }
    }
}

fn message(app: &AppHandle, body: &str, kind: MessageDialogKind) {
    app.dialog()
        .message(body)
        .title(TITLE)
        .kind(kind)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}
