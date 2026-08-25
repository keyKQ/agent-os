//! Window lifecycle: the local splash, and the main window that hosts the
//! Control UI served by the loopback gateway.
//!
//! The Control UI is loaded over `http://127.0.0.1:<port>/` rather than bundled
//! as the Tauri frontend. It has to be: the gateway injects the SPA's asset
//! base and bootstrap context into `index.html` at request time, so a copy
//! served from the app bundle would boot without either. Loading it remotely
//! also means the desktop app tracks Control UI changes with no shim to keep
//! in sync.
//!
//! The consequence is that the main window hosts a remote origin, so it is
//! given no Tauri capability at all — see `capabilities/desktop-shell.json`.
//! Native features are driven from Rust instead of from injected JavaScript.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::endpoint::Endpoint;

pub const MAIN_WINDOW: &str = "main";
pub const SPLASH_WINDOW: &str = "splash";

const MAIN_TITLE: &str = "AgentOS";
const DEFAULT_SIZE: (f64, f64) = (1280.0, 860.0);
const MIN_SIZE: (f64, f64) = (880.0, 600.0);
const SPLASH_SIZE: (f64, f64) = (460.0, 280.0);

pub fn create_splash(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, SPLASH_WINDOW, WebviewUrl::App("index.html".into()))
        .title(MAIN_TITLE)
        .inner_size(SPLASH_SIZE.0, SPLASH_SIZE.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .decorations(false)
        .always_on_top(true)
        .build()
}

/// Show the Control UI, creating the window on first readiness and re-pointing
/// it on later ones.
///
/// A restart usually lands on the same port, but not always — an occupied
/// default sends the gateway to an ephemeral one — so the URL is compared
/// rather than assumed stable.
pub fn on_gateway_ready(app: &AppHandle, endpoint: &Endpoint) {
    let target = endpoint.control_url();
    let Ok(url) = Url::parse(&target) else {
        log::error!("gateway produced an unusable URL: {target}");
        return;
    };

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let needs_navigation = window
            .url()
            .map(|current| current.as_str() != target)
            .unwrap_or(true);
        if needs_navigation {
            if let Err(error) = window.navigate(url) {
                log::error!("could not point the window at {target}: {error}");
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Err(error) = create_main(app, url, endpoint.clone()) {
        log::error!("could not create the main window: {error}");
        return;
    }

    close_splash(app);
}

/// Leave the splash up on failure — it is the only surface that can explain
/// what went wrong, and an app that quietly exits looks like a crash.
pub fn on_gateway_failed(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
        let _ = splash.set_always_on_top(false);
        let _ = splash.show();
        let _ = splash.set_focus();
    }
}

fn create_main(app: &AppHandle, url: Url, endpoint: Endpoint) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();

    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
        .title(MAIN_TITLE)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        .visible(true)
        .on_navigation(move |url| {
            let allowed = is_gateway_url(url, &endpoint);
            if !allowed {
                hand_off(&handle, url);
            }
            allowed
        })
        .build()
}

/// True when a navigation target is the gateway this window belongs to.
///
/// Compared component by component. A `starts_with` on the origin string would
/// admit `http://127.0.0.1:187910/`, whose origin is a different port that
/// merely shares a prefix with ours.
fn is_gateway_url(url: &Url, endpoint: &Endpoint) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    url.scheme() == "http"
        && url.host_str() == Some(endpoint.host.as_str())
        && url.port() == Some(endpoint.port)
}

/// Send an off-origin navigation to the system browser.
///
/// This is a security boundary, not a convenience: the console renders model
/// output and tool results, so a link in a transcript can propose any
/// navigation it likes. Following one in-window would put a third-party origin
/// inside the app frame, where it inherits the window's trust in the user's
/// eyes. The browser at least shows an address bar.
fn hand_off(app: &AppHandle, url: &Url) {
    // Only web links are worth handing off; anything else — `file:`, a custom
    // scheme registered by some other app — is refused rather than passed to
    // the OS handler.
    if !matches!(url.scheme(), "http" | "https") {
        log::warn!("blocked in-window navigation to {url}");
        return;
    }
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        log::warn!("could not open {url} externally: {error}");
    }
}

