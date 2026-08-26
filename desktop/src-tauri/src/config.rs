//! The subset of AgentOS configuration the shell has to agree with the gateway on.
//!
//! The desktop app deliberately does not own the gateway's configuration: it
//! spawns the gateway against the user's existing `config.toml`, so a session
//! started from the app and one started from `agentos gateway run` are the same
//! session. Three settings still have to be read on this side:
//!
//! * `control_ui.base_path` — where to point the window. Everything under it is
//!   exempt from the auth middleware, but `/` is not, so the shell cannot rely
//!   on the root redirect to discover it.
//! * `auth.mode` / `auth.token` — whether the approvals poller must present a
//!   credential to `/api/approvals`.
//!
//! Resolution mirrors `GatewayConfig.load` plus pydantic-settings precedence:
//! environment variables override the TOML, and the TOML is discovered at
//! `$AGENTOS_GATEWAY_CONFIG_PATH`, else `<agentos home>/config.toml`.

use std::path::PathBuf;

pub const DEFAULT_BASE_PATH: &str = "/control";

#[derive(Debug, Clone)]
pub struct GatewaySettings {
    pub base_path: String,
    pub auth_mode: String,
    pub auth_token: Option<String>,
    /// Mirrors `GatewayConfig.workspace_dir`, whose default is
    /// `<agentos home>/workspace`. The shell needs it because it chooses the
    /// gateway's working directory, and several tools fall back to
    /// `Path.cwd()` when a call carries no workspace of its own.
    pub workspace_dir: PathBuf,
}

impl Default for GatewaySettings {
    fn default() -> Self {
        Self {
            base_path: DEFAULT_BASE_PATH.to_string(),
            auth_mode: "none".to_string(),
            auth_token: None,
            workspace_dir: agentos_home().join("workspace"),
        }
    }
}

impl GatewaySettings {
    /// True when `/api/*` requires a credential the poller may not have.
    pub fn requires_token(&self) -> bool {
        self.auth_mode == "token"
    }
}

/// The AgentOS state root: `$AGENTOS_STATE_DIR`, else `$HOME/.agentos`.
///
/// Mirrors `agentos.paths.default_agentos_home` so the shell and the gateway
/// agree on where the pidfile and configuration live.
pub fn agentos_home() -> PathBuf {
    if let Some(raw) = std::env::var_os("AGENTOS_STATE_DIR") {
        let trimmed = raw.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return expand_home(&trimmed);
        }
    }
    home_dir().join(".agentos")
}

pub fn config_path() -> PathBuf {
    if let Some(raw) = std::env::var_os("AGENTOS_GATEWAY_CONFIG_PATH") {
        let trimmed = raw.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return expand_home(&trimmed);
        }
    }
    agentos_home().join("config.toml")
}

pub fn load() -> GatewaySettings {
    let from_file = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| raw.parse::<toml::Table>().ok())
        .map(settings_from_toml)
        .unwrap_or_default();
    apply_env_overrides(from_file, |key| std::env::var(key).ok())
}

fn settings_from_toml(table: toml::Table) -> GatewaySettings {
    let mut settings = GatewaySettings::default();

    if let Some(base) = table
        .get("control_ui")
        .and_then(|value| value.get("base_path"))
        .and_then(|value| value.as_str())
    {
        settings.base_path = normalize_base_path(base);
    }
    if let Some(workspace) = table
        .get("workspace_dir")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        settings.workspace_dir = expand_home(workspace);
    }
    if let Some(auth) = table.get("auth") {
        if let Some(mode) = auth.get("mode").and_then(|value| value.as_str()) {
            settings.auth_mode = mode.to_string();
        }
        if let Some(token) = auth.get("token").and_then(|value| value.as_str()) {
            if !token.is_empty() {
                settings.auth_token = Some(token.to_string());
            }
        }
    }
    settings
}

/// Apply the `AGENTOS_*` overrides pydantic-settings would apply on the gateway
/// side. Injectable lookup so the precedence is testable without touching the
/// process environment, which is shared across the whole test binary.
fn apply_env_overrides<F>(mut settings: GatewaySettings, lookup: F) -> GatewaySettings
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(base) = lookup("AGENTOS_CONTROL_UI_BASE_PATH") {
        settings.base_path = normalize_base_path(&base);
    }
    if let Some(workspace) = lookup("AGENTOS_GATEWAY_WORKSPACE_DIR") {
        let trimmed = workspace.trim();
        if !trimmed.is_empty() {
            settings.workspace_dir = expand_home(trimmed);
        }
    }
    if let Some(mode) = lookup("AGENTOS_AUTH_MODE") {
        settings.auth_mode = mode;
    }
    // Both spellings reach `AuthConfig.token`: the flat one via the
    // `AGENTOS_AUTH_` env prefix, the nested one via the gateway's
    // `AGENTOS_SECTION__FIELD` convention.
    for key in ["AGENTOS_AUTH_TOKEN", "AGENTOS_GATEWAY_AUTH__TOKEN"] {
        if let Some(token) = lookup(key) {
            if !token.is_empty() {
                settings.auth_token = Some(token);
            }
        }
    }
    settings
}

/// Normalize a mount to a leading-slash, no-trailing-slash form.
///
/// The gateway accepts `control`, `/control`, and `/control/` interchangeably;
/// the shell concatenates this with `/` and `/api/...`, so it needs one shape.
fn normalize_base_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    format!("/{trimmed}")
}

fn home_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let value = home.to_string_lossy().trim().to_string();
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    #[cfg(windows)]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile);
    }
    PathBuf::from(".")
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_no_config_exists() {
        let settings = GatewaySettings::default();
        assert_eq!(settings.base_path, "/control");
        assert!(!settings.requires_token());
    }

    #[test]
    fn reads_base_path_and_token_from_toml() {
        let table: toml::Table = r#"
            [control_ui]
            base_path = "console/"

            [auth]
            mode = "token"
            token = "s3cret"
        "#
        .parse()
        .expect("fixture should parse");

        let settings = settings_from_toml(table);
        assert_eq!(settings.base_path, "/console");
        assert!(settings.requires_token());
        assert_eq!(settings.auth_token.as_deref(), Some("s3cret"));
    }

    #[test]
    fn environment_overrides_the_toml() {
        let table: toml::Table = r#"
            [auth]
            mode = "none"
            token = "from-file"
        "#
        .parse()
        .expect("fixture should parse");

        let settings = apply_env_overrides(settings_from_toml(table), |key| match key {
            "AGENTOS_AUTH_MODE" => Some("token".to_string()),
            "AGENTOS_AUTH_TOKEN" => Some("from-env".to_string()),
            _ => None,
        });

        assert!(settings.requires_token());
        assert_eq!(settings.auth_token.as_deref(), Some("from-env"));
    }

    #[test]
    fn an_empty_env_token_does_not_erase_the_configured_one() {
        let settings = apply_env_overrides(
            GatewaySettings {
                auth_token: Some("from-file".to_string()),
                ..GatewaySettings::default()
            },
            |key| (key == "AGENTOS_AUTH_TOKEN").then(String::new),
        );
        assert_eq!(settings.auth_token.as_deref(), Some("from-file"));
    }

    #[test]
    fn a_root_mount_normalizes_to_empty() {
        assert_eq!(normalize_base_path("/"), "");
        assert_eq!(normalize_base_path("  /control/  "), "/control");
    }
}
