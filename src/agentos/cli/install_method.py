"""Detect how the running ``agentos`` was installed and how to upgrade it.

Two independent hazards from the OpenClaw / Hermes case studies drive this
module:

* **Wrong upgrade channel** — running ``pip install -U`` against a uv-tool
  install silently no-ops (or corrupts the tool venv). We inspect where the
  running executable / package actually lives and pick the matching upgrade
  command, and for plain-pip / editable installs we refuse to fake it.

* **PATH gaps on macOS** (Hermes's #1 incident cluster) — the upgrade
  subprocess hangs or fails because ``uv`` / ``pipx`` is not on the ``PATH``
  the daemon inherited. We resolve the delegated tool to an ABSOLUTE path
  against an environment augmented with the standard login locations before
  spawning anything.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

DIST_NAME = "use-agent-os"

# Standard login-shell locations that a GUI-launched or daemon-inherited
# environment frequently drops. Appended (not prepended) so an operator's own
# PATH ordering still wins.
_LOGIN_PATH_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
)


class InstallMethod(StrEnum):
    UV_TOOL = "uv-tool"
    PIPX = "pipx"
    PIP = "pip"
    EDITABLE = "editable"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class UpgradePlan:
    """How to upgrade the running install.

    ``delegated`` is True when AgentOS can run the upgrade itself (uv-tool /
    pipx). When False, ``command`` is the exact command the operator must run
    by hand and the ``upgrade`` command exits 3 rather than pretending.
    """

    method: InstallMethod
    delegated: bool
    tool: str | None
    command: list[str]
    manual_hint: str


def _package_location() -> Path:
    """Absolute path to the installed ``agentos`` package directory."""

    import agentos

    return Path(agentos.__file__).resolve().parent


def _looks_editable(pkg_dir: Path) -> bool:
    """True when the package is imported from a source checkout (editable/-e).

    An editable install lives in the project tree (``src/agentos``) rather than
    under a ``site-packages`` directory.
    """

    parts = pkg_dir.parts
    if "site-packages" in parts or "dist-packages" in parts:
        return False
    # ``src/agentos`` layout is the tell-tale of this repo's editable install.
    return pkg_dir.parent.name == "src" or (pkg_dir.parent / "pyproject.toml").exists()


def _under(path: Path, *needles: str) -> bool:
    lowered = [part.lower() for part in path.parts]
    return any(needle in lowered for needle in needles)


def detect_install_method(
    *,
    executable: str | None = None,
    package_dir: Path | None = None,
) -> InstallMethod:
    """Classify the running install.

    ``executable`` / ``package_dir`` are injectable for tests; they default to
    ``sys.executable`` and the real ``agentos`` package location.
    """

    exe = Path(executable or sys.executable).resolve()
    pkg_dir = package_dir if package_dir is not None else _package_location()

    # Editable / source checkout first: it can otherwise masquerade as pip.
    if _looks_editable(pkg_dir):
        return InstallMethod.EDITABLE

    # uv tool installs live under the uv tools root, e.g.
    #   ~/.local/share/uv/tools/use-agent-os/...
    #   $XDG_DATA_HOME/uv/tools/... / $UV_TOOL_DIR/...
    for candidate in (exe, pkg_dir):
        parts = [p.lower() for p in candidate.parts]
        if "uv" in parts and "tools" in parts:
            return InstallMethod.UV_TOOL

    # pipx venvs: ~/.local/share/pipx/venvs/<name>/ or $PIPX_HOME/venvs/...
    for candidate in (exe, pkg_dir):
        if _under(candidate, "pipx"):
            return InstallMethod.PIPX

    if "site-packages" in [p.lower() for p in pkg_dir.parts] or "dist-packages" in [
        p.lower() for p in pkg_dir.parts
    ]:
        return InstallMethod.PIP

    return InstallMethod.UNKNOWN


def hardened_path_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """Return an env copy whose ``PATH`` includes the standard login dirs.

    The augmented directories are *appended* so an operator's own ordering is
    preserved; only genuinely-missing login locations are added.
    """

    env = dict(base_env if base_env is not None else os.environ)
    current = env.get("PATH", "")
    entries = [p for p in current.split(os.pathsep) if p]
    seen = set(entries)
    home = env.get("HOME") or str(Path.home())
    login_dirs = list(_LOGIN_PATH_DIRS) + [str(Path(home) / ".local" / "bin")]
    for extra in login_dirs:
        if extra not in seen:
            entries.append(extra)
            seen.add(extra)
    env["PATH"] = os.pathsep.join(entries)
    return env


def resolve_tool(tool: str, env: dict[str, str] | None = None) -> str | None:
    """Resolve ``tool`` (``uv`` / ``pipx``) to an ABSOLUTE path.

    Uses a PATH-hardened environment so a daemon-inherited PATH missing
    ``/opt/homebrew/bin`` etc. still finds the tool. Returns ``None`` when the
    tool genuinely cannot be found.
    """

    hardened = hardened_path_env(env)
    resolved = shutil.which(tool, path=hardened.get("PATH"))
    if resolved:
        return str(Path(resolved).resolve())
    return None


def build_upgrade_plan(
    *,
    method: InstallMethod | None = None,
    env: dict[str, str] | None = None,
    dist: str = DIST_NAME,
) -> UpgradePlan:
    """Build the :class:`UpgradePlan` for the running install."""

    resolved_method = method if method is not None else detect_install_method()

    if resolved_method is InstallMethod.UV_TOOL:
        uv = resolve_tool("uv", env)
        if uv is not None:
            return UpgradePlan(
                method=resolved_method,
                delegated=True,
                tool=uv,
                command=[uv, "tool", "upgrade", dist],
                manual_hint=f"uv tool upgrade {dist}",
            )
        return UpgradePlan(
            method=resolved_method,
            delegated=False,
            tool=None,
            command=["uv", "tool", "upgrade", dist],
            manual_hint=f"uv tool upgrade {dist}",
        )

    if resolved_method is InstallMethod.PIPX:
        pipx = resolve_tool("pipx", env)
        if pipx is not None:
            return UpgradePlan(
                method=resolved_method,
                delegated=True,
                tool=pipx,
                command=[pipx, "upgrade", dist],
                manual_hint=f"pipx upgrade {dist}",
            )
        return UpgradePlan(
            method=resolved_method,
            delegated=False,
            tool=None,
            command=["pipx", "upgrade", dist],
            manual_hint=f"pipx upgrade {dist}",
        )

    if resolved_method is InstallMethod.EDITABLE:
        return UpgradePlan(
            method=resolved_method,
            delegated=False,
            tool=None,
            command=["git", "pull"],
            manual_hint=(
                "editable / source checkout — pull the repo and reinstall: "
                "git pull && uv sync"
            ),
        )

    # PIP + UNKNOWN: hand back the exact pip command, never fake it.
    pip_cmd = [sys.executable, "-m", "pip", "install", "--upgrade", dist]
    return UpgradePlan(
        method=resolved_method,
        delegated=False,
        tool=None,
        command=pip_cmd,
        manual_hint=f"{sys.executable} -m pip install --upgrade {dist}",
    )
