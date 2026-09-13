"""``agentos upgrade`` — upgrade the package and restart the managed gateway.

Design derived from the OpenClaw / Nous Hermes daemon+CLI case studies. Two
regrets drive the whole command:

* **Silent version skew** — a "successful" upgrade that leaves the daemon on
  old code. So a successful package upgrade restarts the managed gateway by
  default and then VERIFIES the running version equals the new one before
  reporting success.
* **Upgrade subprocess hangs on macOS** (Hermes) — PATH gaps and no timeout.
  So the delegated tool is resolved to an absolute path against a hardened
  PATH, the subprocess runs under a bounded timeout, and on timeout the whole
  process group is killed with recovery guidance. Never a half-state.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import typer

from agentos import __version__
from agentos.cli import upgrade_snapshot
from agentos.cli.install_method import (
    build_upgrade_plan,
    hardened_path_env,
    installed_from_directory,
    release_spec,
)
from agentos.cli.ui import console, markup_escape

# Default upgrade-subprocess timeout (seconds). Overridable via --timeout.
_DEFAULT_TIMEOUT_S = 600.0
# Bounded wait for the restarted gateway to report the new version.
_VERIFY_TIMEOUT_S = 30.0
_VERIFY_POLL_S = 0.5
# Release lookups (PyPI + GitHub) share one bound so --check stays snappy.
_LOOKUP_TIMEOUT_S = 5.0

_SOURCES = ("auto", "pypi", "github")


@dataclass(frozen=True)
class ReleaseChoice:
    """Where the upgrade installs from, and what each source currently offers."""

    source: str  # "pypi" | "github"
    spec: str
    pypi: str | None
    github: str | None

    @property
    def latest(self) -> str | None:
        """The newest version either source offers."""

        from agentos.compat.version_utils import is_newer

        if self.pypi is None:
            return self.github
        if self.github is not None and is_newer(self.github, self.pypi):
            return self.github
        return self.pypi

    def to_payload(self) -> dict[str, object]:
        return {"source": self.source, "pypi": self.pypi, "github": self.github}


def _choose_release(source: str) -> ReleaseChoice:
    """Pick PyPI or the GitHub release asset according to ``--source``.

    ``auto`` prefers PyPI and falls back to GitHub only when GitHub is *ahead*
    — the "PyPI publish failed for this tag" case — or PyPI is unreachable. A
    bare ``dist[extras]`` spec is still handed to the installer when neither
    source answers, so an offline run fails inside ``uv`` with its own message
    rather than being refused here on a guess.
    """

    from agentos.compat import github_releases, pypi_client
    from agentos.compat.version_utils import is_newer

    pypi = None if source == "github" else pypi_client.latest_version(timeout=_LOOKUP_TIMEOUT_S)
    github = (
        None
        if source == "pypi"
        else github_releases.latest_release_version(timeout=_LOOKUP_TIMEOUT_S)
    )

    use_github = False
    if source == "github":
        use_github = True
    elif source == "auto" and github is not None:
        use_github = pypi is None or is_newer(github, pypi)

    if use_github and github is not None:
        return ReleaseChoice(
            source="github",
            spec=release_spec(wheel_url=github_releases.wheel_url(github)),
            pypi=pypi,
            github=github,
        )
    return ReleaseChoice(source="pypi", spec=release_spec(), pypi=pypi, github=github)


@dataclass
class UpgradeRunResult:
    ok: bool
    timed_out: bool
    returncode: int | None
    stdout: str
    stderr: str


def _installed_version_via(executable: str, *, env: dict[str, str]) -> str | None:
    """Read the installed dist version using a FRESH subprocess of ``executable``.

    Running in a fresh process of the (possibly upgraded) interpreter avoids
    the stale ``importlib.metadata`` cache of the currently-running process.
    """

    code = "import importlib.metadata as m; print(m.version('use-agent-os'))"
    try:
        proc = subprocess.run(  # noqa: S603 - argv built internally
            [executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=15.0,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or "").strip()
    return out or None


def _run_upgrade_subprocess(
    command: list[str],
    *,
    env: dict[str, str],
    timeout: float,
) -> UpgradeRunResult:
    """Run the delegated upgrade command under a hard timeout.

    On timeout the whole process group is killed (SIGKILL after SIGTERM) so no
    half-finished child survives — a hung ``uv``/``pipx`` invocation must never
    leave a background zombie.
    """

    start_new_session = os.name != "nt"
    try:
        proc = subprocess.Popen(  # noqa: S603 - argv built internally
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=start_new_session,
        )
    except OSError as exc:
        return UpgradeRunResult(
            ok=False, timed_out=False, returncode=None, stdout="", stderr=str(exc)
        )

    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        try:
            stdout, stderr = proc.communicate(timeout=5.0)
        except subprocess.TimeoutExpired:
            # The tree is dead, but orphaned grandchildren can keep the
            # inherited stdout/stderr pipe handles open, so communicate() would
            # block past the timeout it was supposed to enforce. Don't let a
            # stuck handle hang the CLI — give up on the streams.
            stdout, stderr = "", ""
        return UpgradeRunResult(
            ok=False,
            timed_out=True,
            returncode=proc.returncode,
            stdout=stdout or "",
            stderr=stderr or "",
        )

    return UpgradeRunResult(
        ok=proc.returncode == 0,
        timed_out=False,
        returncode=proc.returncode,
        stdout=stdout or "",
        stderr=stderr or "",
    )


def _kill_process_group(proc: subprocess.Popen[str]) -> None:
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, OSError):
            proc.kill()
        return
    try:
        pgid = os.getpgid(proc.pid)  # type: ignore[attr-defined]
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):  # type: ignore[attr-defined]
        try:
            os.killpg(pgid, sig)  # type: ignore[attr-defined]
        except ProcessLookupError:
            return
        except OSError:
            return
        time.sleep(0.2)
        if proc.poll() is not None:
            return


def _query_gateway_version(config_path: str | None) -> str | None:
    """Return the gateway's handshake-reported version (or ``None``)."""

    from agentos.cli.gateway_cmd import gateway_handshake_version

    return gateway_handshake_version(config_path=config_path)


