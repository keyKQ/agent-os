"""``agentos --version``: the launch-time smoke test the desktop app relies on."""

from __future__ import annotations

from typer.testing import CliRunner

from agentos import __version__
from agentos.cli.main import app

runner = CliRunner()


def test_version_flag_prints_only_the_version() -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


def test_short_version_flag() -> None:
    result = runner.invoke(app, ["-V"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


def test_no_args_still_shows_help() -> None:
    result = runner.invoke(app, [])
    assert "Usage" in result.output
