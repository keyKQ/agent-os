# React+Vite Console Rewrite — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `frontend/` React 19 + Vite 6 toolchain, parity-matrix tooling, typed WS-RPC client, AppShell with all 13 routes stubbed, and the first fully-migrated view (Health) — without touching how the legacy UI is served.

**Architecture:** New FE source lives in `frontend/` (outside the wheel), builds to `src/agentos/gateway/static/dist/` (gitignored; wheel-packaged at release). During this plan the legacy UI keeps being served unchanged; the new app runs via `vite dev` proxying `/ws` and `/control/api` to a running gateway. A new `GET {base}/api/bootstrap` JSON endpoint replaces Jinja data-attr injection for the new app only.

**Tech Stack:** React 19, Vite 6, TypeScript (strict), Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui (code-owned components), TanStack Query v5, Zustand v5, React Router v7 (library mode, `react-router` package), Vitest 3 + React Testing Library 16 + jsdom, ESLint 9 (flat) + typescript-eslint 8 + Prettier 3, lucide-react icons, sonner toasts.

**Spec:** `docs/superpowers/specs/2026-07-19-react-vite-console-rewrite-design.md` (esp. §6 migration protocol).

## Global Constraints

- Node >= 22 (LTS) for all FE tooling; Python-side unchanged (uv, Python 3.12).
- TypeScript `strict: true`; no `any` except in explicitly-commented WS frame parsing seams.
- `src/agentos/gateway/static/dist/` is **gitignored** — never commit build output.
- **No RPC/backend behavior changes.** The only backend addition in this plan is the read-only `GET {base}/api/bootstrap` endpoint.
- Legacy `static/js`, `static/css`, `vendor/`, Jinja template stay untouched and keep serving `/control/` until the cutover plan.
- Vite `base` is `/control/static/dist/` (assets resolve under the existing static mount; custom `base_path` handling is an explicit cutover-plan item, noted in the parity matrix).
- WS localStorage keys preserved verbatim: `agentos.wsUrl`, `agentos.wsToken`, `agentos-theme`.
- Commit messages: conventional commits, **no AI attribution trailers** (repo rule).
- Python quality gate for touched Python files: `uv run ruff check`, `uv run mypy`, `uv run pytest` for the touched test modules. FE gate: `npm run check` (defined in Task 2).
- Every task that ports legacy behavior updates the parity matrix rows for that behavior (`pending` → `ported` + evidence) in the same commit.

## File Structure (this plan)

```
scripts/fe_parity_inventory.py          # mechanical legacy-inventory extractor
tests/test_fe_parity_inventory.py       # tests for the extractor
docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md  # generated + hand-curated
frontend/
  package.json  vite.config.ts  tsconfig.json  tsconfig.node.json
  eslint.config.js  .prettierrc.json  index.html
  src/main.tsx
  src/vite-env.d.ts
  src/test/setup.ts
  src/lib/bootstrap.ts                  # bootstrap fetch + types
  src/lib/ws-rpc.ts                     # WsRpcClient (typed port of rpc.js)
  src/lib/ws-rpc.test.ts
  src/stores/theme.ts                   # Zustand theme store (port of theme.js)
  src/stores/theme.test.ts
  src/stores/connection.ts              # Zustand connection-state store
  src/app/providers.tsx                 # QueryClient + bootstrap + rpc context
  src/app/AppShell.tsx                  # sidebar/nav/topbar/connection banner
  src/app/routes.tsx                    # 13 routes (12 stubs + Health)
  src/app/AppShell.test.tsx
  src/components/ui/*                   # shadcn/ui (button, card, sonner…)
  src/styles/globals.css                # Tailwind v4 entry + design tokens
  src/views/health/logic.ts             # pure helpers ported from health.js
  src/views/health/logic.test.ts
  src/views/health/HealthPage.tsx
  src/views/health/HealthPage.test.tsx
src/agentos/gateway/control_ui.py       # + /api/bootstrap route (modify)
tests/test_gateway/test_control_ui_bootstrap.py
.github/workflows/frontend.yml          # FE CI lane
AGENTS.md                               # + FE lane section (modify)
.gitignore                              # + dist ignore (modify)
```

---

### Task 1: Parity-inventory extractor + initial parity matrix

**Files:**
- Create: `scripts/fe_parity_inventory.py`
- Test: `tests/test_fe_parity_inventory.py`
- Create (generated then committed): `docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md`

**Interfaces:**
- Produces: `extract_rpc_methods(js_text: str) -> set[str]`, `extract_routes(js_text: str) -> set[str]`, `extract_storage_keys(js_text: str) -> set[str]`, CLI `uv run python scripts/fe_parity_inventory.py` printing a markdown inventory. Later plans re-run the CLI for the §6.3 mechanical diffs.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_fe_parity_inventory.py
from scripts.fe_parity_inventory import (
    extract_rpc_methods,
    extract_routes,
    extract_storage_keys,
)


def test_extracts_rpc_methods_from_call_sites():
    js = """
    const r = await _rpc.call('doctor.status', { agentId: 'main' });
    rpc.call("sessions.list");
    this._rpc.call('cron.jobs.create', params)
    """
    assert extract_rpc_methods(js) == {
        "doctor.status",
        "sessions.list",
        "cron.jobs.create",
    }


def test_extracts_router_registrations():
    js = "Router.register('/overview', f, d, { title: 'Overview' });\nRouter.register('/health', f2);"
    assert extract_routes(js) == {"/overview", "/health"}


def test_extracts_storage_keys():
    js = """
    localStorage.getItem('agentos-theme');
    const WS_URL_KEY = 'agentos.wsUrl';
    localStorage.setItem(WS_URL_KEY, url);
    sessionStorage.removeItem("agentos.draft");
    """
    # Direct string literals inside get/set/remove calls are captured;
    # constants are caught by the literal-assignment fallback pattern.
    assert "agentos-theme" in extract_storage_keys(js)
    assert "agentos.wsUrl" in extract_storage_keys(js)
    assert "agentos.draft" in extract_storage_keys(js)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_fe_parity_inventory.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scripts.fe_parity_inventory'`

- [ ] **Step 3: Implement the extractor**

```python
# scripts/fe_parity_inventory.py
"""Mechanical inventory of the legacy control-UI for the React rewrite.

Extracts RPC methods, SPA routes, and web-storage keys from the legacy
vanilla-JS source. Used to seed the parity matrix and, at cutover, to diff
legacy usage against the new frontend (spec §6.3).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

LEGACY_JS = Path(__file__).resolve().parents[1] / "src/agentos/gateway/static/js"

_RPC_CALL = re.compile(r"""\.call\(\s*['"]([a-zA-Z0-9_.]+)['"]""")
_ROUTE = re.compile(r"""Router\.register\(\s*['"]([^'"]+)['"]""")
_STORAGE_CALL = re.compile(
    r"""(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]"""
)
# Fallback: constants like `const WS_URL_KEY = 'agentos.wsUrl';`
_STORAGE_CONST = re.compile(r"""_KEY\s*=\s*['"]([^'"]+)['"]""")


def extract_rpc_methods(js_text: str) -> set[str]:
    return set(_RPC_CALL.findall(js_text))


def extract_routes(js_text: str) -> set[str]:
    return set(_ROUTE.findall(js_text))


def extract_storage_keys(js_text: str) -> set[str]:
    return set(_STORAGE_CALL.findall(js_text)) | set(_STORAGE_CONST.findall(js_text))


def main() -> int:
    methods: dict[str, set[str]] = {}
    routes: set[str] = set()
    keys: dict[str, set[str]] = {}
    for path in sorted(LEGACY_JS.rglob("*.js")):
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(LEGACY_JS.parent.parent))
        for m in extract_rpc_methods(text):
            methods.setdefault(m, set()).add(rel)
        routes |= extract_routes(text)
        for k in extract_storage_keys(text):
            keys.setdefault(k, set()).add(rel)

    print("## Mechanical inventory (generated by scripts/fe_parity_inventory.py)\n")
    print(f"### RPC methods ({len(methods)})\n")
    print("| method | legacy sources |")
    print("| --- | --- |")
    for m in sorted(methods):
        print(f"| `{m}` | {', '.join(sorted(methods[m]))} |")
    print(f"\n### Routes ({len(routes)})\n")
    for r in sorted(routes):
        print(f"- `{r}`")
    print(f"\n### Storage keys ({len(keys)})\n")
    print("| key | legacy sources |")
    print("| --- | --- |")
    for k in sorted(keys):
        print(f"| `{k}` | {', '.join(sorted(keys[k]))} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

If `scripts/` has no `__init__.py` and the import fails, add an empty `scripts/__init__.py` (check first — follow whatever existing tests importing from `scripts/` do; if none exist, the `__init__.py` is fine).

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_fe_parity_inventory.py -v`
Expected: 3 passed

