"""Tests for the gateway serving the Vite-built ``webui_dist`` bundle.

The Control UI now renders the React app's built ``index.html`` (Jinja
placeholders preserved as the bootstrap bridge) and serves hashed assets from
``webui_dist/assets`` behind the 30-day ``_CachedStaticFiles`` cache. A
``{base_path}/bootstrap.json`` endpoint exposes the same bootstrap fields as
JSON for the Vite dev server; it is exempt from token auth because it lives
under the control-UI base_path.

Because ``webui_dist/`` is a build artifact that may be absent in a fresh
checkout, these tests synthesize a minimal fake dist in a tmp dir and point the
app at it via the ``_webui_dist_dir`` resolver seam.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from agentos.gateway import control_ui
from agentos.gateway.config import GatewayConfig

# The built index.html ships these Jinja placeholders; rendering must fill them.
_FAKE_INDEX = """<!DOCTYPE html>
<html lang="en">
<head>
  <title>AgentOS Control</title>
  <link rel="icon" href="{{ base_path }}/static/img/mark.png?v={{ version }}">
  <script type="module" crossorigin src="./assets/index-DEADBEEF.js"></script>
</head>
<body>
  <div id="app"></div>
  <div id="agentos-data"
       data-version="{{ version }}"
       data-ws-url="{{ ws_url }}"
       data-auth-mode="{{ auth_mode }}"
       data-base-path="{{ base_path }}"
       data-config-path="{{ config_path }}"
       style="display:none"></div>
</body>
</html>
"""


def _make_fake_dist(tmp_path: Path) -> Path:
    """Create a minimal fake webui_dist (index.html + one hashed asset)."""
    dist = tmp_path / "webui_dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(_FAKE_INDEX, encoding="utf-8")
    (dist / "assets" / "index-DEADBEEF.js").write_text(
        "console.log('agentos');\n", encoding="utf-8"
    )
    return dist


@pytest.fixture
def _fake_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("AGENTOS_STATIC_NO_CACHE", raising=False)
    dist = _make_fake_dist(tmp_path)
    monkeypatch.setattr(control_ui, "_webui_dist_dir", lambda: dist)
    return dist


def _app(config: GatewayConfig) -> Starlette:
    config.control_ui.enabled = True
    return Starlette(routes=control_ui.create_control_ui_routes(config))


# --- (a) index shell renders with bootstrap data ---------------------------


def test_index_returns_html_with_base_path(_fake_dist: Path) -> None:
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/")
    assert response.status_code == 200, response.text
    assert 'id="agentos-data"' in response.text
    assert 'data-base-path="/control"' in response.text
    # Jinja placeholders are filled, not left literal.
    assert "{{ base_path }}" not in response.text


# --- (b) hashed asset carries long cache-control ---------------------------


def test_hashed_asset_carries_long_cache_control(_fake_dist: Path) -> None:
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/assets/index-DEADBEEF.js")
    assert response.status_code == 200, response.text
    cache = response.headers.get("Cache-Control", "")
    assert "max-age=2592000" in cache, cache
    assert "public" in cache, cache


def test_env_rollback_disables_asset_cache_control(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # AGENTOS_STATIC_NO_CACHE=1 must skip the long Cache-Control so a release
    # with a static-cache problem can be defused without a redeploy.
    dist = _make_fake_dist(tmp_path)
    monkeypatch.setattr(control_ui, "_webui_dist_dir", lambda: dist)
    monkeypatch.setenv("AGENTOS_STATIC_NO_CACHE", "1")
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/assets/index-DEADBEEF.js")
    assert response.status_code == 200
    assert "max-age=2592000" not in response.headers.get("Cache-Control", "")


def test_missing_asset_does_not_get_long_cache(_fake_dist: Path) -> None:
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/assets/does-not-exist-12345.js")
    assert response.status_code == 404
    assert "max-age=2592000" not in response.headers.get("Cache-Control", "")


# --- (c) index gets no-cache ----------------------------------------------


def test_index_response_is_no_cache(_fake_dist: Path) -> None:
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/")
    assert response.status_code == 200
    assert "no-cache" in response.headers.get("Cache-Control", "")
    assert "max-age=2592000" not in response.headers.get("Cache-Control", "")


def test_spa_catch_all_serves_index(_fake_dist: Path) -> None:
    # A deep client-route path (no matching file) falls through to the shell.
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/sessions/abc")
    assert response.status_code == 200
    assert 'id="agentos-data"' in response.text


# --- (d) bootstrap.json returns the five fields ----------------------------


def test_bootstrap_returns_five_fields(_fake_dist: Path, tmp_path: Path) -> None:
    config = GatewayConfig()
    config.config_path = str(tmp_path / "AgentOS Config.toml")
    client = TestClient(_app(config))
    response = client.get("/control/bootstrap.json")
    assert response.status_code == 200, response.text
    data = response.json()
    assert set(data) == {"version", "wsUrl", "authMode", "basePath", "configPath"}
    assert data["basePath"] == "/control"
    assert data["authMode"] == config.auth.mode
    assert data["configPath"] == config.config_path
    assert data["wsUrl"].startswith("ws")


def test_bootstrap_is_reachable_without_auth_token(
    _fake_dist: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # bootstrap.json lives under the control-UI base_path, which AuthMiddleware
    # exempts — so it must return 200 with NO Authorization header even when
    # token auth is configured. This is what keeps the Vite dev-server flow
    # working. Build the full app so AuthMiddleware is in the stack.
    from agentos.gateway.app import create_gateway_app

    config = GatewayConfig()
    config.auth.mode = "token"
    config.auth.token = "secret-token"  # noqa: S105
    config.control_ui.enabled = True
    dist = _fake_dist
    monkeypatch.setattr(control_ui, "_webui_dist_dir", lambda: dist)
    app = create_gateway_app(config)
    client = TestClient(app)
    # Loopback Host header satisfies the DNS-rebinding guard; still no
    # Authorization header — that is what this test pins.
    response = client.get("/control/bootstrap.json", headers={"host": "127.0.0.1"})
    assert response.status_code == 200, response.text
    assert response.json()["basePath"] == "/control"


# --- (e) wheel guard -------------------------------------------------------


def test_wheel_guard_raises_when_index_missing(tmp_path: Path) -> None:
    from agentos.gateway.control_ui import ensure_webui_dist_built

    missing = tmp_path / "webui_dist"  # does not exist
    with pytest.raises(FileNotFoundError) as exc:
        ensure_webui_dist_built(missing)
    msg = str(exc.value)
    assert "npm --prefix frontend" in msg
    assert "run build" in msg


def test_wheel_guard_passes_when_index_present(tmp_path: Path) -> None:
    from agentos.gateway.control_ui import ensure_webui_dist_built

    dist = _make_fake_dist(tmp_path)
    # Must not raise.
    ensure_webui_dist_built(dist)


# --- missing dist at request time → 503 ------------------------------------


def test_missing_dist_returns_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "webui_dist"  # never created
    monkeypatch.setattr(control_ui, "_webui_dist_dir", lambda: missing)
    config = GatewayConfig()
    client = TestClient(_app(config))
    response = client.get("/control/")
    assert response.status_code == 503
    assert "npm --prefix frontend" in response.text