def _restart_and_verify(
    *,
    config_path: str | None,
    expected_version: str,
    json_output: bool,
) -> bool:
    """Restart the managed gateway (if running) and verify the new version.

    Returns True on verified restart (or nothing-to-restart), False on failure.
    """

    from agentos.cli.gateway_cmd import _lifecycle_manager

    manager = _lifecycle_manager(port=None, bind=None, listen="", config_path=config_path)
    status = manager.status()
    if not (status.state == "running" and status.managed):
        console.print(
            "[dim]Gateway is not running (managed) — nothing to restart. "
            "It will pick up the new version on next start.[/dim]"
        )
        return True

    console.print("Restarting managed gateway…")
    result = manager.restart()
    if result.exit_code != 0:
        console.print(
            f"[red]Gateway restart failed:[/red] {result.message or result.code or result.state}"
        )
        return False

    deadline = time.monotonic() + _VERIFY_TIMEOUT_S
    observed: str | None = None
    while time.monotonic() <= deadline:
        observed = _query_gateway_version(config_path)
        if observed == expected_version:
            console.print(f"Gateway: restarted and verified ({expected_version}).")
            return True
        time.sleep(_VERIFY_POLL_S)

    console.print(
        f"[red]Gateway restart could not be verified.[/red] Expected "
        f"{expected_version}, gateway reports {observed or 'unreachable'}.\n"
        "Recovery: run 'agentos gateway status' to inspect, then "
        "'agentos gateway restart' to retry.",
    )
    return False


def _gateway_answering(config_path: str | None) -> bool:
    """True when a gateway answers on the configured endpoint (managed or not)."""

    from agentos.cli.gateway_cmd import _lifecycle_manager

    manager = _lifecycle_manager(port=None, bind=None, listen="", config_path=config_path)
    status = manager.status()
    return status.state in ("running", "unmanaged", "unhealthy")


def _take_snapshot(*, json_output: bool) -> upgrade_snapshot.SnapshotResult | None:
    """Snapshot the critical state before touching the install; never blocks."""

    try:
        snap = upgrade_snapshot.create_snapshot(version=__version__)
    except (OSError, ValueError) as exc:
        console.print(f"[yellow]Could not snapshot state before upgrading:[/yellow] {exc}")
        return None
    if not json_output:
        console.print(
            f"[dim]Snapshot: {len(snap.entries)} file(s) → {markup_escape(str(snap.path))}[/dim]"
        )
        if snap.skipped:
            console.print(
                f"[dim]Skipped (too large or unreadable): {len(snap.skipped)} file(s).[/dim]"
            )
    return snap


