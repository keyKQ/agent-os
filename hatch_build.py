"""Hatchling build hook: fail the wheel build if the Vite web UI is unbuilt.

The gateway serves ``src/agentos/gateway/webui_dist/index.html`` (built by
``frontend/``). Packaging a wheel without it would ship a Control UI that 503s,
so this hook aborts the build early with the exact build command.

The check is a self-contained function here (not imported from the package):
the wheel build runs in an isolated environment where ``agentos`` is not yet
importable, so the hook must not depend on it. The package ships its own
:func:`agentos.gateway.control_ui.ensure_webui_dist_built` — same contract,
unit-tested there — for runtime/test use.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

_DIST_INDEX = Path("src") / "agentos" / "gateway" / "webui_dist" / "index.html"
_BUILD_HINT = "npm --prefix frontend ci && npm --prefix frontend run build"


def _ensure_webui_dist_built(root: Path) -> None:
    """Raise if the built web UI index is absent, naming the build command."""
    index = root / _DIST_INDEX
    if not index.is_file():
        raise FileNotFoundError(
            f"Vite build output missing: {index} not found. "
            f"Build the web UI first: {_BUILD_HINT}"
        )


def _should_enforce(version: str) -> bool:
    """Only real distribution builds ("standard") need the dist present.

    Hatchling's ``WheelBuilder.get_targets`` maps the string ``"editable"``
    to ``build_editable`` and ``"standard"`` to ``build_standard``; whichever
    key is selected is passed straight through as ``versions=[key]`` to
    ``BuilderInterface.build``, which calls ``build_hook.initialize(version,
    build_data)`` once per version with that same string (see
    ``hatchling/builders/wheel.py`` and
    ``hatchling/builders/plugin/interface.py`` in the installed hatchling).
    So an editable install (what ``uv sync`` performs) invokes this hook with
    ``version == "editable"``. Skip the guard in that case: the gateway
    already 503s with the build hint at runtime when the dist is missing, so
    Python-only contributors and CI jobs without a frontend build can still
    install the package editable.
    """
    return version != "editable"


class WebUiBuildHook(BuildHookInterface):
    """Abort real (non-editable) builds when ``webui_dist`` is missing."""

    PLUGIN_NAME = "webui-guard"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if not _should_enforce(version):
            return
        _ensure_webui_dist_built(Path(self.root))
