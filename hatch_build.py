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


class WebUiBuildHook(BuildHookInterface):
    """Abort the build when the Vite ``webui_dist`` bundle is missing."""

    PLUGIN_NAME = "webui-guard"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        _ensure_webui_dist_built(Path(self.root))
