# Desktop App

The AgentOS desktop app is the Control UI in a native window, with the gateway
supervised for you. It bundles its own Python runtime, so there is nothing to
install first — no Python, no `uv`, no `pip`.

It is the same AgentOS. The app reads and writes the usual `~/.agentos` home, so
a session started in the app is the session `agentos chat` resumes in a
terminal, and configuration changes made in either are visible to both.

## Install

Download the installer for your platform from the
[releases page](https://github.com/use-agent-os/agent-os/releases):

| Platform | Asset |
| --- | --- |
| macOS (Apple silicon) | `AgentOS_<version>_aarch64.dmg` |
| macOS (Intel) | `AgentOS_<version>_x64.dmg` |
| Windows | `AgentOS_<version>_x64-setup.exe` |
| Linux | `AgentOS_<version>_amd64.AppImage` or `.deb` |

Installers are large — roughly 250–400 MB — because the app carries a complete
Python runtime plus the on-device router and embedding models. That is the trade
for a download that runs without any other install step.

They are also unsigned, so macOS and Windows both warn on first launch.
[Unsigned builds](#unsigned-builds) has the two-click way past it.

First launch shows a splash while the gateway starts, then swaps in the console.
A cold first start takes longer than later ones: the router loads its ONNX model
and memory builds its index.

## How it works

```
AgentOS.app
 ├─ shell (Tauri)          native window, tray, notifications, updates
 └─ resources/runtime/     python-build-standalone + AgentOS + dependencies
        │
        └─ spawned as: python -m agentos.cli.main gateway run --bind 127.0.0.1
                         │
                         └─ window loads http://127.0.0.1:18791/control/
```

The window loads the Control UI over loopback rather than from files inside the
app. The gateway injects each page's asset base and bootstrap context at request
time, so a copy served from the bundle would boot without either — and loading
it live means the app tracks Control UI changes with no shim to maintain.

### Port selection and attaching

The app prefers port 18791, the same one `agentos gateway run` uses, so bookmarks
and CLI defaults keep working.

If a gateway is **already running** on this machine, the app attaches to it
instead of starting a second one. Two gateways would contend for the port and
the SQLite database. When the app is attached, the tray shows `Attached · port
N` and **Restart Gateway** is disabled — that gateway is not the app's to stop.

If port 18791 is taken by something that is not an AgentOS gateway, the app
falls back to an ephemeral port.

### Configuration and auth

The app does not own your configuration. It starts the gateway against your
existing `~/.agentos/config.toml`, which means your `auth.mode` applies exactly
as it does from the terminal — the desktop app does not force a stricter or
looser posture than `agentos gateway run`.

One consequence is worth knowing: with `auth.mode = "token"`, approval
notifications need that token to read `/api/approvals`. The app reads it from
the same config file. If the gateway requires a token and none is configured
where the app can find it, notifications switch off and say so in the log; the
rest of the app is unaffected.

### Environment parity with the terminal

A gateway you start from a terminal inherits your shell environment. One a
desktop app starts from Finder or the Dock does not — macOS hands a GUI app
launchd's environment, whose `PATH` is just `/usr/bin:/bin:/usr/sbin:/sbin`.

That would make the desktop app a weaker AgentOS than the same version run from
a terminal, because the gateway passes its own environment down to the `shell`
tool and to every stdio MCP server. Under a bare launchd `PATH` an `npx`-based
MCP server cannot start, and skills that call `ffmpeg`, `node`, or `rg` fail at
their first subprocess.

So on first launch the app asks your login shell (`$SHELL -l -i`) for its
environment and starts the gateway with it. That is what picks up `nvm`,
`pyenv`, `bun`, Homebrew, and anything else that edits `PATH` from a shell rc
file. If the shell cannot be read or takes longer than ten seconds, the app
falls back to appending the standard login directories (`/opt/homebrew/bin`,
`/usr/local/bin`, `/usr/bin`, `/bin`) instead.

Two variables are deliberately **not** inherited: `PYTHONHOME` and `PYTHONPATH`.
Either one, set for some other interpreter, would break or contaminate the
runtime inside the app bundle.

API keys work the same as they do for the CLI: AgentOS reads
`~/.agentos/.env` itself, so keys stored there need no shell involvement.

### Working directory

The gateway runs with its working directory set to the configured
`workspace_dir` — `~/.agentos/workspace` unless you have changed it. This keeps
the process cwd and the workspace in agreement: several tools fall back to the
process cwd when a call carries no workspace of its own, and pointing that at
the AgentOS home would let the agent write among `config.toml`, `.env`, and
`state/`.

## Unsigned builds

AgentOS releases are not signed with an Apple Developer ID or a Windows code
certificate. Both are paid annual subscriptions, and the project does not carry
them. Nothing about the app is different because of it — the operating system
simply has no third party vouching for who built the download, so it warns you
the first time you open it.

**macOS.** The app is ad-hoc signed — `bundle.macOS.signingIdentity` is `"-"` —
but not notarized, so Gatekeeper blocks a copy downloaded through a browser with
*"Apple could not verify AgentOS is free of malware"*.

The ad-hoc signature is worth the line of config it costs. Without it the bundle
ships with a linker signature on the main binary and no seal over its resources,
which macOS reports not as *unsigned* but as **damaged** — and that dialog
offers only "Move to Trash", with no way through. A coherent ad-hoc seal
produces the ordinary unverified-developer dialog instead, which the steps below
clear.

To open it:

1. Try to open AgentOS once and dismiss the warning.
2. **System Settings → Privacy & Security**, scroll to Security, and click
   **Open Anyway** next to the AgentOS message.
3. Confirm. macOS remembers the decision; later launches are normal.

On macOS 15 and newer, right-click → Open no longer bypasses this — Settings is
the only route. If you prefer the terminal, clearing the quarantine flag does
the same thing:

```sh
xattr -dr com.apple.quarantine /Applications/AgentOS.app
```

**Windows.** SmartScreen shows *"Windows protected your PC"*. Click **More
info** → **Run anyway**.

**Linux.** No signature check applies to the AppImage or `.deb`.

Only do any of this for a build you fetched from the project's own releases page
over HTTPS. These steps are exactly what you would have to skip for a genuinely
tampered download, which is the reason signing is worth having and the reason
this section is not buried.

## Tray menu

| Item | Does |
| --- | --- |
| Open AgentOS | Shows and focuses the window. |
| *(status)* | Current gateway state and port. |
| Restart Gateway | Stops and restarts the gateway. Disabled when attached. |
| Open Log File | Opens `~/.agentos/logs/desktop-gateway.log`. |
| Launch at Login | Starts AgentOS when you log in. |
| Check for Updates… | Looks for a newer release. |
| Quit AgentOS | Stops the gateway and exits. |

Closing the window **hides** it rather than quitting — the gateway is a
background service, and a running agent should survive a stray `Cmd+W`. Quit is
explicit.

`Ctrl+Alt+A` shows or hides the window from anywhere. If another app already
owns that shortcut, registration fails quietly and the tray still works.

## Notifications

An approval blocks the agent's turn until you answer it, so the app raises a
native notification the first time it sees each pending request. Clicking the
tray shows the queue; the tooltip carries the count.

## Deep links

`agentos://` URLs open the app and route into the console:

```text
agentos://chat              -> /control/chat
agentos://sessions/abc      -> /control/sessions/abc
```

## Updates

The app checks once at launch and prompts only if something is available.
Updates replace the whole bundle — there are no deltas, because the payload is
mostly the Python runtime and the models — so you are asked before anything
downloads.

Builds that ship without updater signing (developer builds, and distro packages
where the system package manager owns updates) say so instead of offering a
check that cannot work. The same applies if the updater is configured but the
plugin refuses that configuration — a non-`https` endpoint, a malformed key: the
reason goes to the log and the app carries on without in-app updates.

Updates are independent of the OS code signing above. They are verified with the
app's own minisign key, so they work on an unsigned build. Enabling them for a
release costs nothing but a keypair:

```sh
cargo tauri signer generate -w ~/.tauri/agentos.key
```

Add the private key and its password to the repository as
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the
public half as `TAURI_UPDATER_PUBKEY`. The release workflow turns on updater
artifacts only when it finds them.

Inside the app, `agentos upgrade` will tell you to update the app rather than
handing you a `pip install`: the runtime lives inside the application bundle,
where replacing packages breaks the code signature and gets reverted by the next
app update anyway.

## Security posture

- The gateway binds loopback only, exactly as the CLI does.
- The window is confined to the gateway's own origin. A link in a transcript —
  model output and tool results are rendered there — opens in your browser
  rather than inside the app frame, so a third-party page never inherits the
  app's chrome. Non-web schemes are refused.
- The app grants **no** IPC capability to any window. The console cannot call
  into the native layer at all; native features are driven from the shell side.
- Releases are **not** code-signed or notarized — see [Unsigned
  builds](#unsigned-builds) below for what that means when you install one. The
  signing machinery is in the release workflow and switches on when the
  certificates exist; nothing in the app depends on it.

## Building it yourself

Prerequisites: Rust (stable), Node 22+, Python 3.12, and the Tauri CLI
(`cargo install tauri-cli --version "^2" --locked`). On Linux you also need
`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`, and `patchelf`.

```sh
# 1. Build the Control UI, the wheel, and the bundled runtime for this platform.
python scripts/build_desktop_runtime.py build

# 2. Build the app and its installer.
cd desktop/src-tauri && cargo tauri build
```

Step 1 must run on the platform it targets: `pip wheel` resolves dependency
wheels against the *host* platform's markers, so a runtime for Windows has to be
built on Windows. `.github/workflows/desktop-release.yml` runs one job per
target for that reason.

For a faster inner loop, point the shell at a runtime you already built and skip
rebuilding it:

```sh
AGENTOS_DESKTOP_RUNTIME=$PWD/desktop/src-tauri/resources \
  cargo tauri dev --config '{"bundle":{"resources":[]}}'
```

Shell checks, mirroring `.github/workflows/desktop.yml`:

```sh
cd desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The icon set is committed because release runners have no image tooling to
regenerate it. Change the mark in `scripts/build_desktop_icon.py`, then:

```sh
python scripts/build_desktop_icon.py all
cd desktop/src-tauri && cargo tauri icon icons/icon-source.png -o icons
rm -rf icons/android icons/ios   # desktop targets only
```

## Troubleshooting

**The splash sits there and then says AgentOS could not start.** Open the log it
names — `~/.agentos/logs/desktop-gateway.log` — and read the end. The gateway's
own startup errors (a bad provider key, an unreadable config) land there
verbatim. The app gives up after three failed starts in two minutes rather than
respawning forever.

**The app opened but the console is blank or shows a 503.** The bundled runtime
is missing its Control UI assets, which means a broken install rather than a
configuration problem. Reinstall from the releases page.

**Tray says "Attached" and Restart Gateway is greyed out.** Another AgentOS
gateway was already running — probably `agentos gateway start` from a terminal.
Stop it with `agentos gateway stop` and the app will start its own.

**macOS says the app is damaged, or that it cannot be verified.** Expected on an
unsigned build, and nothing is actually damaged — see [Unsigned
builds](#unsigned-builds) for how to open it.

## See also

- [`web-ui.md`](web-ui.md) — everything the console itself can do.
- [`gateway.md`](gateway.md) — gateway lifecycle, host/port, and exposure.
- [`cli.md`](cli.md) — the same runtime from a terminal.