- [ ] **Step 5: Generate the matrix seed and create the parity-matrix file**

Run: `uv run python scripts/fe_parity_inventory.py > /tmp/inventory.md` and inspect it — expect ~dozens of RPC methods, 13 routes, and at least the keys `agentos-theme`, `agentos.wsUrl`, `agentos.wsToken`.

Create `docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md` with this structure, pasting the generated inventory at the bottom:

```markdown
# Console Rewrite Parity Matrix

Single source of truth for migration completeness (spec §6). A behavior row
may be `pending`, `ported` (with evidence: test name or verification note),
or `waived` (with reason, owner-approved at cutover).

Row format:
| behavior | legacy source | status | evidence / reason |

## Cross-cutting
| behavior | legacy source | status | evidence / reason |
| --- | --- | --- | --- |
| Theme persistence + system-default resolution | js/theme.js:8-38 | pending | |
| Theme flash prevention inline script | templates/index.html (head) | pending | |
| WS handshake: connect.challenge -> connect(protocol 3) -> HelloOk+policy | js/rpc.js:87-127 | pending | |
| WS req/res correlation + typed errors (code/details) | js/rpc.js:45-147 | pending | |
| WS event fan-out incl. wildcard '*' listener | js/rpc.js:148-154 | pending | |
| WS seq-gap detection -> close+reconnect (_gap) | js/rpc.js:188-202 | pending | |
| WS tick-watch (policy.tick_interval_ms, 2.5x timeout) | js/rpc.js:204-217 | pending | |
| WS keepalive ping every 55s | js/rpc.js:172-179 | pending | |
| WS reconnect backoff 800ms x1.7 max 15s | js/rpc.js:226-231 | pending | |
| Default route: /overview desktop, /chat on <=768px | js/router.js:32 | pending | |
| 404 route fallback rendered as text (XSS-safe) | js/router.js:48-55 | pending | |
| Document title per route ("<Title> - AgentOS Control") | js/router.js:68-71 | pending | |
| Nav active state + aria-current | js/router.js:59-66 | pending | |
| Bootstrap data: version/ws_url/auth_mode/base_path/config_path/features | control_ui.py:_build_bootstrap_context | pending | |
| noscript message | templates/index.html | pending | |
| Feature flag AGENTOS_FEATURES.tokenViz (default false) | js/app.js:6-9 | pending | |
| Custom base_path support for built assets | control_ui.py + vite base | pending | cutover-plan item |

## Views
(One section per view; filled by each view's Task before implementation.
 Health is filled in this plan; the other 12 in later plans.)

### health
| behavior | legacy source | status | evidence / reason |
| --- | --- | --- | --- |
(filled in Task 8)

## Mechanical inventory
(paste generated output here)
```

- [ ] **Step 6: Quality gate + commit**

Run: `uv run ruff check scripts/ tests/test_fe_parity_inventory.py && uv run mypy scripts/fe_parity_inventory.py && uv run pytest tests/test_fe_parity_inventory.py -q`
Expected: all clean.

```bash
git add scripts/fe_parity_inventory.py tests/test_fe_parity_inventory.py
git add -f docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(fe-rewrite): parity inventory extractor + initial parity matrix"
```

---

### Task 2: Scaffold `frontend/` toolchain (Vite 6 + React 19 + TS strict + Tailwind v4 + Vitest + ESLint/Prettier)

**Files:**
- Create: everything under `frontend/` listed in File Structure (configs + `src/main.tsx`, `src/vite-env.d.ts`, `src/test/setup.ts`, `src/styles/globals.css`)
- Modify: `.gitignore` (add dist + node_modules lines)

**Interfaces:**
- Produces: `npm run dev` (Vite dev server with `/ws` + `/control/api` proxy), `npm run build` (emits `src/agentos/gateway/static/dist/`), `npm run check` (tsc + eslint + prettier + vitest) — the FE quality gate every later task runs.

- [ ] **Step 1: Scaffold and install**

```bash
cd frontend  # create it: mkdir frontend && cd frontend
npm init -y
npm install react@^19 react-dom@^19 react-router@^7 @tanstack/react-query@^5 zustand@^5 lucide-react sonner
npm install -D vite@^6 @vitejs/plugin-react@^4 typescript@~5.8 tailwindcss@^4 @tailwindcss/vite@^4 \
  vitest@^3 jsdom @testing-library/react@^16 @testing-library/jest-dom @testing-library/user-event \
  eslint@^9 typescript-eslint@^8 eslint-plugin-react-hooks eslint-plugin-react-refresh \
  prettier@^3 @types/react @types/react-dom @types/node
```

- [ ] **Step 2: Write the config files**

`frontend/package.json` — replace `scripts` with:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src",
    "format": "prettier --write src",
    "check": "tsc --noEmit && eslint src && prettier --check src && vitest run"
  },
  "engines": { "node": ">=22" }
}
```

`frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Assets are served by the gateway's existing static mount, so the built
// index.html must reference them under {base_path}/static/dist/.
// Custom base_path support is a cutover-plan item (see parity matrix).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/control/static/dist/',
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: path.resolve(__dirname, '../src/agentos/gateway/static/dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:18791', ws: true },
      '/control/api': { target: 'http://127.0.0.1:18791', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    globals: false,
  },
})
```

`frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"]
}
```

`frontend/eslint.config.js`:

```js
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
```

`frontend/.prettierrc.json`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100 }
```

`frontend/index.html` — note the theme flash-prevention script copied **verbatim in behavior** from the legacy Jinja template and the noscript block:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>AgentOS Control</title>
    <script>
      // Theme flash prevention: must run BEFORE CSS so the first paint
      // already has the correct `data-theme`. Mirrors stores/theme.ts.
      ;(function () {
        try {
          var t = localStorage.getItem('agentos-theme')
          if (t !== 'dark' && t !== 'light') {
            t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
          }
          document.documentElement.setAttribute('data-theme', t)
        } catch (e) {
          document.documentElement.setAttribute('data-theme', 'light')
        }
      })()
    </script>
  </head>
  <body>
    <noscript>
      <div style="padding:2rem;font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:2rem auto">
        <h2 style="margin:0 0 .5rem">JavaScript required</h2>
        <p style="margin:0">AgentOS Control needs JavaScript to render the chat, sessions, and configuration views.</p>
      </div>
    </noscript>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/src/styles/globals.css` (tokens extracted properly in Task 7; minimal now):

```css
@import 'tailwindcss';

:root { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; }
```

`frontend/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

`frontend/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

`frontend/src/main.tsx` (placeholder until Task 6 wires AppShell):

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <div>AgentOS Control (React rewrite scaffold)</div>
  </StrictMode>,
)
```

Append to repo-root `.gitignore`:

```
# React frontend build output (built at release; never committed)
src/agentos/gateway/static/dist/
frontend/node_modules/
```

- [ ] **Step 3: Verify the toolchain end-to-end**

Run (from `frontend/`): `npm run check`
Expected: tsc clean, eslint clean, prettier clean, vitest reports "no test files found" exit 0 (if vitest exits non-zero on zero tests, add `passWithNoTests: true` to the `test` block in `vite.config.ts`).

Run: `npm run build`
Expected: `../src/agentos/gateway/static/dist/index.html` + hashed assets exist.

Run: `git status --short | grep dist`
Expected: empty (dist ignored).

- [ ] **Step 4: Commit**

```bash
git add frontend .gitignore
git commit -m "feat(fe-rewrite): scaffold React 19 + Vite 6 + TS strict toolchain"
```

---

### Task 3: `GET {base}/api/bootstrap` endpoint (Python, TDD)

**Files:**
- Modify: `src/agentos/gateway/control_ui.py` (inside `create_control_ui_routes`)
- Test: `tests/test_gateway/test_control_ui_bootstrap.py`

