//! The bundled Python runtime that ships inside the app bundle.
//!
//! `scripts/build_desktop_runtime.py` lays down a relocatable
//! python-build-standalone tree with AgentOS already unpacked into its
//! `site-packages`, plus a `runtime.json` manifest describing where the
//! interpreter and packages ended up. Layout differs per platform
//! (`python.exe` + `Lib/site-packages` on Windows, `bin/python3.12` +
//! `lib/python3.12/site-packages` elsewhere), so the manifest is read rather
//! than the layout guessed.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

/// Bumped whenever the manifest's shape changes incompatibly. A mismatch means
/// the app binary and the bundled resources came from different builds, which
/// is worth failing loudly on rather than misreading a field.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Points at a `resources/` directory built by `build_desktop_runtime.py`.
/// Set during `tauri dev`, where the resource is not yet inside a bundle.
pub const RUNTIME_OVERRIDE_ENV: &str = "AGENTOS_DESKTOP_RUNTIME";

const MANIFEST_RESOURCE: &str = "resources/runtime.json";
const RUNTIME_RESOURCE: &str = "resources/runtime/python";

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub agentos_version: String,
    pub platform_tag: String,
    pub python_version: String,
    pub profile: String,
    pub cli_module: String,
    pub python_exe: String,
    pub site_packages: String,
}

#[derive(Debug, Clone)]
pub struct BundledRuntime {
    pub manifest: RuntimeManifest,
    pub python: PathBuf,
}

impl BundledRuntime {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let (manifest_path, runtime_root) = resource_paths(app)?;
        let raw = std::fs::read_to_string(&manifest_path).with_context(|| {
            format!(
                "AgentOS runtime manifest is missing: {}. This build was packaged without \
                 its bundled Python runtime.",
                manifest_path.display()
            )
        })?;
        let manifest: RuntimeManifest = serde_json::from_str(&raw)
            .with_context(|| format!("Unreadable runtime manifest: {}", manifest_path.display()))?;

        if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(anyhow!(
                "Bundled runtime manifest is schema v{}, this build expects v{}",
                manifest.schema_version,
                MANIFEST_SCHEMA_VERSION
            ));
        }

        let python = runtime_root.join(&manifest.python_exe);
        if !python.is_file() {
            return Err(anyhow!(
                "Bundled Python interpreter is missing: {}",
                python.display()
            ));
        }
        // Checked separately from the interpreter: an installer that dropped
        // part of the tree — a `.deb` unpacked over a failed download, an
        // interrupted `.dmg` copy — usually keeps the small binary and loses
        // the large package directory, which otherwise only fails later as an
        // unreadable ImportError in the gateway log.
        let site_packages = runtime_root.join(&manifest.site_packages);
        if !site_packages.is_dir() {
            return Err(anyhow!(
                "Bundled AgentOS packages are missing: {}",
                site_packages.display()
            ));
        }
        ensure_executable(&python)?;

        Ok(Self { manifest, python })
    }

    /// Build the command that starts a gateway on `host:port`.
    ///
    /// The CLI is invoked as a module because the bundled wheels are unpacked
    /// without their `.data/scripts` entries — there is no `bin/agentos` shim
    /// to call. `agentos.cli.main` carries the `__main__` guard that makes the
    /// two equivalent.
    pub fn gateway_command(&self, host: &str, port: u16) -> Command {
        let mut command = Command::new(&self.python);
        command
            .arg("-m")
            .arg(&self.manifest.cli_module)
            .arg("gateway")
            .arg("run")
            .arg("--bind")
            .arg(host)
            .arg("--port")
            .arg(port.to_string());

        // A GUI launch inherits launchd's environment, not the operator's
        // shell one. The gateway passes its own environment down to the shell
        // tool and to stdio MCP servers, so without this the agent runs with a
        // PATH that has no Homebrew, no node, and no version-manager shims.
        command.env_clear();
        command.envs(crate::environment::gateway_environment());

        // Bytecode goes beside the state directory, never into the bundle.
        //
        // Python writes `__pycache__` next to each source file by default. For
        // an interpreter living inside an application bundle that means ~1700
        // `.pyc` files land among the signed resources on first run, and the
        // bundle's code signature stops verifying — `codesign --verify` reports
        // them one by one as "file added". Ad-hoc signed today, that is merely
        // wrong; on a Developer ID build it is an app that passes Gatekeeper
        // once and fails afterwards. It would also simply not work where the
        // bundle is not writable.
        //
        // Redirecting the cache keeps the startup benefit without touching the
        // bundle. `PYTHONDONTWRITEBYTECODE` would also protect the signature,
        // at the cost of recompiling every module on every launch.
        command.env("PYTHONPYCACHEPREFIX", bytecode_cache_dir());

        // Buffered output would hide the gateway's own startup diagnostics from
        // the log file for as long as the pipe stays under 4 KiB, which is
        // exactly the window where a failing launch needs them.
        command.env("PYTHONUNBUFFERED", "1");
        // Keeps `agentos upgrade` from telling a desktop user to run pip
        // against a read-only app bundle.
        command.env("AGENTOS_INSTALL_METHOD", "desktop");
        crate::platform::configure_child(&mut command);
        command
    }
}