/// Narrate supervisor state into the splash window.
///
/// Pushed by evaluating a call in the page rather than emitted over Tauri's
/// event bus, because listening for an event requires granting the window a
/// capability — and the whole point of this design is that the app grants
/// none, so the remote-origin main window cannot reach IPC either. The payload
/// is `serde_json`-encoded, so nothing from a gateway error message can escape
/// the literal it is embedded in.
pub fn push_status(app: &AppHandle, status: &crate::supervisor::Status) {
    let Some(splash) = app.get_webview_window(SPLASH_WINDOW) else {
        return;
    };
    let Ok(payload) = serde_json::to_string(status) else {
        return;
    };
    if let Err(error) = splash.eval(format!(
        "window.__agentosStatus && window.__agentosStatus({payload})"
    )) {
        log::debug!("could not update the splash window: {error}");
    }
}

fn close_splash(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
        let _ = splash.close();
    }
}

/// Bring the app forward, or hide it if it is already frontmost.
///
/// Bound to the global shortcut, where a press-to-show that cannot press-to-
/// hide leaves the user reaching for the mouse.
pub fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        focus_main(app);
        return;
    };

    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn focus_main(app: &AppHandle) {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .or_else(|| app.get_webview_window(SPLASH_WINDOW));
    if let Some(window) = window {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Route an `agentos://` deep link into the Control UI.
///
/// `agentos://sessions/abc` becomes `<control base>/sessions/abc`. The link's
/// own host is the first path segment, because a URL scheme with no authority
/// puts it there — `agentos://chat` parses with host `chat` and an empty path.
pub fn route_deep_link(app: &AppHandle, link: &Url, endpoint: &Endpoint) {
    let target = deep_link_target(link, endpoint);
    if let (Some(window), Ok(url)) = (app.get_webview_window(MAIN_WINDOW), Url::parse(&target)) {
        if let Err(error) = window.navigate(url) {
            log::error!("could not follow the deep link to {target}: {error}");
        }
    }
    focus_main(app);
}

fn deep_link_target(link: &Url, endpoint: &Endpoint) -> String {
    let mut route = String::new();
    if let Some(host) = link.host_str() {
        route.push_str(host);
    }
    let path = link.path().trim_start_matches('/');
    if !path.is_empty() {
        if !route.is_empty() {
            route.push('/');
        }
        route.push_str(path);
    }

    let mut target = format!("{}{}", endpoint.control_url(), route);
    if let Some(query) = link.query() {
        target.push('?');
        target.push_str(query);
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Url {
        Url::parse(raw).expect("test URL should parse")
    }

    fn endpoint() -> Endpoint {
        Endpoint::new(18791, "/control")
    }

    #[test]
    fn the_gateway_origin_is_allowed() {
        assert!(is_gateway_url(
            &parse("http://127.0.0.1:18791/control/sessions"),
            &endpoint()
        ));
    }

    #[test]
    fn a_port_that_merely_shares_a_prefix_is_refused() {
        // 18791 starts with 1879, so a `starts_with` on the origin string
        // would admit a gateway-shaped URL on an entirely different port.
        assert!(!is_gateway_url(
            &parse("http://127.0.0.1:18791/control/"),
            &Endpoint::new(1879, "/control")
        ));
    }

    #[test]
    fn other_hosts_and_schemes_are_refused() {
        assert!(!is_gateway_url(&parse("https://example.com/"), &endpoint()));
        assert!(!is_gateway_url(
            &parse("http://192.168.1.9:18791/control/"),
            &endpoint()
        ));
        assert!(!is_gateway_url(&parse("file:///etc/passwd"), &endpoint()));
    }

    #[test]
    fn deep_links_map_onto_the_control_mount() {
        assert_eq!(
            deep_link_target(&parse("agentos://sessions/abc?tab=tools"), &endpoint()),
            "http://127.0.0.1:18791/control/sessions/abc?tab=tools"
        );
        assert_eq!(
            deep_link_target(&parse("agentos://chat"), &endpoint()),
            "http://127.0.0.1:18791/control/chat"
        );
    }

    #[test]
    fn a_bare_deep_link_lands_on_the_console_root() {
        assert_eq!(
            deep_link_target(&parse("agentos://"), &endpoint()),
            "http://127.0.0.1:18791/control/"
        );
    }
}
