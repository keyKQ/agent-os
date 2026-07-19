"""Tiny isolated PyPI client for the upgrade check + passive update notice.

Network access is quarantined here so every caller (``agentos upgrade
--check``, the passive update notice, the skew path) shares one code path that
is trivially mockable in tests. The client never raises on a network / offline
failure: it returns ``None`` so callers degrade to "could not check" instead of
crashing a command whose real job is something else.
"""

from __future__ import annotations

DIST_NAME = "use-agent-os"
_PYPI_JSON_URL = "https://pypi.org/pypi/{dist}/json"


def latest_version(
    dist: str = DIST_NAME,
    *,
    timeout: float = 5.0,
) -> str | None:
    """Return the latest released version string of ``dist`` on PyPI.

    Returns ``None`` on any failure (offline, timeout, HTTP error, malformed
    body). Yanked-only / pre-release-only edge cases fall back to the
    ``info.version`` field PyPI reports as canonical.
    """

    try:
        import httpx
    except ImportError:  # pragma: no cover - httpx is a hard dependency
        return None

    url = _PYPI_JSON_URL.format(dist=dist)
    try:
        response = httpx.get(
            url,
            timeout=timeout,
            headers={"Accept": "application/json"},
            follow_redirects=True,
        )
    except Exception:  # noqa: BLE001 - offline / DNS / TLS / timeout all degrade to None
        return None

    if response.status_code != 200:
        return None

    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - malformed body
        return None

    if not isinstance(body, dict):
        return None
    info = body.get("info")
    if isinstance(info, dict):
        version = info.get("version")
        if isinstance(version, str) and version.strip():
            return version.strip()
    return None