def _verify_data_after_restart(
    *,
    config_path: str | None,
    snapshot: upgrade_snapshot.SnapshotResult | None,
    json_output: bool,
) -> dict[str, object]:
    """Check every state database now that the NEW gateway has migrated them.

    On corruption, and only when there is a snapshot to go back to, the managed
    gateway is stopped, the snapshot restored file for file, and the gateway
    started again — then the check is repeated so the report says what is
    actually on disk. A gateway this command does not manage is left alone and
    the operator gets the exact restore command instead.
    """

    from agentos.cli.gateway_cmd import _lifecycle_manager

    check = upgrade_snapshot.verify_state()
    payload: dict[str, object] = {"data": check.to_payload(), "restored": False}
    if check.ok:
        if not json_output and check.checked:
            console.print(f"Data: {len(check.checked)} database(s) verified.")
        return payload

    problems = ", ".join(
        f"{markup_escape(p['path'])} ({markup_escape(p['result'])})" for p in check.problems
    )
    console.print(f"[red]Data check failed after the upgrade:[/red] {problems}")
    if snapshot is None or not snapshot.entries:
        console.print("No pre-upgrade snapshot to restore from (see --no-snapshot).")
        return payload

    manager = _lifecycle_manager(port=None, bind=None, listen="", config_path=config_path)
    status = manager.status()
    if not (status.state == "running" and status.managed):
        console.print(
            "Stop the gateway, then restore the snapshot with:\n    "
            f"agentos upgrade --restore-snapshot {markup_escape(str(snapshot.path))}"
        )
        return payload

    console.print("Restoring the pre-upgrade snapshot…")
    stop = manager.stop()
    if stop.exit_code != 0:
        console.print(f"[red]Could not stop the gateway:[/red] {stop.message or stop.state}")
        return payload
    try:
        restored = upgrade_snapshot.restore_snapshot(snapshot.path)
    except (OSError, ValueError) as exc:
        console.print(f"[red]Restore failed:[/red] {exc}")
        manager.start()
        return payload
    start = manager.start()
    if start.exit_code != 0:
        console.print(
            f"[red]Gateway did not start after restore:[/red] {start.message or start.state}"
        )
    recheck = upgrade_snapshot.verify_state()
    payload["restored"] = True
    payload["restoredFiles"] = [str(p) for p in restored]
    payload["data"] = recheck.to_payload()
    console.print(
        f"Restored {len(restored)} file(s) from the snapshot; data check now "
        f"{'passes' if recheck.ok else 'STILL FAILS'}."
    )
    return payload


def _restore_snapshot_command(target: str, *, config_path: str | None, json_output: bool) -> None:
    """``--restore-snapshot``: copy a snapshot back while the gateway is down."""

    from agentos.cli.output import print_json

    path = Path(target).expanduser()
    if target == "latest":
        latest = upgrade_snapshot.latest_snapshot()
        if latest is None:
            console.print("[red]No snapshot found.[/red]")
            raise typer.Exit(1)
        path = latest
    if not (path / upgrade_snapshot.MANIFEST_NAME).is_file():
        console.print(f"[red]Not a snapshot directory:[/red] {markup_escape(str(path))}")
        raise typer.Exit(1)
    if _gateway_answering(config_path):
        console.print(
            "[red]The gateway is running.[/red] Stop it first ('agentos gateway stop'), "
            "then retry: a live database would replay its journal over the restored file."
        )
        raise typer.Exit(1)
    try:
        restored = upgrade_snapshot.restore_snapshot(path)
    except (OSError, ValueError) as exc:
        console.print(f"[red]Restore failed:[/red] {exc}")
        raise typer.Exit(1) from exc
    check = upgrade_snapshot.verify_state()
    if json_output:
        print_json(
            {
                "snapshot": str(path),
                "restoredFiles": [str(p) for p in restored],
                "data": check.to_payload(),
            }
        )
    else:
        console.print(f"Restored {len(restored)} file(s) from {markup_escape(str(path))}.")
        console.print("Data check: " + ("ok" if check.ok else "FAILED"))
    raise typer.Exit(0 if check.ok else 1)


def _verify_data_command(*, json_output: bool) -> None:
    """``--verify-data``: run the post-upgrade data check on its own."""

    from agentos.cli.output import print_json

    check = upgrade_snapshot.verify_state()
    if json_output:
        print_json(check.to_payload())
    elif check.ok:
        console.print(f"Data: {len(check.checked)} database(s) verified.")
    else:
        for problem in check.problems:
            console.print(
                f"[red]{markup_escape(problem['path'])}:[/red] {markup_escape(problem['result'])}"
            )
        latest = upgrade_snapshot.latest_snapshot()
        if latest is not None:
            console.print(
                "Stop the gateway, then restore the last snapshot with:\n    "
                f"agentos upgrade --restore-snapshot {markup_escape(str(latest))}"
            )
    raise typer.Exit(0 if check.ok else 1)