**Interfaces:**
- Produces: `GET {base_path}/api/bootstrap` → `200 application/json` with exactly the `_build_bootstrap_context` fields: `version, ws_url, auth_mode, base_path, config_path, features`. Task 5's `fetchBootstrap()` consumes it.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_gateway/test_control_ui_bootstrap.py
from starlette.applications import Starlette
from starlette.testclient import TestClient

from agentos.gateway.config import GatewayConfig
from agentos.gateway.control_ui import create_control_ui_routes


def _client() -> TestClient:
    config = GatewayConfig()
    app = Starlette(routes=create_control_ui_routes(config))
    return TestClient(app)


def test_bootstrap_returns_json_context():
    client = _client()
    resp = client.get("/control/api/bootstrap")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    data = resp.json()
    assert set(data) == {"version", "ws_url", "auth_mode", "base_path", "config_path", "features"}
    assert data["base_path"] == "/control"
    assert data["ws_url"].startswith("ws")
    assert "diagnostics" in data["features"]


def test_bootstrap_not_cached():
    client = _client()
    resp = client.get("/control/api/bootstrap")
    assert "no-store" in resp.headers.get("cache-control", "")


def test_spa_fallback_still_serves_html():
    client = _client()
    resp = client.get("/control/health")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
```

Note: if `GatewayConfig()` requires arguments, copy the config-construction pattern from the top of `tests/test_gateway/test_rpc_doctor.py` — use whatever minimal fixture that file uses; the assertions above stay identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gateway/test_control_ui_bootstrap.py -v`
Expected: first test FAILS — the catch-all serves HTML, so content-type assertion fails (status will be 200/HTML, not JSON).

- [ ] **Step 3: Implement the endpoint**

In `create_control_ui_routes` in `src/agentos/gateway/control_ui.py`, add before the `return`:

```python
    async def serve_bootstrap(request: Request) -> JSONResponse:
        ctx = _build_bootstrap_context(config, request)
        return JSONResponse(ctx, headers={"Cache-Control": "no-store"})
```

Add `JSONResponse` to the existing `starlette.responses` import. Insert the route **before** the catch-all so it wins route matching:

```python
    return [
        Mount(
            f"{base}/static",
            app=_CachedStaticFiles(directory=str(_STATIC_DIR)),
            name="control_ui_static",
        ),
        Route(f"{base}/api/bootstrap", serve_bootstrap, methods=["GET"]),
        Route(f"{base}/{{path:path}}", serve_index, methods=["GET"]),
        Route(f"{base}/", serve_index, methods=["GET"]),
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_gateway/test_control_ui_bootstrap.py tests/test_gateway -q`
Expected: new tests pass; full `tests/test_gateway` stays green.

- [ ] **Step 5: Quality gate + commit + matrix**

Run: `uv run ruff check src/agentos/gateway/control_ui.py && uv run mypy src/agentos/gateway/control_ui.py`

Update parity matrix row `Bootstrap data: ...` → `ported | test_control_ui_bootstrap.py::test_bootstrap_returns_json_context`.

```bash
git add src/agentos/gateway/control_ui.py tests/test_gateway/test_control_ui_bootstrap.py
git add -f docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(gateway): add /api/bootstrap JSON endpoint for React console"
```

---

### Task 4: `WsRpcClient` — typed port of `rpc.js` (TDD, the highest-fidelity port in this plan)

**Files:**
- Create: `frontend/src/lib/ws-rpc.ts`
- Test: `frontend/src/lib/ws-rpc.test.ts`

**Interfaces:**
- Consumes: nothing (standalone; WebSocket impl injectable for tests).
- Produces:

```ts
type RpcState = 'disconnected' | 'connecting' | 'connected'
class RpcError extends Error { code?: string; details?: unknown }
class WsRpcClient {
  constructor(opts?: { WebSocketImpl?: typeof WebSocket })
  connect(url: string, token?: string | null): void
  disconnect(): void
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, handler: (...args: unknown[]) => void): () => void  // '*', '_state', '_hello', '_gap' meta-events preserved
  waitForConnection(): Promise<void>
  get state(): RpcState
  get policy(): Record<string, unknown>
}
```

Behavior contract = `js/rpc.js` verbatim: handshake (`connect.challenge` event → send `connect` req with `{minProtocol: 3, maxProtocol: 3, client: {name: 'agentos-web'}, auth?: {token}}` → HelloOk frame detected by `protocol` field while connecting → store `policy`, emit `_hello`, state `connected`), req/res correlation by string id, error objects carrying `code`/`details`, event fan-out + `'*'` wildcard with `(event, payload, meta)`, seq-gap detection (`seq !== last+1` → emit `_gap` → close), tick-watch (`max(10000, tick_interval_ms * 2.5)` timeout, check every `min(tick, 10000)` ms), ping `{"type":"ping"}` every 55 s, reconnect backoff 800 ms × 1.7 capped 15 s, reject all pending on close with `Connection closed`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/ws-rpc.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsRpcClient } from './ws-rpc'

/** Minimal scripted fake for the browser WebSocket API. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  // test helpers
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  serverSend(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function newClient() {
  const client = new WsRpcClient({ WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket })
  client.connect('ws://test/ws', 'tok-1')
  const ws = FakeWebSocket.instances.at(-1)!
  ws.serverOpen()
  return { client, ws }
}

function handshake(ws: FakeWebSocket) {
  ws.serverSend({ type: 'event', event: 'connect.challenge' })
  ws.serverSend({ protocol: 3, policy: { tick_interval_ms: 30000 } })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})
afterEach(() => vi.useRealTimers())

describe('handshake', () => {
  it('answers connect.challenge with a protocol-3 connect request incl. auth token', () => {
    const { ws } = newClient()
    ws.serverSend({ type: 'event', event: 'connect.challenge' })
    const req = JSON.parse(ws.sent.at(-1)!)
    expect(req.method).toBe('connect')
    expect(req.params.minProtocol).toBe(3)
    expect(req.params.maxProtocol).toBe(3)
    expect(req.params.client).toEqual({ name: 'agentos-web' })
    expect(req.params.auth).toEqual({ token: 'tok-1' })
  })

  it('enters connected state and stores policy on HelloOk', () => {
    const { client, ws } = newClient()
    handshake(ws)
    expect(client.state).toBe('connected')
    expect(client.policy).toEqual({ tick_interval_ms: 30000 })
  })
})

describe('call correlation', () => {
  it('resolves with payload on ok res, matching by id', async () => {
    const { client, ws } = newClient()
    handshake(ws)
    const p = client.call<{ n: number }>('doctor.status', { deep: true })
    const req = JSON.parse(ws.sent.at(-1)!)
    expect(req).toMatchObject({ type: 'req', method: 'doctor.status', params: { deep: true } })
    ws.serverSend({ type: 'res', id: req.id, ok: true, payload: { n: 7 } })
    await expect(p).resolves.toEqual({ n: 7 })
  })

  it('rejects with RpcError carrying code and details', async () => {
    const { client, ws } = newClient()
    handshake(ws)
    const p = client.call('x.y')
    const req = JSON.parse(ws.sent.at(-1)!)
    ws.serverSend({
      type: 'res', id: req.id, ok: false,
      error: { code: 'FORBIDDEN', message: 'no', details: { k: 1 } },
    })
    await expect(p).rejects.toMatchObject({ message: 'no', code: 'FORBIDDEN', details: { k: 1 } })
  })

  it('rejects immediately when not connected', async () => {
    const client = new WsRpcClient({ WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket })
    await expect(client.call('a.b')).rejects.toThrow('Not connected')
  })

  it('rejects all pending calls when the socket closes', async () => {
    const { client, ws } = newClient()
    handshake(ws)
    const p = client.call('a.b')
    ws.close()
    await expect(p).rejects.toThrow('Connection closed')
  })
})

describe('events', () => {
  it('fans out to named and wildcard listeners with meta', () => {
    const { client, ws } = newClient()
    handshake(ws)
    const named = vi.fn()
    const wild = vi.fn()
    client.on('sessions.changed', named)
    client.on('*', wild)
    ws.serverSend({ type: 'event', event: 'sessions.changed', payload: { a: 1 }, meta: { m: 2 }, seq: 1 })
    expect(named).toHaveBeenCalledWith({ a: 1 }, { m: 2 })
    expect(wild).toHaveBeenCalledWith('sessions.changed', { a: 1 }, { m: 2 })
  })

  it('detects a seq gap, emits _gap, and closes the socket', () => {
    const { client, ws } = newClient()
    handshake(ws)
    const gap = vi.fn()
    const named = vi.fn()
    client.on('_gap', gap)
    client.on('e', named)
    ws.serverSend({ type: 'event', event: 'e', payload: {}, seq: 1 })
    ws.serverSend({ type: 'event', event: 'e', payload: {}, seq: 3 })
    expect(gap).toHaveBeenCalledWith({ expected: 2, actual: 3, event: 'e' })
    expect(named).toHaveBeenCalledTimes(1) // gapped frame not delivered
  })
})

describe('keepalive and reconnect', () => {
  it('sends a ping every 55s while open', () => {
    const { ws } = newClient()
    handshake(ws)
    vi.advanceTimersByTime(55_000)
    expect(ws.sent).toContain('{"type":"ping"}')
  })

  it('reconnects with backoff after close (800ms first retry)', () => {
    const { ws } = newClient()
    handshake(ws)
    const count = FakeWebSocket.instances.length
    ws.close()
    vi.advanceTimersByTime(799)
    expect(FakeWebSocket.instances.length).toBe(count)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(count + 1)
  })

  it('closes the socket when no frame arrives within the tick timeout', () => {
    const { client, ws } = newClient()
    handshake(ws) // tick_interval_ms 30000 -> timeout 75s
    const gap = vi.fn()
    client.on('_gap', gap)
    vi.advanceTimersByTime(76_000)
    expect(gap).toHaveBeenCalledWith(expect.objectContaining({ reason: 'tick_timeout' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/lib/ws-rpc.test.ts`
Expected: FAIL — cannot resolve `./ws-rpc`.

- [ ] **Step 3: Implement `ws-rpc.ts`**

Port `js/rpc.js` line-for-line into a typed class. Full implementation:

```ts
// frontend/src/lib/ws-rpc.ts
/** AgentOS Control — WebSocket RPC client. Typed port of legacy static/js/rpc.js. */

