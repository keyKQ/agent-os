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

Installers are large — the macOS arm64 `.dmg` measures 165 MB, unpacking to
about 400 MB — because the app carries a complete Python runtime plus the
on-device router and embedding models. Other platforms are the same order of
magnitude. That is the trade for a download that runs without any other install
step.

A download from that page is also unsigned, so macOS and Windows both warn on
first launch. [Unsigned builds](#unsigned-builds) has the two-click way past it.

### Homebrew

On macOS the tap serves the same `.dmg`, and skips that warning:

```sh
brew tap use-agent-os/agentos https://github.com/use-agent-os/agent-os
brew trust use-agent-os/agentos
brew install --cask agentos
```

This repository is the tap — there is no separate `homebrew-agentos` repository
to keep in step with it. That is why the first line carries a URL: Homebrew
finds a tap by name alone only when the repository is called `homebrew-<tap>`,
and takes any other repository if you point at it. The trade is the clone,
around 130 MB, because the tap is the whole project rather than a directory
holding one file.

The second line is not optional ceremony. Homebrew 6 refuses to load a cask from
a tap it does not know — *"Refusing to load cask … from untrusted tap"* — and a
bare `brew upgrade` skips untrusted taps rather than failing, printing one
*"Skipping … because it is not trusted"* warning as it goes, so without it your
updates stop with nothing louder than a line in the scroll. Trusting is a
one-time, per-tap decision.

If you would rather not trust the tap, naming the cask in full counts as saying
yes to that one cask instead:

```sh
brew install --cask use-agent-os/agentos/agentos
```

The cask clears the quarantine flag once the app is staged, announcing it as it
goes, so the first launch is an ordinary one. That is a deliberate trade rather
than a free win — [Unsigned builds](#unsigned-builds) says what it costs and why
the checksum is what carries the weight instead.

`brew upgrade --cask agentos` moves you to the next release. `Casks/agentos.rb`
is generated, not written by hand: the release workflow fills in the version and
both checksums from the installers it just built, so the tap cannot point at a
hash the release does not have.

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
the SQLite database. The tray says which of the two happened:

- `Reconnected · port N` — a gateway this app started in an earlier run and did
  not get to stop, usually after a force quit. It is still the app's, so
  **Restart Gateway** works.
- `Attached · port N` — a gateway you started yourself, from a terminal.
  **Restart Gateway** is disabled: stopping a process you launched, from a menu
  that gives no hint of it, is not the app's call.

If port 18791 is taken by something that is not an AgentOS gateway, the app
falls back to an ephemeral port.

### If you already installed AgentOS with `uv`

Nothing is duplicated and nothing is lost. The app uses the same `~/.agentos`
home, so your configuration, `.env`, sessions, agents, skills, and channels are
all already there the first time you open it.

What matters is which one is *running*:

| Situation | What happens |
| --- | --- |
| No gateway running | The app starts its own, from its bundled runtime |
| Your CLI gateway is already running | The app attaches to it and uses **your installed version**, not the bundled one |
| App's gateway is running, and you run `agentos …` | See below |

That last row is the one to know about. The CLI refuses to talk to a gateway
newer than itself:

```text
Error: Gateway (2026.8.24) is NEWER than this CLI (2026.8.23). The gateway may
have written config with a newer schema, so this older CLI refuses to act on it.
Upgrade the CLI (agentos upgrade) or restart the gateway from this environment.
```

This is [the project's version-skew policy](cli.md#upgrade), not something the
desktop app invents — but the app makes it easy to hit, because you download the
current release while your `uv` install may be several versions behind. The
message names both fixes: `agentos upgrade` to bring the CLI level, or quit the
app so your own gateway is the one running. The reverse direction — a CLI newer
than the gateway — only warns.

**Your configuration may be migrated.** A newer gateway rewrites
`~/.agentos/config.toml` when the schema has moved, dropping keys that are no
longer read. It writes a timestamped `config.toml.backup.*` next to it first,
and the rewrite is atomic. In practice this removes settings your older CLI was
already ignoring, so the older CLI keeps loading the file — but the backup is
there if you need to compare.

**Keeping the two in step.** Run `agentos upgrade` after installing a newer app.
It moves the `uv` install onto the published release the app was built from, and
from then on both speak the same version. Do it again each time you update the
app; there is no automatic link between them.

### Does the desktop app give me a terminal command?

No — and this catches people out, because the app really does contain the whole
CLI. Its bundled runtime has every command group `agentos` has: `chat`, `agent`,
`doctor`, `config`, `cron`, `models`, and the rest. The app starts its own
gateway by calling straight into it.

What it does not do is put that CLI on your `PATH`. There is no `agentos`
command installed by the app, deliberately: writing one would collide with the
`agentos` a `uv tool install` already manages, and the two would then overwrite
each other on every upgrade.

So if you want AgentOS in a terminal as well as in a window, install the CLI the
normal way and keep it in step:

```sh
uv tool install use-agent-os      # once
agentos upgrade                   # after each app update
```

If you only ever use the window, you need none of this.

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

**macOS via Homebrew.** The cask runs that same command for you in a
`postflight` block, and prints a line saying so. Homebrew applies the quarantine
attribute itself when it stages a cask — it is not something the browser did and
the cask inherited — so an unnotarized app installed with `brew` would otherwise
land in `/Applications` and refuse to open, which is a worse failure than the
browser download because nothing explains it.

`brew install --cask --no-quarantine` was the supported way to ask for this.
Homebrew deprecated the flag in 4.6.19 (October 2025) and deleted it in 6.0.14
(July 2026); on a current Homebrew it now fails with `Error: invalid option:
--no-quarantine`. Clearing the attribute from the cask is what remains.

What that costs is real: Gatekeeper stops vetting the bundle, and it does so
without asking. What stands in its place is the `sha256` in the cask, which is
generated from the installer the release actually published — so Homebrew
refuses the download outright if the bytes are not the ones this project built.
That check is stronger than the dialog it replaces, but it is a different check,
and it says nothing about who built them. Notarization is the thing that would,
and it needs a paid Apple Developer ID the project does not carry.

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
| Restart Gateway | Stops and restarts the gateway. Disabled only when attached to a gateway you started yourself. |
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

## Downloads

Everything the console can export — a chat transcript, a chart image, the logs,
the usage CSV, and any artifact the agent produced — saves to your downloads
folder, using the name the console suggests and without overwriting a file
that is already there.

The window has no download shelf the way a browser does, so each finished
download raises a notification naming the file and the folder it went to.

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

If you installed through [Homebrew](#homebrew), prefer `brew upgrade --cask
agentos` and let the in-app prompt go. Both routes work and both land on the
same build, but only Homebrew's leaves the Caskroom agreeing with what is in
`/Applications`; after an in-app update the two disagree until the next
`brew upgrade` puts the cask's copy back.

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
- The [Homebrew](#homebrew) cask goes further and clears the quarantine flag on
  your behalf, which is the one place AgentOS lowers a macOS defence rather than
  telling you how to. What backs the install instead is the cask's `sha256`,
  generated from the published installer. It is called out here because a
  security posture that only lists the defences is not one.

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

**Tray says "Attached" and Restart Gateway is greyed out.** A gateway you
started yourself is already running — probably `agentos gateway start` from a
terminal — and the app attached to it rather than starting a second one against
the same database. Stop it with `agentos gateway stop` and the app will start
its own. (`Reconnected` is the other case: a gateway this app left behind, which
it can restart.)

**macOS says the app is damaged, or that it cannot be verified.** Expected on an
unsigned build, and nothing is actually damaged — see [Unsigned
builds](#unsigned-builds) for how to open it.

## See also

- [`web-ui.md`](web-ui.md) — everything the console itself can do.
- [`gateway.md`](gateway.md) — gateway lifecycle, host/port, and exposure.
- [`cli.md`](cli.md) — the same runtime from a terminal.
