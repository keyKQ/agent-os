"""Install-method detection + PATH hardening (Hermes lesson)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from agentos.cli import install_method as im
from agentos.cli.install_method import InstallMethod


@pytest.mark.parametrize(
    ("exe", "pkg", "expected"),
    [
        # uv tool install
        (
            "/home/u/.local/share/uv/tools/use-agent-os/bin/python",
            "/home/u/.local/share/uv/tools/use-agent-os/lib/python3.12/site-packages/agentos",
            InstallMethod.UV_TOOL,
        ),
        # pipx venv
        (
            "/home/u/.local/share/pipx/venvs/use-agent-os/bin/python",
            "/home/u/.local/share/pipx/venvs/use-agent-os/lib/python3.12/site-packages/agentos",
            InstallMethod.PIPX,
        ),
        # plain pip into a virtualenv site-packages
        (
            "/home/u/venv/bin/python",
            "/home/u/venv/lib/python3.12/site-packages/agentos",
            InstallMethod.PIP,
        ),
        # system dist-packages
        (
            "/usr/bin/python3",
            "/usr/lib/python3/dist-packages/agentos",
            InstallMethod.PIP,
        ),
    ],
)
def test_detect_install_method(
    exe: str, pkg: str, expected: InstallMethod
) -> None:
    assert im.detect_install_method(executable=exe, package_dir=Path(pkg)) == expected


def test_editable_checkout_detected(tmp_path: Path) -> None:
    # Mimic a src/agentos editable layout with a sibling pyproject.toml.
    src = tmp_path / "src"
    pkg = src / "agentos"
    pkg.mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text("[project]\nname='use-agent-os'\n")
    assert (
        im.detect_install_method(executable="/usr/bin/python3", package_dir=pkg)
        == InstallMethod.EDITABLE
    )


def test_hardened_path_appends_login_dirs() -> None:
    env = {"PATH": "/custom/bin", "HOME": "/home/u"}
    out = im.hardened_path_env(env)
    parts = out["PATH"].split(os.pathsep)
    assert parts[0] == "/custom/bin"  # operator ordering preserved
    assert "/opt/homebrew/bin" in parts
    assert "/usr/local/bin" in parts
    assert "/home/u/.local/bin" in parts


def test_hardened_path_no_duplicates() -> None:
    env = {"PATH": "/opt/homebrew/bin:/x", "HOME": "/home/u"}
    parts = im.hardened_path_env(env)["PATH"].split(os.pathsep)
    assert parts.count("/opt/homebrew/bin") == 1


def test_resolve_tool_uses_hardened_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # uv lives in a login dir NOT on the base PATH.
    brew = tmp_path / "opt" / "homebrew" / "bin"
    brew.mkdir(parents=True)
    uv_bin = brew / "uv"
    uv_bin.write_text("#!/bin/sh\n")
    uv_bin.chmod(0o755)

    import agentos.cli.install_method as mod

    monkeypatch.setattr(mod, "_LOGIN_PATH_DIRS", (str(brew),))
    resolved = im.resolve_tool("uv", {"PATH": "/nowhere", "HOME": str(tmp_path)})
    assert resolved == str(uv_bin.resolve())


def test_resolve_tool_missing_returns_none() -> None:
    assert im.resolve_tool("definitely-not-a-real-tool-xyz", {"PATH": "/nonexistent"}) is None


def test_build_plan_uv_tool_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(im, "resolve_tool", lambda tool, env=None: "/abs/uv")
    plan = im.build_upgrade_plan(method=InstallMethod.UV_TOOL)
    assert plan.delegated is True
    assert plan.tool == "/abs/uv"
    assert plan.command == ["/abs/uv", "tool", "upgrade", "use-agent-os"]


def test_build_plan_uv_tool_missing_uv_not_delegated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(im, "resolve_tool", lambda tool, env=None: None)
    plan = im.build_upgrade_plan(method=InstallMethod.UV_TOOL)
    assert plan.delegated is False
    assert plan.tool is None
    assert "uv tool upgrade" in plan.manual_hint


def test_build_plan_pipx_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(im, "resolve_tool", lambda tool, env=None: "/abs/pipx")
    plan = im.build_upgrade_plan(method=InstallMethod.PIPX)
    assert plan.delegated is True
    assert plan.command == ["/abs/pipx", "upgrade", "use-agent-os"]


def test_build_plan_pip_never_delegates() -> None:
    plan = im.build_upgrade_plan(method=InstallMethod.PIP)
    assert plan.delegated is False
    assert "pip install --upgrade use-agent-os" in plan.manual_hint


def test_build_plan_editable_never_delegates() -> None:
    plan = im.build_upgrade_plan(method=InstallMethod.EDITABLE)
    assert plan.delegated is False
    assert "git pull" in plan.manual_hint