export type RpcState = 'disconnected' | 'connecting' | 'connected'

export class RpcError extends Error {
  code?: string
  details?: unknown
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type Handler = (...args: unknown[]) => void

export class WsRpcClient {
  private ws: WebSocket | null = null
  private reqId = 0
  private pending = new Map<string, Pending>()
  private listeners = new Map<string, Set<Handler>>()
  private stateValue: RpcState = 'disconnected'
  private url = ''
  private token: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 800
  private readonly maxReconnectDelay = 15000
  private readonly reconnectFactor = 1.7
  private autoReconnect = true
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly pingInterval = 55000 // safely under server's 120s keepalive
  private policyValue: Record<string, unknown> | null = null
  private lastSeq = 0
  private lastFrameAt = 0
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null
  private tickTimeoutMs = 60000
  private readonly WebSocketImpl: typeof WebSocket

  constructor(opts?: { WebSocketImpl?: typeof WebSocket }) {
    this.WebSocketImpl = opts?.WebSocketImpl ?? WebSocket
  }

  connect(url: string, token?: string | null): void {
    this.url = url
    this.token = token ?? null
    this.autoReconnect = true
    this.doConnect()
  }

  disconnect(): void {
    this.autoReconnect = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopPing()
    this.stopTickWatch()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
        reject(new Error('Not connected'))
        return
      }
      const id = String(++this.reqId)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  on(event: string, handler: Handler): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  get state(): RpcState {
    return this.stateValue
  }

  get policy(): Record<string, unknown> {
    return this.policyValue ?? {}
  }

  waitForConnection(): Promise<void> {
    if (this.stateValue === 'connected') return Promise.resolve()
    return new Promise((resolve) => {
      const unsub = this.on('_state', (s) => {
        if (s === 'connected') {
          unsub()
          resolve()
        }
      })
    })
  }

  private doConnect(): void {
    this.setState('connecting')
    this.lastSeq = 0
    this.lastFrameAt = Date.now()
    this.stopTickWatch()
    try {
      this.ws = new this.WebSocketImpl(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 800
      // Don't send connect yet — wait for connect.challenge from server
    }

    this.ws.onmessage = (ev: MessageEvent) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (!this.noteIncomingFrame(data)) return

      // Handshake: server sends connect.challenge, we reply with connect request
      if (data.type === 'event' && data.event === 'connect.challenge') {
        const authParams = this.token ? { auth: { token: this.token } } : {}
        const id = String(++this.reqId)
        this.pending.set(id, {
          resolve: () => {}, // HelloOk is not a res frame, handled below
          reject: () => {
            this.ws?.close()
            this.setState('disconnected')
          },
        })
        this.ws?.send(
          JSON.stringify({
            type: 'req',
            id,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: { name: 'agentos-web' },
              ...authParams,
            },
          }),
        )
        return
      }

      // Handshake: HelloOk frame (has "protocol" field, no "type":"res")
      if (data.protocol !== undefined && this.stateValue === 'connecting') {
        this.policyValue = (data.policy as Record<string, unknown>) ?? null
        for (const [id, p] of this.pending) {
          this.pending.delete(id)
          p.resolve(data)
          break
        }
        this.setState('connected')
        this.emit('_hello', data)
        this.startPing()
        this.startTickWatch()
        return
      }

      if (data.type === 'res') {
        const p = this.pending.get(String(data.id))
        if (p) {
          this.pending.delete(String(data.id))
          if (data.ok) {
            p.resolve(data.payload)
          } else {
            const err = data.error as { message?: string; code?: string; details?: unknown } | string
            const message =
              typeof err === 'string' ? err : (err && (err.message || err.code)) || 'RPC error'
            const error = new RpcError(message)
            if (err && typeof err === 'object') {
              error.code = err.code
              error.details = err.details
            }
            p.reject(error)
          }
        }
      } else if (data.type === 'event') {
        const meta = (data.meta as Record<string, unknown>) ?? {}
        this.emit(String(data.event), data.payload, meta)
        this.emit('*', String(data.event), data.payload, meta)
      }
    }

    this.ws.onclose = () => {
      this.stopPing()
      this.stopTickWatch()
      for (const [, p] of this.pending) p.reject(new Error('Connection closed'))
      this.pending.clear()
      this.ws = null
      if (this.stateValue !== 'disconnected') {
        this.setState('disconnected')
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {}
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((h) => h(...args))
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
        this.ws.send('{"type":"ping"}')
      }
    }, this.pingInterval)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private noteIncomingFrame(data: Record<string, unknown>): boolean {
    this.lastFrameAt = Date.now()
    if (!data || data.type !== 'event' || typeof data.seq !== 'number') return true
    const seq = data.seq
    if (this.lastSeq > 0 && seq !== this.lastSeq + 1) {
      this.emit('_gap', { expected: this.lastSeq + 1, actual: seq, event: data.event })
      try {
        this.ws?.close()
      } catch {
        /* noop */
      }
      return false
    }
    this.lastSeq = seq
    return true
  }

  private startTickWatch(): void {
    this.stopTickWatch()
    const tickMs = (this.policyValue?.tick_interval_ms as number | undefined) ?? 30000
    this.tickTimeoutMs = Math.max(10000, tickMs * 2.5)
    this.lastFrameAt = Date.now()
    this.tickWatchTimer = setInterval(
      () => {
        if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return
        const idleMs = Date.now() - this.lastFrameAt
        if (idleMs <= this.tickTimeoutMs) return
        this.emit('_gap', { reason: 'tick_timeout', idleMs })
        try {
          this.ws.close()
        } catch {
          /* noop */
        }
      },
      Math.min(tickMs, 10000),
    )
  }

  private stopTickWatch(): void {
    if (this.tickWatchTimer !== null) {
      clearInterval(this.tickWatchTimer)
      this.tickWatchTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.doConnect(), this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * this.reconnectFactor, this.maxReconnectDelay)
  }

