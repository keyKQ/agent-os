"""Control UI route factory — serves the Vite-built React console with SPA fallback.

The gateway serves the React app built by ``frontend/`` into
``webui_dist/`` (``index.html`` with Jinja placeholders preserved as the
bootstrap bridge, plus hashed ``assets/``). The legacy ``static/`` +
``templates/`` trees remain on disk (imported by legacy static tests) but are
no longer what these routes serve.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import jinja2
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from agentos import __version__
from agentos.gateway.config import GatewayConfig

# Conservative max-age for hashed static assets. 30 days is long enough that hot
# clients save roundtrips but short enough that any deploy without a version
# bump still becomes visible within a release cycle. Vite hashes every asset
# filename so a code change ships a new URL and cache invalidation is immediate;
# this header only saves repeat hits for unchanged bytes within the window.
#
# Skip when AGENTOS_STATIC_NO_CACHE is set (debugging / forced refresh).
# Skip on non-200 responses so 206 Range and 304 conditional reuse stay
# untouched.
_STATIC_CACHE_CONTROL = "public, max-age=2592000"

# Message naming the exact build command, reused by the request-time 503 and the
# wheel-build guard so operators and packagers see one canonical instruction.
_BUILD_HINT = "npm --prefix frontend ci && npm --prefix frontend run build"


class _CachedStaticFiles(StaticFiles):
    """StaticFiles subclass that attaches Cache-Control to 200 responses.

    Subclassing rather than middleware-wrapping keeps the header scoped to the
    assets mount only. Range (206) and conditional-GET (304) flows pass
    through unchanged so browsers' Last-Modified / ETag logic continues
    working.
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200 and not os.environ.get(
            "AGENTOS_STATIC_NO_CACHE"
        ):
            response.headers.setdefault("Cache-Control", _STATIC_CACHE_CONTROL)
        return response


# Legacy trees kept for import-compatibility with the pre-Vite static tests.
_TEMPLATE_DIR = Path(__file__).parent / "templates"
_STATIC_DIR = Path(__file__).parent / "static"


def _webui_dist_dir() -> Path:
    """Resolve the Vite ``webui_dist`` directory (single seam for tests).

    Kept a plain module-level function so tests can monkeypatch it to point at
    a synthesized fake dist without touching module import paths.
    """
    return Path(__file__).parent / "webui_dist"


def ensure_webui_dist_built(dist_dir: Path) -> None:
    """Raise if ``dist_dir/index.html`` is absent, naming the build command.

    Pure helper wired into the hatchling build hook so a wheel is never built
    without the front-end bundle. Also unit-tested directly.
    """
    if not (dist_dir / "index.html").is_file():
        raise FileNotFoundError(
            f"Vite build output missing: {dist_dir / 'index.html'} not found. "
            f"Build the web UI first: {_BUILD_HINT}"
        )


# Process-start timestamp baked into the template-only version string so every
# gateway restart busts the browser cache for the injected bootstrap version.
# config.version itself is preserved for protocol/RPC consumers that expect a
# stable string.
_TEMPLATE_VERSION_SUFFIX = str(int(time.time()))


def _render_index(dist_dir: Path, ctx: dict) -> str:
    """Render ``webui_dist/index.html`` through Jinja with the bootstrap ctx.

    The Jinja env is built against the resolved dist dir per call so the
    ``_webui_dist_dir`` seam (and thus tests pointing at a tmp dist) is honored.
    """
    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(dist_dir)),
        autoescape=True,
    )
    env.filters["tojson"] = lambda v, **kw: json.dumps(v)
    template = env.get_template("index.html")
    return template.render(**ctx)


def _request_ws_url(request: Request, config: GatewayConfig) -> str:
    """Build the browser-facing websocket URL from the current request."""
    host = request.headers.get("host") or f"{config.host}:{config.port}"
    if config.host in {"0.0.0.0", "::"} and host == "testserver":
        host = f"127.0.0.1:{config.port}"
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    ws_scheme = "wss" if scheme == "https" else "ws"
    return f"{ws_scheme}://{host}/ws"


def _build_bootstrap_context(config: GatewayConfig, request: Request) -> dict:
    """Build the template context for bootstrap config injection."""
    return {
        "version": f"{__version__}+{_TEMPLATE_VERSION_SUFFIX}",
        "ws_url": _request_ws_url(request, config),
        "auth_mode": config.auth.mode,
        "base_path": config.control_ui.base_path,
        "config_path": config.config_path or "",
        "features": {
            "diagnostics": config.diagnostics_enabled,
        },
    }


def create_control_ui_routes(config: GatewayConfig) -> list[Route | Mount]:
    """Create routes for the Control UI. Returns empty list if disabled."""
    if not config.control_ui.enabled:
        return []

    base = config.control_ui.base_path

    async def serve_index(request: Request) -> HTMLResponse | PlainTextResponse:
        dist_dir = _webui_dist_dir()
        if not (dist_dir / "index.html").is_file():
            return PlainTextResponse(
                "Web UI build output not found. Build it first:\n"
                f"  {_BUILD_HINT}\n",
                status_code=503,
            )
        ctx = _build_bootstrap_context(config, request)
        html = _render_index(dist_dir, ctx)
        # Shell is never cached: it is the Jinja-rendered bootstrap bridge and
        # must reflect live config (ws_url, auth_mode) on every load. Hashed
        # assets carry the long cache instead.
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    async def serve_bootstrap(request: Request) -> JSONResponse:
        # camelCase JSON contract consumed by the Vite dev server's bootstrap.ts.
        # Lives under base_path so AuthMiddleware exempts it (same exposure as
        # the data already inlined into the unauthenticated HTML shell).
        ctx = _build_bootstrap_context(config, request)
        return JSONResponse(
            {
                "version": ctx["version"],
                "wsUrl": ctx["ws_url"],
                "authMode": ctx["auth_mode"],
                "basePath": ctx["base_path"],
                "configPath": ctx["config_path"],
            },
            headers={"Cache-Control": "no-cache"},
        )

    return [
        Mount(
            f"{base}/assets",
            # check_dir=False: a fresh checkout has no built assets/ dir yet;
            # route construction must still succeed (the shell route returns a
            # 503 with the build command, and asset requests 404 cleanly).
            app=_CachedStaticFiles(
                directory=str(_webui_dist_dir() / "assets"), check_dir=False
            ),
            name="control_ui_assets",
        ),
        Route(f"{base}/bootstrap.json", serve_bootstrap, methods=["GET"]),
        Route(f"{base}/{{path:path}}", serve_index, methods=["GET"]),
        Route(f"{base}/", serve_index, methods=["GET"]),
    ]
