//! The environment the bundled gateway runs with.
//!
//! A gateway started from a terminal inherits the operator's shell environment
//! for free. One started from Finder, the Dock, or Spotlight does not: macOS
//! hands a GUI app launchd's environment, whose `PATH` is
//! `/usr/bin:/bin:/usr/sbin:/sbin` and which carries none of the exports in
//! `.zshrc` or `.zprofile`.
//!
//! That is not cosmetic. `tools/env_passthrough.py` builds every child process
//! environment from `os.environ` verbatim, so the gateway's `PATH` is what the
//! `shell` tool sees and what stdio MCP servers are spawned with. Under a bare
//! launchd `PATH` the agent cannot find `node`, `npx`, `ffmpeg`, `rg`, or
//! anything installed by Homebrew, `nvm`, or `uv` — so an `npx`-based MCP
//! server fails to start and half the bundled skills fail at the first
//! subprocess. The desktop app would be a visibly weaker AgentOS than the same
//! version run from a terminal.
//!
//! So the environment is reconstructed by asking the operator's own login shell
//! for it, which is the only way to pick up `nvm`, `pyenv`, `bun`, and every
//! other PATH manipulation that lives in a shell rc file. If that fails or
//! times out, a floor of standard login directories is applied instead.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

/// The shell's own output is not trustworthy: rc files print MOTDs, version
/// managers announce themselves, and prompt frameworks emit escape sequences.
/// The dump is fenced so only what is between the markers is parsed.
const SENTINEL_START: &str = "__AGENTOS_ENV_START__";
const SENTINEL_END: &str = "__AGENTOS_ENV_END__";

/// Generous on purpose: an interactive shell that sources `nvm` routinely takes
/// a second or more, and the cost is paid once per app launch. The timeout
/// exists for rc files that block on input, not to keep startup snappy.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

/// Applied when the login shell cannot be consulted, and as a floor even when
/// it can. Mirrors `_LOGIN_PATH_DIRS` in `agentos/cli/install_method.py`, which
/// exists for this same class of macOS PATH gap. Appended rather than
/// prepended, so an operator's own ordering keeps winning.
const LOGIN_PATH_DIRS: [&str; 4] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/// Never inherited into the bundled interpreter.
///
/// `PYTHONHOME` pointing at another installation breaks a relocatable
/// python-build-standalone tree outright, and `PYTHONPATH` would let modules
/// from an unrelated environment shadow the ones shipped inside the app. Both
/// are plausible things for a developer to have exported, and neither is ever
/// meant for this interpreter.
const WITHHELD: [&str; 2] = ["PYTHONHOME", "PYTHONPATH"];

/// The environment for the gateway process, resolved once per app launch.
pub fn gateway_environment() -> &'static BTreeMap<String, String> {
    static RESOLVED: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    RESOLVED.get_or_init(resolve)
}

/// One variable from the gateway's resolved environment.
///
/// The shell must read `AGENTOS_*` overrides from the same environment the
/// gateway child will run with. Reading `std::env` here instead would split
/// the world in two on macOS: an `export AGENTOS_STATE_DIR=…` in `.zshrc`
/// reaches the gateway (login-shell resolution) but not the shell's own idea
/// of the AgentOS home, pidfile, and config path — re-creating the two-homes,
/// two-gateways problem this module exists to prevent.
///
/// Test builds read the process environment directly: resolving would shell
/// out to a login shell once per test binary, which is neither deterministic
/// nor cheap.
pub fn var(key: &str) -> Option<String> {
    #[cfg(not(test))]
    {
        gateway_environment().get(key).cloned()
    }
    #[cfg(test)]
    {
        std::env::var(key).ok()
    }
}

fn resolve() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();

    match login_shell_environment() {
        Some(login) => {
            log::info!("resolved {} variables from the login shell", login.len());
            env.extend(login);
        }
        None => {
            log::warn!("could not read the login shell environment; falling back to a default PATH")
        }
    }

    for name in WITHHELD {
        env.remove(name);
    }
    // Unix only: the floor's entries are unix paths and the joiner is ':',
    // while Windows separates PATH with ';' — appending here would corrupt
    // the last real entry into `C:\dir:/opt/homebrew/bin:...` for the
    // gateway, the shell tool, and every stdio MCP server under them.
    if cfg!(unix) {
        let path = ensure_login_path(env.get("PATH").map(String::as_str).unwrap_or_default());
        env.insert("PATH".to_string(), path);
    }
    env
}

/// Append any standard login directory the PATH is missing.
fn ensure_login_path(path: &str) -> String {
    let mut entries: Vec<&str> = path.split(':').filter(|entry| !entry.is_empty()).collect();
    for dir in LOGIN_PATH_DIRS {
        if !entries.contains(&dir) {
            entries.push(dir);
        }
    }
    entries.join(":")
}