def _emit_source_install_notice(source_dir: Path) -> None:
    """Tell a source installer that this command installs the RELEASE instead.

    ``agentos upgrade`` deliberately does not build from a checkout — only
    ``scripts/install_source.sh`` rebuilds the Control UI before installing. A
    source installer who is not told that would find their local code replaced
    with no idea how to get it back, so name the way back explicitly. Purely
    informational: it never blocks, prompts, or changes the exit code.
    """

    path = markup_escape(str(source_dir))
    console.print(
        f"[dim]This install was built from {path}.\n"
        "'agentos upgrade' installs the published PyPI release instead.\n"
        f"To install that checkout again: cd {path} && "
        "bash scripts/install_source.sh[/dim]"
    )


def _emit_no_restart_warning(new_version: str) -> None:
    old = __version__
    print(
        f"⚠ Gateway still running OLD version {old} — run 'agentos gateway restart' "
        f"to apply {new_version}.",
        file=sys.stderr,
    )


def upgrade_command(
    check: bool = typer.Option(
        False, "--check", help="Only report whether a newer version exists; change nothing."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print what would run and touch nothing."
    ),
    no_restart: bool = typer.Option(
        False, "--no-restart", help="Do not restart the managed gateway after upgrading."
    ),
    timeout: float = typer.Option(
        _DEFAULT_TIMEOUT_S, "--timeout", help="Upgrade subprocess timeout in seconds."
    ),
    config_path: str | None = typer.Option(None, "--config", help="Override config path."),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON."),
    source: str = typer.Option(
        "auto",
        "--source",
        help="Where to install from: auto (PyPI, or the GitHub release asset when "
        "it is ahead), pypi, or github.",
    ),
    snapshot: bool = typer.Option(
        True,
        "--snapshot/--no-snapshot",
        help="Snapshot config and state databases before upgrading (default on).",
    ),
    restore_snapshot: str | None = typer.Option(
        None,
        "--restore-snapshot",
        metavar="DIR|latest",
        help="Put a pre-upgrade snapshot back (gateway must be stopped) and exit.",
    ),
    verify_data: bool = typer.Option(
        False, "--verify-data", help="Only check the state databases; change nothing."
    ),
) -> None:
    """Upgrade AgentOS to the published release and restart the gateway to match.

    Detects the install method (uv-tool / pipx / pip / editable) and delegates
    to the right installer, targeting the release of ``use-agent-os[recommended]``
    on PyPI — or the same wheel from the GitHub release when PyPI is behind —
    including when the current install was built from a local checkout. To
    install a checkout instead, run ``bash scripts/install_source.sh``, which
    rebuilds the Control UI first.

    Before installing, config and the state databases are snapshotted under
    ``~/.agentos/state/snapshots/``; after the restarted gateway has migrated
    them they are checked, and restored from the snapshot if corrupt. Config
    migrations (with an automatic timestamped backup) run at gateway start.
    """

    from agentos.cli.output import print_json

    if source not in _SOURCES:
        console.print(f"[red]--source must be one of:[/red] {', '.join(_SOURCES)}")
        raise typer.Exit(2)

    if restore_snapshot is not None:
        _restore_snapshot_command(
            restore_snapshot, config_path=config_path, json_output=json_output
        )
    if verify_data:
        _verify_data_command(json_output=json_output)

    # --check: ask the release sources without changing anything.
    if check:
        from agentos.compat.version_utils import is_newer

        choice = _choose_release(source)
        latest = choice.latest
        if latest is None:
            if json_output:
                print_json(
                    {"current": __version__, "latest": None, "status": "offline"}
                    | choice.to_payload()
                )
            else:
                console.print("could not check (offline)")
            raise typer.Exit(0)
        newer = is_newer(latest, __version__)
        if json_output:
            print_json(
                {
                    "current": __version__,
                    "latest": latest,
                    "status": "outdated" if newer else "up-to-date",
                }
                | choice.to_payload()
            )
        elif newer:
            console.print(f"A newer version is available: {__version__} → {latest}")
        else:
            console.print(f"Up to date ({__version__}).")
        raise typer.Exit(0)

    choice = _choose_release(source)
    plan = build_upgrade_plan(spec=choice.spec)
    env = hardened_path_env()

    # Non-delegated installs: print the exact manual command, exit 3.
    if not plan.delegated:
        # The hint carries a ``dist[extras]`` spec, whose brackets Rich would
        # otherwise eat as markup — printing a command that silently drops the
        # extras is exactly the failure this whole change is about.
        message = (
            f"AgentOS was installed via {plan.method.value}; automatic upgrade is not "
            f"available for this method.\nRun this to upgrade:\n    "
            f"{markup_escape(plan.manual_hint)}"
        )
        if json_output:
            print_json(
                {
                    "method": plan.method.value,
                    "delegated": False,
                    "manualCommand": plan.manual_hint,
                }
            )
        else:
            console.print(message)
        raise typer.Exit(3)

    # This command always installs the published release. When the current
    # install was built from a local checkout, say so before touching anything.
    source_dir = installed_from_directory()

    # --dry-run: print what would run, touch nothing.
    if dry_run:
        printable = " ".join(plan.command)
        if json_output:
            print_json(
                {
                    "method": plan.method.value,
                    "command": plan.command,
                    "wouldRestart": not no_restart,
                    "wouldSnapshot": snapshot,
                    "dryRun": True,
                    "sourceDirectory": str(source_dir) if source_dir else None,
                }
                | choice.to_payload()
            )
        else:
            if source_dir is not None:
                _emit_source_install_notice(source_dir)
            console.print(f"Would run: {markup_escape(printable)}")
            console.print(
                "Would snapshot config and state databases first."
                if snapshot
                else "Would NOT snapshot state (--no-snapshot)."
            )
            console.print(
                "Would then restart and verify the managed gateway."
                if not no_restart
                else "Would NOT restart the gateway (--no-restart)."
            )
        raise typer.Exit(0)

    # Execute the delegated upgrade under a bounded timeout.
    if source_dir is not None:
        _emit_source_install_notice(source_dir)
    snap = _take_snapshot(json_output=json_output) if snapshot else None
    console.print(f"Upgrading use-agent-os via {plan.method.value} from {choice.source}…")
    result = _run_upgrade_subprocess(plan.command, env=env, timeout=timeout)
    if result.stdout.strip():
        console.print(markup_escape(result.stdout.strip()))

    if result.timed_out:
        console.print(
            f"[red]Upgrade timed out after {timeout:.0f}s and was terminated.[/red]\n"
            "The upgrade tool was killed (process group), so no half-finished child "
            "is left running.\nRecovery: re-run 'agentos upgrade' (optionally with a "
            f"larger --timeout), or run '{markup_escape(plan.manual_hint)}' manually.",
        )
        raise typer.Exit(1)

    if not result.ok:
        console.print(
            f"[red]Upgrade failed (exit {result.returncode}).[/red]\n"
            f"{markup_escape(result.stderr.strip())}"
        )
        raise typer.Exit(1)

    # Report old → new by reading the version from a fresh subprocess of the
    # (now upgraded) executable, avoiding this process's stale metadata cache.
    new_version = _installed_version_via(sys.executable, env=env) or "unknown"
    console.print(f"Upgraded: {__version__} → {new_version}")
    console.print(
        "[dim]Config migrations (with an automatic timestamped backup) run at gateway start.[/dim]"
    )

    snapshot_payload = snap.to_payload() if snap is not None else None

    if no_restart:
        _emit_no_restart_warning(new_version)
        if json_output:
            print_json(
                {
                    "old": __version__,
                    "new": new_version,
                    "source": choice.source,
                    "restarted": False,
                    "gatewayVersionApplied": False,
                    "snapshot": snapshot_payload,
                    "sourceDirectory": str(source_dir) if source_dir else None,
                }
            )
        raise typer.Exit(0)

    verified = _restart_and_verify(
        config_path=config_path,
        expected_version=new_version,
        json_output=json_output,
    )
    # Only a gateway that verifiably runs the new code has migrated the data;
    # checking before that would only ever look at the old gateway's files.
    data_payload: dict[str, object] = {}
    if verified:
        data_payload = _verify_data_after_restart(
            config_path=config_path, snapshot=snap, json_output=json_output
        )
    if json_output:
        print_json(
            {
                "old": __version__,
                "new": new_version,
                "source": choice.source,
                "restarted": True,
                "verified": verified,
                "snapshot": snapshot_payload,
                "sourceDirectory": str(source_dir) if source_dir else None,
            }
            | data_payload
        )
    if not verified:
        raise typer.Exit(1)
    data = data_payload.get("data")
    if isinstance(data, dict) and data.get("ok") is False:
        raise typer.Exit(1)
    raise typer.Exit(0)