  private setState(s: RpcState): void {
    if (this.stateValue === s) return
    this.stateValue = s
    this.emit('_state', s)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ws-rpc.test.ts`
Expected: all pass. If the fake-timer tests hang, ensure `vi.useFakeTimers()` runs before `newClient()` (it does, via `beforeEach`).

- [ ] **Step 5: FE gate + matrix + commit**

Run: `npm run check`

Update matrix rows (all `js/rpc.js` rows) → `ported | ws-rpc.test.ts::<test name>` per row.

```bash
git add src/lib/ws-rpc.ts src/lib/ws-rpc.test.ts
git add -f ../docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(fe-rewrite): typed WsRpcClient port with full protocol tests"
```

---

### Task 5: Bootstrap loader + theme store + connection store + providers

**Files:**
- Create: `frontend/src/lib/bootstrap.ts`, `frontend/src/stores/theme.ts`, `frontend/src/stores/connection.ts`, `frontend/src/app/providers.tsx`
- Test: `frontend/src/stores/theme.test.ts`

**Interfaces:**
- Consumes: `WsRpcClient` from Task 4.
- Produces:

```ts
// lib/bootstrap.ts
export interface Bootstrap {
  version: string
  ws_url: string
  auth_mode: string
  base_path: string
  config_path: string
  features: { diagnostics: boolean }
}
export function bootstrapUrl(): string        // BASE_URL minus 'static/dist/' + 'api/bootstrap'
export async function fetchBootstrap(): Promise<Bootstrap>

// stores/theme.ts (zustand)
export type ThemeMode = 'dark' | 'light'
export const useTheme: UseBoundStore<StoreApi<{ mode: ThemeMode; set(m: ThemeMode): void; toggle(): void }>>
export function initTheme(): void            // reads localStorage 'agentos-theme', applies data-theme

// stores/connection.ts (zustand)
export const useConnection: UseBoundStore<StoreApi<{ state: RpcState; setState(s: RpcState): void }>>

// app/providers.tsx
export function AppProviders({ children }: { children: ReactNode }): JSX.Element
export function useRpc(): WsRpcClient        // context hook; throws outside provider
export function useBootstrap(): Bootstrap
```

`AppProviders` fetches bootstrap once, creates one `WsRpcClient`, calls `connect(localStorage['agentos.wsUrl'] || bootstrap.ws_url, localStorage['agentos.wsToken'])`, mirrors `_state` events into `useConnection`, wraps children in `QueryClientProvider` (default options: `staleTime: 5_000`, `retry: 1`), and renders a "Connecting…" placeholder until bootstrap resolves.

- [ ] **Step 1: Write the failing theme-store test**

```ts
// frontend/src/stores/theme.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { initTheme, useTheme } from './theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme store', () => {
  it('initTheme applies stored preference', () => {
    localStorage.setItem('agentos-theme', 'dark')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('set persists and applies', () => {
    initTheme()
    useTheme.getState().set('dark')
    expect(localStorage.getItem('agentos-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('toggle flips the mode', () => {
    localStorage.setItem('agentos-theme', 'light')
    initTheme()
    useTheme.getState().toggle()
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('rejects invalid modes', () => {
    initTheme()
    const before = useTheme.getState().mode
    // @ts-expect-error runtime guard mirrors legacy theme.js
    useTheme.getState().set('purple')
    expect(useTheme.getState().mode).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/stores/theme.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the four modules**

```ts
// frontend/src/stores/theme.ts
import { create } from 'zustand'

export type ThemeMode = 'dark' | 'light'
const STORAGE_KEY = 'agentos-theme'

function systemDefault(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode)
}

export const useTheme = create<{ mode: ThemeMode; set(m: ThemeMode): void; toggle(): void }>(
  (set, get) => ({
    mode: 'light',
    set(mode) {
      if (mode !== 'dark' && mode !== 'light') return
      localStorage.setItem(STORAGE_KEY, mode)
      apply(mode)
      set({ mode })
    },
    toggle() {
      get().set(get().mode === 'dark' ? 'light' : 'dark')
    },
  }),
)

export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY)
  const mode: ThemeMode = stored === 'dark' || stored === 'light' ? stored : systemDefault()
  apply(mode)
  useTheme.setState({ mode })
}
```

```ts
// frontend/src/stores/connection.ts
import { create } from 'zustand'
import type { RpcState } from '@/lib/ws-rpc'

export const useConnection = create<{ state: RpcState; setState(s: RpcState): void }>((set) => ({
  state: 'disconnected',
  setState: (state) => set({ state }),
}))
```

```ts
// frontend/src/lib/bootstrap.ts
export interface Bootstrap {
  version: string
  ws_url: string
  auth_mode: string
  base_path: string
  config_path: string
  features: { diagnostics: boolean }
}

/** BASE_URL is '/control/static/dist/'; the API lives at '/control/api/'. */
export function bootstrapUrl(): string {
  const base = import.meta.env.BASE_URL.replace(/static\/dist\/?$/, '')
  return `${base}api/bootstrap`
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const resp = await fetch(bootstrapUrl())
  if (!resp.ok) throw new Error(`bootstrap failed: ${resp.status}`)
  return (await resp.json()) as Bootstrap
}
```

```tsx
// frontend/src/app/providers.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchBootstrap, type Bootstrap } from '@/lib/bootstrap'
import { WsRpcClient } from '@/lib/ws-rpc'
import { useConnection } from '@/stores/connection'
import { initTheme } from '@/stores/theme'
import type { RpcState } from '@/lib/ws-rpc'

const WS_URL_KEY = 'agentos.wsUrl'
const WS_TOKEN_KEY = 'agentos.wsToken'

const RpcContext = createContext<WsRpcClient | null>(null)
const BootstrapContext = createContext<Bootstrap | null>(null)

export function useRpc(): WsRpcClient {
  const rpc = useContext(RpcContext)
  if (!rpc) throw new Error('useRpc outside AppProviders')
  return rpc
}

export function useBootstrap(): Bootstrap {
  const b = useContext(BootstrapContext)
  if (!b) throw new Error('useBootstrap outside AppProviders')
  return b
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
})

export function AppProviders({ children }: { children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [rpc] = useState(() => new WsRpcClient())

  useEffect(() => {
    initTheme()
    let cancelled = false
    fetchBootstrap().then((b) => {
      if (cancelled) return
      setBootstrap(b)
      const url = localStorage.getItem(WS_URL_KEY) || b.ws_url
      const token = localStorage.getItem(WS_TOKEN_KEY)
      rpc.on('_state', (s) => useConnection.getState().setState(s as RpcState))
      rpc.connect(url, token)
    })
    return () => {
      cancelled = true
      rpc.disconnect()
    }
  }, [rpc])

  if (!bootstrap) return <div className="p-8 text-sm">Connecting…</div>

  return (
    <BootstrapContext.Provider value={bootstrap}>
      <RpcContext.Provider value={rpc}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </RpcContext.Provider>
    </BootstrapContext.Provider>
  )
}
```

- [ ] **Step 4: Run tests + gate**

Run: `npx vitest run src/stores/theme.test.ts` → PASS. Then `npm run check` → clean.

- [ ] **Step 5: Matrix + commit**

Matrix rows for theme.js and bootstrap-consumption → `ported` with test evidence (`theme.test.ts::*`; providers covered indirectly by Task 6/8 tests — note that in evidence).

```bash
git add src/lib/bootstrap.ts src/stores src/app/providers.tsx
git add -f ../docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(fe-rewrite): bootstrap loader, theme/connection stores, app providers"
```

---

### Task 6: shadcn/ui base + design tokens

**Files:**
- Create: `frontend/components.json`, `frontend/src/components/ui/*` (button, card, sonner), `frontend/src/lib/utils.ts`
- Modify: `frontend/src/styles/globals.css`

**Interfaces:**
- Produces: `<Button>`, `<Card>`, `<Toaster />` + `toast()` (sonner), `cn()` helper; CSS variables `--background --foreground --muted --border --primary …` in `:root` / `[data-theme=dark]`, fonts Inter + JetBrains Mono self-hosted.

- [ ] **Step 1: Initialize shadcn**

```bash
cd frontend
npx shadcn@latest init   # style: default; base color: neutral; css vars: yes; path alias: @
npx shadcn@latest add button card sonner
```

If the CLI asks about React 19 peer-deps, accept. Verify it created `src/components/ui/button.tsx`, `card.tsx`, `sonner.tsx` and `src/lib/utils.ts`.

**shadcn theming caveat:** shadcn emits `.dark` class selectors; this app themes via `[data-theme='dark']`. In `globals.css`, define the dark-theme variable block under `:root[data-theme='dark']` (replace any generated `.dark` selector).

- [ ] **Step 2: Port design tokens + fonts**

Copy `Inter-Variable.woff2` and `JetBrainsMono-Variable.woff2` from `src/agentos/gateway/static/fonts/` into `frontend/src/assets/fonts/` (git-tracked; legacy copies untouched). Extend `globals.css`:

```css
@import 'tailwindcss';

@font-face {
  font-family: 'Inter Variable';
  src: url('../assets/fonts/Inter-Variable.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono Variable';
  src: url('../assets/fonts/JetBrainsMono-Variable.woff2') format('woff2');
  font-weight: 100 800;
  font-display: swap;
}

@theme {
  --font-sans: 'Inter Variable', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;
}

/* Light/dark tokens: seed from shadcn defaults now; visual polish happens
   per-view. Exact legacy hex values live in static/css/base.css for
   reference when tuning. */
:root { color-scheme: light; /* shadcn :root vars here */ }
:root[data-theme='dark'] { color-scheme: dark; /* shadcn dark vars here */ }
```

(The shadcn init writes the actual variable values; keep them, just re-home the dark block under `:root[data-theme='dark']`.)

- [ ] **Step 3: Verify**

Run: `npm run check && npm run build`
Expected: clean; dist assets include the two woff2 files.

- [ ] **Step 4: Commit**

```bash
git add components.json src/components src/lib/utils.ts src/styles/globals.css src/assets
git commit -m "feat(fe-rewrite): shadcn/ui base components + design tokens + self-hosted fonts"
```

---

### Task 7: AppShell + router with all 13 routes (12 stubs + Health slot)

**Files:**
- Create: `frontend/src/app/AppShell.tsx`, `frontend/src/app/routes.tsx`, `frontend/src/views/StubView.tsx`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: `AppProviders`, `useConnection`, `useTheme`, `useBootstrap` (Task 5); shadcn `Button`, `Toaster` (Task 6).
- Produces: `<AppShell />` layout (sidebar nav, topbar with title + theme toggle, connection banner, `<Outlet />`); `router` (React Router `createBrowserRouter` with `basename` = bootstrap `base_path`); `VIEWS` const:

```ts
export const VIEWS: ReadonlyArray<{ path: string; title: string }> = [
  { path: 'overview', title: 'Overview' }, { path: 'health', title: 'Health' },
  { path: 'chat', title: 'Chat' }, { path: 'sessions', title: 'Sessions' },
  { path: 'agents', title: 'Agents' }, { path: 'cron', title: 'Cron' },
  { path: 'usage', title: 'Usage' }, { path: 'config', title: 'Config' },
  { path: 'setup', title: 'Setup' }, { path: 'channels', title: 'Channels' },
  { path: 'approvals', title: 'Approvals' }, { path: 'skills', title: 'Skills' },
  { path: 'logs', title: 'Logs' },
]
```

Behavior parity: index route redirects to `/overview` on desktop, `/chat` when `matchMedia('(max-width: 768px)')` matches (js/router.js:32); unknown paths render a plain-text "Page not found: <path>" (router.js:48-55); document title set to `"<Title> - AgentOS Control"` per route (router.js:68-71); active nav item carries `aria-current="page"` (router.js:59-66).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/app/AppShell.test.tsx
import { render, screen } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { routeChildren } from './routes'

// Render the route tree without AppProviders (no network): test harness
// provides QueryClient only; views under test here are stubs.
function renderAt(path: string) {
  const router = createMemoryRouter(routeChildren, { initialEntries: [path] })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('routes', () => {
  it('renders a stub for every registered view', () => {
    renderAt('/sessions')
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
  })

  it('renders XSS-safe 404 text for unknown paths', () => {
    renderAt('/nope<script>')
    expect(screen.getByText(/Page not found:/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })

  it('sets the document title from the route', () => {
    renderAt('/logs')
    expect(document.title).toBe('Logs - AgentOS Control')
  })
})
```

Note: `routeChildren` is exported separately from the `AppShell`-wrapped production router precisely so tests can mount views without the WS-connecting providers.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/AppShell.test.tsx`
Expected: FAIL — `./routes` not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/views/StubView.tsx
import { useEffect } from 'react'

export function StubView({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} - AgentOS Control`
  }, [title])
  return (
    <div className="p-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">Migration pending (see parity matrix).</p>
    </div>
  )
}
```

```tsx
// frontend/src/app/routes.tsx
import { Navigate, type RouteObject } from 'react-router'
import { StubView } from '@/views/StubView'

export const VIEWS: ReadonlyArray<{ path: string; title: string }> = [
  { path: 'overview', title: 'Overview' }, { path: 'health', title: 'Health' },
  { path: 'chat', title: 'Chat' }, { path: 'sessions', title: 'Sessions' },
  { path: 'agents', title: 'Agents' }, { path: 'cron', title: 'Cron' },
  { path: 'usage', title: 'Usage' }, { path: 'config', title: 'Config' },
  { path: 'setup', title: 'Setup' }, { path: 'channels', title: 'Channels' },
  { path: 'approvals', title: 'Approvals' }, { path: 'skills', title: 'Skills' },
  { path: 'logs', title: 'Logs' },
]

function defaultPath(): string {
  // Parity: js/router.js:32 — mobile lands on chat, desktop on overview.
  try {
    return window.matchMedia('(max-width: 768px)').matches ? '/chat' : '/overview'
  } catch {
    return '/overview'
  }
}

function NotFound() {
  // Parity: js/router.js:48-55 — path rendered as text, never HTML.
  return (
    <div className="p-8 text-muted-foreground">
      {'Page not found: ' + window.location.pathname}
    </div>
  )
}

export const routeChildren: RouteObject[] = [
  { index: true, element: <Navigate to={defaultPath()} replace /> },
  ...VIEWS.map((v) => ({ path: v.path, element: <StubView title={v.title} /> })),
  { path: '*', element: <NotFound /> },
]
```

```tsx
// frontend/src/app/AppShell.tsx
import { NavLink, Outlet } from 'react-router'
import { Moon, Sun } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/stores/theme'
import { useConnection } from '@/stores/connection'
import { VIEWS } from './routes'

export function AppShell() {
  const mode = useTheme((s) => s.mode)
  const toggle = useTheme((s) => s.toggle)
  const connState = useConnection((s) => s.state)

  return (
    <div className="flex h-dvh font-sans">
      <aside className="w-56 shrink-0 border-r p-3">
        <div className="mb-4 px-2 font-semibold">AgentOS Control</div>
        <nav aria-label="Main">
          {VIEWS.map((v) => (
            <NavLink
              key={v.path}
              to={`/${v.path}`}
              className={({ isActive }) =>
                `block rounded px-2 py-1.5 text-sm ${isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'}`
              }
              aria-current={undefined /* NavLink sets aria-current="page" automatically */}
            >
              {v.title}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {connState !== 'connected' && (
          <div role="status" className="bg-destructive/10 px-4 py-1.5 text-sm">
            {connState === 'connecting' ? 'Connecting to gateway…' : 'Disconnected — reconnecting…'}
          </div>
        )}
        <header className="flex items-center justify-end border-b px-4 py-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            title={`Theme: ${mode}`}
            aria-label={`Theme: ${mode}. Toggle theme`}
            aria-pressed={mode === 'dark'}
          >
            {mode === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  )
}
```

```tsx
// frontend/src/main.tsx (replace placeholder)
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { AppProviders } from './app/providers'
import { AppShell } from './app/AppShell'
import { routeChildren } from './app/routes'
import './styles/globals.css'

const basename = import.meta.env.BASE_URL.replace(/static\/dist\/?$/, '').replace(/\/$/, '')
const router = createBrowserRouter(
  [{ element: <AppShell />, children: routeChildren }],
  { basename: basename || '/' },
)

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
```

- [ ] **Step 4: Run tests, then verify against a live gateway**

Run: `npx vitest run src/app/AppShell.test.tsx` → PASS. `npm run check` → clean.

Manual dev-loop check (needs a running gateway): `uv run agentos gateway run` in one terminal, `npm run dev` in another; open `http://localhost:5173/` → expect sidebar with 13 items, connection banner clearing once WS connects, theme toggle switching `data-theme`.

- [ ] **Step 5: Matrix + commit**

Matrix rows router.js (default route, 404, title, aria-current) → `ported` + test names; connection-banner row → `ported | manual dev-loop check`.

```bash
git add src/app src/views/StubView.tsx src/main.tsx
git add -f ../docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(fe-rewrite): AppShell, router with 13 routes, connection banner"
```

---

### Task 8: Health view — first full view migration (pattern-setter)

**Files:**
- Create: `frontend/src/views/health/logic.ts`, `frontend/src/views/health/HealthPage.tsx`
- Test: `frontend/src/views/health/logic.test.ts`, `frontend/src/views/health/HealthPage.test.tsx`
- Modify: `frontend/src/app/routes.tsx` (swap Health stub for `HealthPage`)

**Interfaces:**
- Consumes: `useRpc()` (Task 5), `useQuery` (TanStack), shadcn `Button`/`Card`, `toast` (sonner).
- Produces: the per-view pattern later plans copy — `logic.ts` (pure, fully unit-tested) + `<Page>` (thin, RTL-tested with mocked rpc) + matrix section.

**Pre-step (protocol §6.2): inventory.** Read `src/agentos/gateway/static/js/views/health.js` (502 lines) end-to-end and fill the matrix `### health` section. Rows it must contain (from the legacy source):

```
| doctor.status RPC {agentId:'main', deep:true} after waitForConnection | health.js:76-77 |
| Loading state: "Checking readiness" + loading strip | health.js:64-74 |
| Success: summary text, status rail class is-<status>, impact count tiles | health.js:80-84,133-150 |
| Fallback impactCounts derived from severity counts | health.js:413-420 |
| Findings grouped: action/degraded/optional/ready with notes | health.js:277-313 |
| Impact derivation: readinessImpact else severity mapping | health.js:403-411 |
| Status labels incl. "Ready with warnings" for ready+degraded | health.js:462-472 |
| Finding card: severity/impact/surface meta, badges (.diagnostic.incomplete, .repair.pending, config.mismatch), restartRequired chip | health.js:324-368 |
| Evidence tags: max 6, hidden keys restart_required/restartRequired, camelCase->label, JSON values truncated 120 | health.js:439-460,474-483 |
| Fix steps: numbered, optional command with copy button, heading by kind | health.js:370-401 |
| Copy command: navigator.clipboard w/ execCommand fallback + ok/err toast | health.js:35-62 |
| Error state: synthetic gateway.unavailable finding w/ local-vs-remote fix steps, shell-quoted commands | health.js:86-115,191-268 |
| Refresh button re-runs the report | health.js:17-24 |
```

**Simplification (recorded in matrix, not silent):** `_gatewayContextUrl()` legacy reads `App.loadConnectionSettings()`; new impl reads `localStorage['agentos.wsUrl'] || bootstrap.ws_url` — same effective value; evidence row notes this.

- [ ] **Step 1: Write failing tests for `logic.ts`**

```ts
// frontend/src/views/health/logic.test.ts
import { describe, expect, it } from 'vitest'
import {
  impactValue, impactCountsFromSeverity, statusLabel, findingGroupKind,
  shellArg, isLocalGatewayUrl, gatewayStatusTarget, visibleEvidenceEntries,
  evidenceLabel, evidenceValue,
} from './logic'

describe('impactValue', () => {
  it('passes through valid readinessImpact', () => {
    expect(impactValue({ readinessImpact: 'degrades' })).toBe('degrades')
  })
  it.each([
    ['error', 'blocks_ready'], ['warn', 'degrades'], ['info', 'optional'], ['ok', 'none'],
  ])('maps severity %s -> %s', (severity, impact) => {
    expect(impactValue({ severity })).toBe(impact)
  })
})

describe('impactCountsFromSeverity', () => {
  it('maps severity counts to impact counts', () => {
    expect(impactCountsFromSeverity({ error: 2, warn: 1, info: 3, ok: 4 })).toEqual({
      blocks_ready: 2, degrades: 1, optional: 3, none: 4,
    })
  })
})

describe('statusLabel', () => {
  it('shows "Ready with warnings" when ready but degraded', () => {
    expect(statusLabel('degraded', true)).toBe('Ready with warnings')
  })
  it('maps action_required', () => {
    expect(statusLabel('action_required', false)).toBe('Action required')
  })
})

describe('findingGroupKind', () => {
  it('maps blocks_ready to action', () => {
    expect(findingGroupKind({ readinessImpact: 'blocks_ready' })).toBe('action')
  })
})

describe('shellArg', () => {
  it('passes safe strings through', () => {
    expect(shellArg('/tmp/agentos.toml')).toBe('/tmp/agentos.toml')
  })
  it('quotes and escapes unsafe strings', () => {
    expect(shellArg("it's here")).toBe("'it'\\''s here'")
  })
})

describe('gateway url helpers', () => {
  it('treats loopback hosts as local', () => {
    expect(isLocalGatewayUrl('ws://127.0.0.1:18791/ws')).toBe(true)
    expect(isLocalGatewayUrl('wss://prod.example.com/ws')).toBe(false)
  })
  it('normalizes 0.0.0.0 and infers default port', () => {
    expect(gatewayStatusTarget('ws://0.0.0.0/ws')).toEqual({ host: '127.0.0.1', port: '18791' })
    expect(gatewayStatusTarget('wss://h.example/ws')).toEqual({ host: 'h.example', port: '443' })
  })
})

describe('evidence', () => {
  it('hides restart keys and null values', () => {
    const entries = visibleEvidenceEntries({ a: 1, restartRequired: true, b: null })
    expect(entries).toEqual([['a', 1]])
  })
  it('labels camelCase keys', () => {
    expect(evidenceLabel('gatewayUrl')).toBe('Gateway url')
  })
  it('truncates long JSON values at 120 chars', () => {
    const long = { k: 'x'.repeat(200) }
    expect(evidenceValue(long).length).toBe(120)
    expect(evidenceValue(long).endsWith('...')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/health/logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `logic.ts`**

Direct typed port of the pure helpers from `health.js` lines 187-268 and 403-496 (the implementer ports each function 1:1 from the legacy lines listed in the matrix rows; signatures below are the contract):

```ts
// frontend/src/views/health/logic.ts
export type Impact = 'blocks_ready' | 'degrades' | 'optional' | 'none'
export type GroupKind = 'action' | 'degraded' | 'optional' | 'ready'

export interface Finding {
  id?: string
  severity?: string
  readinessImpact?: string
  surface?: string
  title?: string
  detail?: string
  evidence?: Record<string, unknown>
  fixSteps?: Array<{ label?: string; command?: string; detail?: string }>
  restartRequired?: boolean
}

export interface HealthReport {
  status?: string
  ready?: boolean
  summary?: string
  gatewayUrl?: string
  configPath?: string
  requestedConfigPath?: string
  agentId?: string
  counts?: Record<string, number>
  impactCounts?: Partial<Record<Impact, number>>
  findings?: Finding[]
}

export function impactValue(f: Pick<Finding, 'readinessImpact' | 'severity'>): Impact
export function impactCountsFromSeverity(counts: Record<string, number>): Record<Impact, number>
export function statusLabel(status: string, ready?: boolean): string
export function findingGroupKind(f: Finding): GroupKind
export function shellArg(value: string): string
export function isLocalGatewayUrl(url: string): boolean
export function gatewayStatusTarget(url: string): { host: string; port: string } | null
export function gatewayUnavailableFixSteps(url: string, configPath: string, usesDefault: boolean): Finding['fixSteps']
export function visibleEvidenceEntries(e?: Record<string, unknown>): Array<[string, unknown]>
export function evidenceLabel(key: string): string
export function evidenceValue(value: unknown): string
```

(Each body is the legacy function with types added — e.g. `impactValue` = health.js:403-411 verbatim: valid `readinessImpact` passes through, else severity `error→blocks_ready`, `warn→degrades`, `info→optional`, default `none`. `shellArg` = health.js:244-248 including the exact safe-charset regex `/^[A-Za-z0-9_@%+=:,./~-]+$/`. `gatewayStatusTarget` = health.js:256-268 including IPv6 bracket stripping, `0.0.0.0→127.0.0.1`, `::→::1`, port default 443 for wss/https else 18791.)

- [ ] **Step 4: Run logic tests to verify they pass**

Run: `npx vitest run src/views/health/logic.test.ts`
Expected: all pass.

- [ ] **Step 5: Write failing `HealthPage` RTL test**

```tsx
// frontend/src/views/health/HealthPage.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { HealthPage } from './HealthPage'

const mockRpc = {
  waitForConnection: vi.fn().mockResolvedValue(undefined),
  call: vi.fn(),
}
vi.mock('@/app/providers', () => ({
  useRpc: () => mockRpc,
  useBootstrap: () => ({
    version: '1', ws_url: 'ws://127.0.0.1:18791/ws', auth_mode: 'none',
    base_path: '/control', config_path: '/tmp/agentos.toml', features: { diagnostics: true },
  }),
}))

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HealthPage />
    </QueryClientProvider>,
  )
}

describe('HealthPage', () => {
  it('calls doctor.status deep for agent main and renders grouped findings', async () => {
    mockRpc.call.mockResolvedValue({
      status: 'degraded', ready: true, summary: 'Mostly fine',
      impactCounts: { blocks_ready: 0, degrades: 1, optional: 0, none: 3 },
      findings: [{
        id: 'memory.slow', severity: 'warn', readinessImpact: 'degrades',
        surface: 'memory', title: 'Memory is slow', detail: 'latency high',
        fixSteps: [{ label: 'Restart memory', command: 'agentos gateway restart' }],
      }],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Ready with warnings')).toBeInTheDocument())
    expect(mockRpc.call).toHaveBeenCalledWith('doctor.status', { agentId: 'main', deep: true })
    expect(screen.getByText('Degraded capabilities')).toBeInTheDocument()
    expect(screen.getByText('Memory is slow')).toBeInTheDocument()
    expect(screen.getByText('agentos gateway restart')).toBeInTheDocument()
  })

  it('renders the synthetic gateway.unavailable finding on RPC failure', async () => {
    mockRpc.call.mockRejectedValue(new Error('boom'))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Gateway health report unavailable')).toBeInTheDocument(),
    )
    expect(screen.getByText('Health report unavailable')).toBeInTheDocument()
  })

  it('refetches when Refresh is clicked', async () => {
    mockRpc.call.mockResolvedValue({ status: 'ready', ready: true, findings: [] })
    renderPage()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(1))
    screen.getByRole('button', { name: /refresh/i }).click()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(2))
  })
})
```

- [ ] **Step 6: Run to verify failure, then implement `HealthPage.tsx`**

Run: `npx vitest run src/views/health/HealthPage.test.tsx` → FAIL (module not found).

Implement: a `useQuery({ queryKey: ['doctor.status', 'main'], queryFn })` where `queryFn` awaits `rpc.waitForConnection()` then `rpc.call('doctor.status', { agentId: 'main', deep: true })`; on error, synthesize the `gateway.unavailable` finding via `gatewayUnavailableFixSteps` (local vs remote, shell-quoted) exactly as the matrix rows describe; render: header ("Control · Health" eyebrow, summary line, Refresh `<Button variant="ghost">` calling `refetch()`), status rail (readiness label + 4 count tiles from `impactCounts` else `impactCountsFromSeverity`), findings in the 4 groups with notes, finding cards with meta chips/badges/restart chip, evidence tags (`visibleEvidenceEntries` → `evidenceLabel`/`evidenceValue`), numbered fix steps with copy buttons using `navigator.clipboard.writeText` + textarea/`execCommand` fallback and sonner `toast('Copied command')` / error toast. Swap the route in `routes.tsx`:

```tsx
// in routes.tsx: replace the health stub entry
import { HealthPage } from '@/views/health/HealthPage'
// ...
...VIEWS.map((v) =>
  v.path === 'health'
    ? { path: v.path, element: <HealthPage /> }
    : { path: v.path, element: <StubView title={v.title} /> },
),
```

- [ ] **Step 7: Run all FE tests + gate**

Run: `npm run check`
Expected: clean; all suites pass (ws-rpc, theme, AppShell, health logic + page).

- [ ] **Step 8: Live verification + matrix + commit**

With gateway running + `npm run dev`: open `/health`, compare side-by-side with legacy `/control/health` — same report content, groups, counts, copy buttons work, error state correct when gateway stopped.

Fill every `### health` matrix row → `ported` + test name (or `manual dev-loop check` for pure-visual rows); the `_gatewayContextUrl` simplification row → `ported (simplified)` + note.

```bash
git add src/views/health src/app/routes.tsx
git add -f ../docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md
git commit -m "feat(fe-rewrite): Health view migration with full parity tests"
```

---

### Task 9: FE CI lane + AGENTS.md documentation

**Files:**
- Create: `.github/workflows/frontend.yml`
- Modify: `AGENTS.md` (add FE lane section)

**Interfaces:**
- Consumes: `npm run check` and `npm run build` from Task 2.
- Produces: CI gate on PRs touching `frontend/`; documented contributor workflow.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/frontend.yml
name: frontend
on:
  pull_request:
    paths: ['frontend/**', '.github/workflows/frontend.yml']
  push:
    branches: [main]
    paths: ['frontend/**', '.github/workflows/frontend.yml']
jobs:
  check:
    runs-on: ubuntu-latest
    defaults:
      run: { working-directory: frontend }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run check
      - run: npm run build
```

Check first whether existing workflows in `.github/workflows/` pin action versions differently (e.g. `actions/checkout@v5`) and match the repo's existing pins.

- [ ] **Step 2: Add the FE lane to AGENTS.md**

Append a section (adapt placement to the existing quality-gate section):

```markdown
## Frontend lane (React console rewrite)

The React console lives in `frontend/` (Node >= 22) and builds to
`src/agentos/gateway/static/dist/` (gitignored; built at release).

- Touched `frontend/**`? Run `cd frontend && npm run check` (tsc, eslint,
  prettier, vitest) before committing. CI enforces this.
- Python-only changes never require Node.
- Dev loop: `agentos gateway run` + `cd frontend && npm run dev`
  (Vite proxies `/ws` and `/control/api` to the gateway).
- Every ported behavior updates
  `docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md`
  in the same commit (see the rewrite spec §6).
```

- [ ] **Step 3: Validate + commit**

Run: `uvx --from yamllint yamllint .github/workflows/frontend.yml` (or `python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/frontend.yml'))"`)
Expected: parses clean.

```bash
git add .github/workflows/frontend.yml AGENTS.md
git commit -m "ci(fe-rewrite): frontend quality-gate lane + AGENTS.md contributor docs"
```

---

### Task 10: Plan-1 close-out verification

**Files:** none new — verification only.

- [ ] **Step 1: Full FE gate**

Run (from `frontend/`): `npm run check && npm run build`
Expected: clean; dist produced.

- [ ] **Step 2: Full Python gate for touched modules**

Run: `uv run ruff check src/ tests/ && uv run mypy src/agentos/gateway/control_ui.py scripts/fe_parity_inventory.py && uv run pytest tests/test_gateway tests/test_fe_parity_inventory.py -q`
Expected: all green (baseline for `tests/test_gateway` was 2,358 passing overall gateway/FE subset).

- [ ] **Step 3: Legacy untouched check**

Run: `git diff main --stat -- src/agentos/gateway/static/js src/agentos/gateway/static/css src/agentos/gateway/static/vendor src/agentos/gateway/templates`
Expected: empty — legacy UI byte-identical.

- [ ] **Step 4: Matrix audit**

Open the parity matrix: every row touched by this plan is `ported` with evidence; the `### health` section has zero `pending`; remaining `pending` rows all belong to later plans (12 views, chat, cutover items). Record a short "Plan 1 complete" note at the top of the matrix with the date.

- [ ] **Step 5: Commit any close-out fixes; report**

Report completion to the user with: test counts (FE + Python), dist build size, and the parity-matrix status summary. **Do not push or open a PR without explicit user approval** (repo rule: ask before outward actions).

---

## Follow-up plans (not in this document)

- **Plan 2+:** remaining 12 views in matrix order (overview → logs → approvals → channels → agents → sessions → usage → config → skills → cron → setup), each following the Task-8 pattern (inventory → logic.ts TDD → Page RTL → live check → matrix). Plan 2 also carries the two deferred Layer-0 items from spec §5: the **markdown pipeline** (marked + DOMPurify + Prism as npm deps — first needed by views that render markdown) and the **approval-monitor** background equivalent (js/approval_monitor.js, 271 lines — needed before the approvals view); both get matrix rows now, filled `pending`.
- **Plan chat:** chat.js decomposition (spec §5 Layer 2).
- **Plan cutover:** serve dist/, custom base_path handling, delete legacy, release-pipeline FE build + guard, THIRD_PARTY_NOTICES generation (spec §6.3-6.4 mechanical diffs + gate).