/// Where the bundled interpreter may write bytecode.
///
/// Created eagerly: Python silently skips caching when the prefix cannot be
/// written, which would be a quiet startup-time regression rather than a
/// visible failure.
fn bytecode_cache_dir() -> PathBuf {
    let dir = crate::config::agentos_home().join("cache").join("pycache");
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!(
            "could not create the bytecode cache {}: {error}",
            dir.display()
        );
    }
    dir
}

fn resource_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf)> {
    if let Some(root) = std::env::var_os(RUNTIME_OVERRIDE_ENV) {
        let root = PathBuf::from(root);
        return Ok((
            root.join("runtime.json"),
            root.join("runtime").join("python"),
        ));
    }
    let manifest = app
        .path()
        .resolve(MANIFEST_RESOURCE, BaseDirectory::Resource)
        .context("Could not resolve the bundled runtime manifest")?;
    let runtime = app
        .path()
        .resolve(RUNTIME_RESOURCE, BaseDirectory::Resource)
        .context("Could not resolve the bundled runtime directory")?;
    Ok((manifest, runtime))
}

/// Restore the interpreter's executable bit if the packaging step dropped it.
///
/// Installers are not uniformly faithful about POSIX modes — a `.deb` unpacked
/// under an unusual umask, or a runtime tree that made a round trip through a
/// zip, both land here with a non-executable `python3`. Fixing it costs one
/// syscall and turns an inscrutable "permission denied" into a working launch.
#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("Cannot stat the bundled interpreter: {}", path.display()))?;
    let mode = metadata.permissions().mode();
    if mode & 0o111 != 0 {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(mode | 0o755);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("Cannot mark the interpreter executable: {}", path.display()))
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(schema_version: u32) -> String {
        format!(
            r#"{{
              "schema_version": {schema_version},
              "agentos_version": "2026.8.24",
              "platform_tag": "macos-arm64",
              "python_version": "3.12.13",
              "profile": "recommended",
              "cli_module": "agentos.cli.main",
              "python_exe": "bin/python3.12",
              "site_packages": "lib/python3.12/site-packages"
            }}"#
        )
    }

    #[test]
    fn parses_a_current_manifest() {
        let parsed: RuntimeManifest = serde_json::from_str(&manifest(MANIFEST_SCHEMA_VERSION))
            .expect("current manifest should parse");
        assert_eq!(parsed.cli_module, "agentos.cli.main");
        assert_eq!(parsed.python_exe, "bin/python3.12");
    }

    #[test]
    fn forward_slashes_join_into_a_platform_path() {
        let root = PathBuf::from("/opt/AgentOS/runtime/python");
        let joined = root.join("bin/python3.12");
        assert!(joined.ends_with("python3.12"));
    }
}