/// Ask the operator's login shell to print its environment.
///
/// Both `-l` and `-i` are needed: `PATH` edits live in `.zprofile` (login) on
/// some setups and `.zshrc` (interactive) on others, and version managers
/// almost always install into the interactive one.
#[cfg(unix)]
fn login_shell_environment() -> Option<BTreeMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell().to_string());
    // `env -0` rather than `env`: a NUL separator is the only one a variable's
    // own value cannot contain, and multi-line values are common enough
    // (SSH_ASKPASS scripts, formatted LS_COLORS) to matter.
    let script = format!("printf %s {SENTINEL_START}; env -0; printf %s {SENTINEL_END}");

    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        // Discarded deliberately: an interactive shell with no tty is noisy,
        // and none of it is diagnostic.
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| log::warn!("could not run {shell}: {error}"))
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    // Read on another thread so a shell that never finishes cannot wedge
    // startup, and so a full pipe cannot deadlock against a timeout poll.
    std::thread::Builder::new()
        .name("agentos-login-shell".to_string())
        .spawn(move || {
            let mut buffer = Vec::new();
            let _ = stdout.read_to_end(&mut buffer);
            let _ = sender.send(buffer);
        })
        .ok()?;

    match receiver.recv_timeout(RESOLVE_TIMEOUT) {
        Ok(buffer) => {
            let _ = child.wait();
            parse_env_dump(&buffer)
        }
        Err(_) => {
            log::warn!("login shell did not answer within {RESOLVE_TIMEOUT:?}");
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[cfg(not(unix))]
fn login_shell_environment() -> Option<BTreeMap<String, String>> {
    // Windows GUI processes already inherit the user environment from the
    // session, so there is nothing to reconstruct.
    None
}

#[cfg(unix)]
fn default_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

/// Extract the fenced `env -0` dump from whatever else the shell printed.
fn parse_env_dump(buffer: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = String::from_utf8_lossy(buffer);
    let start = text.find(SENTINEL_START)? + SENTINEL_START.len();
    let end = text[start..].find(SENTINEL_END)? + start;

    let mut env = BTreeMap::new();
    for entry in text[start..end].split('\0') {
        if entry.is_empty() {
            continue;
        }
        // `split_once` and not `split`: a value may legitimately contain '='.
        if let Some((key, value)) = entry.split_once('=') {
            if !key.is_empty() {
                env.insert(key.to_string(), value.to_string());
            }
        }
    }
    (!env.is_empty()).then_some(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(body: &str) -> Vec<u8> {
        format!("{SENTINEL_START}{body}{SENTINEL_END}").into_bytes()
    }

    #[test]
    fn parses_a_nul_separated_dump() {
        let parsed = parse_env_dump(&dump("PATH=/usr/bin\0HOME=/Users/x\0")).expect("should parse");
        assert_eq!(parsed.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(parsed.get("HOME").map(String::as_str), Some("/Users/x"));
    }

    #[test]
    fn ignores_noise_printed_around_the_dump() {
        // Prompt frameworks and version managers write to stdout on startup.
        let mut buffer = b"Powerlevel10k instant prompt\n".to_vec();
        buffer.extend(dump("PATH=/opt/homebrew/bin\0"));
        buffer.extend(b"\nsome trailing chatter");

        let parsed = parse_env_dump(&buffer).expect("should parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin")
        );
    }

    #[test]
    fn keeps_equals_signs_inside_a_value() {
        let parsed = parse_env_dump(&dump("OPTS=a=1,b=2\0")).expect("should parse");
        assert_eq!(parsed.get("OPTS").map(String::as_str), Some("a=1,b=2"));
    }

    #[test]
    fn keeps_newlines_inside_a_value() {
        let parsed = parse_env_dump(&dump("SCRIPT=line1\nline2\0PATH=/bin\0")).expect("parses");
        assert_eq!(
            parsed.get("SCRIPT").map(String::as_str),
            Some("line1\nline2")
        );
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn an_unfenced_or_empty_dump_is_rejected() {
        assert!(parse_env_dump(b"PATH=/usr/bin").is_none());
        assert!(parse_env_dump(&dump("")).is_none());
    }

    #[test]
    fn the_login_path_floor_is_appended_not_prepended() {
        // An operator's own ordering has to keep winning; the floor only fills
        // in directories that are missing entirely.
        let path = ensure_login_path("/Users/x/.nvm/bin:/opt/homebrew/bin");
        assert_eq!(
            path,
            "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn an_empty_path_becomes_the_full_floor() {
        assert_eq!(
            ensure_login_path(""),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn a_launchd_path_gains_the_homebrew_directories() {
        // Exactly what a Finder launch hands the app today.
        let path = ensure_login_path("/usr/bin:/bin:/usr/sbin:/sbin");
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
    }
}
