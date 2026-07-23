# Chat View Migration — Design (Plan 3)

**Date:** 2026-07-20
**Status:** Archived (migration completed; React-only cutover 2026-07-23)
**Scope:** Historical migration of the legacy `chat` view
(`src/agentos/gateway/static/js/views/chat.js`, 8,841 lines / ~403 functions /
~42% of the retired JavaScript) to the React + Vite console. It was the final
and largest view; the production route now renders `ChatPage`.

> **ARCHIVED — non-runnable design record.** Legacy source paths and one-time
> audit tooling below document how parity was established; they were removed
> after the React-only cutover. For current behavior and evidence, use the
> parity matrix. For current development and release commands, use `AGENTS.md`,
> `CONTRIBUTING.md`, `docs/web-ui.md`, and `scripts/build_control_ui.py`.

Sibling docs (read alongside this one):
- Rewrite design: `docs/superpowers/specs/2026-07-19-react-vite-console-rewrite-design.md`
- Parity matrix (single source of truth): `docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md`
- Plans 1 & 2 (complete): `docs/superpowers/plans/2026-07-19-*.md`, `2026-07-20-*-plan-2-views.md`

---

## 1. Objective

Reach behavioral parity with legacy `chat.js` in the React console, verified by
per-module tests **and** a mandatory live-browser sweep. No new user-facing
behavior; any unavoidable deviation is recorded **waived** in the parity matrix
for the OWNER to decide — never unilaterally declared "approved".

---

## 2. Architecture: the imperative boundary

The two most consequential decisions, both owner-confirmed during brainstorming:

### 2.1 Render model — port the DOM mechanism verbatim (bounded)

The streaming transcript is **not** rewritten declaratively. The risky,
timing-sensitive core (streaming tail, scroll anchoring, tool cards, artifacts,
router-fx, compaction separators) is ported **near-verbatim** as imperative
`ref`-driven code — the same `innerHTML`/`appendChild`/manual-scroll mechanism as
legacy — because a declarative rewrite of this region silently drifts on exactly
the behaviors tests do not catch (seq ordering, idle timers, animation timing).

The boundary is drawn **tightly around the transcript**. Everything that is
ordinary stateful UI (composer, attachments, slash menu, session chip, elevated
pill, pending queue, dialogs, toasts) becomes **idiomatic React with RTL tests** —
porting those imperatively would throw away testability for zero fidelity gain.

**Imperative (ref-driven, live-verified):**
- Transcript thread + streaming renderer
- Tool activity + artifacts + subagent disclosure
- Router-fx engine (`_routerFx*`, ~80 fns) — a self-contained animation module
- Compaction separators — a self-contained animation module

**React (RTL-tested):**
- Composer, attachments, slash commands, session chip + lifecycle, elevated mode,
  toolbar/model+router config, pending queue + markdown export, inline approvals

### 2.2 WS/RPC consumption — reuse the Task-5 client

The existing `WsRpcClient` (`frontend/src/lib/ws-rpc.ts`, built in Plan-1 Task 5)
already provides everything chat needs at the transport level:
- `on(event, handler) => unsub` (ws-rpc.ts:70), `call(method, params)` (ws-rpc.ts:58)
- `_gap` emission on seq discontinuity (ws-rpc.ts:229-230) and tick timeout (:252)
- `_hello`/`_state` lifecycle, `lastSeq` tracking, exponential reconnect (:21-24,158,283)

This is a **transport-level** seq/reconnect layer. Chat's `_streamSeqBySession`
(800-event seen window, per-session dedup, park/restore) is a **higher
application-level** concern layered on top of the client's ordered feed + `_gap`
signal. No overlap; **no new transport is built.**

**Consumption split:**
- `chat.history` (paginated read) → **react-query**, consistent with all 12 other views.
- Live `session.event.*` stream → **imperative `rpc.on()`** inside the transcript
  controller (`useEffect` keyed on `sessionKey`; `sessions.messages.subscribe` on
  mount, `unsubscribe` on cleanup); seq-dedup and park/restore ported near-verbatim.

---

## 3. Module decomposition (11 modules → SDD tasks)

Build order is **foundation-first**: the transcript controller is the critical
path everything else renders into.

**Phase A — foundation (imperative core):**
1. **Shared `logic.ts` + types + transcript controller skeleton** — pure helpers
   (session-key canonicalization, message identity, seq helpers, formatters),
   types, and the ref-container controller with a thread to render into. TDD for
   the pure helpers.
2. **Transcript streaming** — `render()`, `_ensureStreamBubble`, `_appendDelta`,
   `_flushPendingTextSegment`, `_flushRender`, `_startStreaming`/`_endStreaming`,
   `_reconcileFinalStreamText`, seq-dedup (`_acceptStreamSeq`), park/restore
   (`_parkCurrentSessionStreamState`/`_restoreLiveStreamStateForSession`),
   thinking indicator (400ms delay / 60s TTL), scroll anchoring, stream idle
   timeout (210s), history pagination/merge/day-separators (`_loadHistory`,
   `_loadEarlierHistory`, `_mergeHistoryMessagePages`, `CHAT_HISTORY_PAGE_SIZE=50`).

**Phase B — imperative render children:**
3. **Tool activity + artifacts** — `_buildToolCallDOM`, `_appendToolCall`,
   `_appendToolResult`, tool lifecycle/duration/truncation/error states,
   `_reconstructToolCalls`, artifact cards/category/download/preview
   (`_renderArtifacts`, `_downloadArtifact`, authenticated URLs), subagent
   disclosure (`_appendSubagentCompletion`, task_group.* events).
4. **Router-fx + compaction** — the two animation engines ported as standalone
   imperative modules; `sessions.contextCompact`, compaction separators
   (tones/status/persistence), router-fx tier grid/seed-cache/winner/settled.

**Phase C — React shell:**
5. **Composer** — textarea, resize (`_bindComposerResize`), send/abort
   (`_updateSendButton`, `_onSend`, `chat.abort`), history cycling (`_cycleHistory`),
   autofocus (`_shouldAutofocusComposer`).
6. **Attachments** — MIME validation + size caps (2MB text / 5MB image / 30MB PDF),
   staged upload (`_uploadAttachmentStaged`), large-paste (20k) / page-dump
   detection, previews, `_normalizeOutgoingComposerPayload`, `_MAX_PENDING=5`.
7. **Slash commands** — `commands.list_for_surface`, menu render/filter/select
   (`_handleSlashInput`, `_renderSlashMenu`, `_selectSlashCmd`, `_executeSlashCommand`).
8. **Session chip + lifecycle** — switcher list, `?session=`/`?agent=` URL +
   `agentos_active_session`, copy key, `sessions.reset`, canonical-key helpers,
   `session.epoch_changed`/`sessions.changed` handling.
9. **Elevated mode** — approval-bypass pill, localStorage versioning
   (`agentos.elevatedMode`/`.version`, storage version `2`), `_syncElevatedMode`,
   `router.hold.set`/`clear`.
10. **Toolbar / model + router config** — model picker (`models.list`),
    `config.patch.safe`, `config.get`, toolbar pills, `usage.status` readout.
11. **Pending queue + markdown export + inline approvals** — queued-message rail
    (`_renderPendingQueue`, `_popAllPendingIntoComposer`), `_exportMarkdown`
    (+ artifact links), and in-thread approval prompts (bypass vs. prompt), built
    last since approvals depend on elevated-mode + the transcript. **Inline
    approvals is a first-class parity concern** (own inventory + own matrix rows +
    own live-sweep evidence) even though it ships in this task — it must not be
    under-scoped as a rider on the pending queue. If inventory shows the approval
    surface is larger than expected, split it into its own task rather than
    dropping behavior.

Each module follows the migration protocol (§6): `inventory → logic.ts (TDD) →
component/controller → parity matrix with real evidence`.

---

## 4. Layout & design system

Chat is the one **full-bleed** view (allowed per `globals.css`): its own flex
wrapper — a scrollable thread region above a pinned composer — opting out of
`.view-container` (documented exception). Reuses terminal primitives: `.btn-term`
(send/abort/bracket actions), `AsciiField`/`CommandLine` (composer + slash),
`.tone-*` (approval/error/warning gutters — exactly one gutter per severity,
never stacked), `.t-label`/`.t-display`. Lime `#CCFF00` is **signal only** (active
session, focused composer, send CTA, streaming block cursor). Radius stays `0`.
Dialogs use the portal-centered `ModalShell` (Plan-2 fix) — never a transform
ancestor.

---

## 5. State & data flow

- **History:** `chat.history` via react-query, backward-paginated (page size 50).
- **Live stream:** imperative `rpc.on('session.event.*')` in the transcript
  controller; seq-dedup + park/restore layered on the client's ordered feed.
- **Shell state:** local React state + shared `logic.ts` pure helpers (TDD).
- **localStorage (ported exactly):** `agentos_active_session`,
  `agentos.elevatedMode` / `.version`, `agentos-router-fx`,
  `agentos.chat.debugLog` / `.debug.enabled`, `agent:main:webchat:default`,
  `osq.routerFx.seed:*`.
- **URL params:** `?session=<key>` and `?agent=<id>` (the jump targets Overview /
  Sessions / Agents / Cron already navigate to).

### RPC/WS surface (verify against source; do NOT treat as exhaustive)

RPC calls: `chat.send`, `chat.abort`, `chat.history`, `commands.list_for_surface`,
`config.get`, `config.patch.safe`, `models.list`, `router.hold.set`,
`router.hold.clear`, `sessions.contextCompact`, `sessions.messages.subscribe`,
`sessions.messages.unsubscribe`, `sessions.reset`, `tools.search_provider`,
`usage.status`.

WS events: `session.event.text_delta`, `.tool_use_start`, `.tool_result`,
`.artifact`, `.compaction`, `.router_decision`, `.state_change`, `.warning`,
`.run_heartbeat`, `.subagent_completion`, `.cron_result`, `.task_group.waiting`,
`.task_group.synthesizing`, `.task_group.done`, `.task_group.failed`,
`session.epoch_changed`, `sessions.changed`, `task.queued`, `task.running`, plus
transport `_gap`/`_hello`/`_state`/`*`.

**Historical lesson from Plans 1 & 2:** this list was a starting point, not a
contract. Implementers read `chat.js` end-to-end and cross-checked the one-time
mechanical inventory. The legacy file and extractor were retired after cutover;
the completed parity matrix preserves the result.

---

## 6. Migration protocol (per module)

1. **Inventory (historical)** — the migration read the legacy functions for
   each module and cross-checked a mechanical inventory. Both inputs are now
   retired; current work starts from the React source and regression tests.
2. **`logic.ts` (TDD)** — pure transforms with unit tests written first.
3. **Component / controller** — React (RTL) for shell modules; ref-driven
   controller for the imperative region.
4. **Parity matrix** rows with **real** evidence (test names that actually exist;
   live-browser evidence for the imperative region). Never cite tests that do not
   exist.

---

## 7. Error handling

- Stream idle timeout (210s) → terminal message; server should emit terminal first.
- `_gap` → terminal-history resync (`_syncTerminalSessionChange`).
- Task-terminal (`_taskTerminalMessage`) and session-error (`_sessionErrorMessage`).
- Attachment cap rejections surfaced inline with the allowed-types label.
- RPC failures surfaced **inline** (not toast-only) matching legacy.
- Protocol-text leak stripping (`_stripProtocolTextLeak`) and directive-tag
  stripping (`[[reply_to_current]]`, `[generated artifact omitted: …]`) preserved.

---

## 8. Testing & verification

- **Per module:** `logic.ts` unit tests (TDD) + RTL for the React shell modules.
- **Imperative region** (transcript / tool+artifact / router-fx / compaction):
  verified by the **mandatory live-browser sweep** — the failsafe for the
  RTL-invisible core. Open the view; drive send → stream → tool call → tool result
  → artifact → inline approval → compaction; open every dialog; exercise every
  interaction. Live-browser is what caught the three bugs tests missed in Plans
  1 & 2 (`.view-container` padding, modal centering, `/api` dev proxy).
- **Gate:** `cd frontend && npm run check` (TypeScript + ESLint + Prettier + Vitest).
- **Dev environment:**
  ```bash
  AGENTOS_STATE_DIR=<scratch> uv run agentos gateway run --port 18999
  cd frontend
  AGENTOS_GATEWAY=http://127.0.0.1:18999 npm run dev   # proxies /ws, /control/api, /api
  ```
  Use local browser automation or a Chromium browser to verify runtime behavior.
- **Parity fix round (historical):** a one-time multi-agent audit was completed
  before cutover. Its editor workflow was retired and is not a public release
  command.

---

## 9. Non-goals (YAGNI)

- No new WS transport (reuse `WsRpcClient`).
- No chart/animation library — router-fx/compaction stay hand-ported.
- No reactifying the imperative animation engines.
- No redesign of legacy behaviors. Any behavioral deviation → recorded **waived**
  in the parity matrix for the OWNER to decide, never unilaterally "approved".
- No AI attribution trailers in commits/PRs (repo policy).
- No outward-facing actions (push/PR/tag) without explicit owner approval.

---

## 10. Risks

- **RTL-invisible core:** the imperative transcript can't be unit-tested like the
  other views. Mitigation: the mandatory live-browser sweep is scoped precisely to
  this region, and the pure `logic.ts` helpers under it are TDD'd.
- **Incomplete RPC brief:** mitigated during migration by an end-to-end source
  read and mechanical inventory; the resulting evidence is retained in the
  parity matrix.
- **Streaming timing:** seq-dedup / park-restore / idle-timeout ported verbatim to
  avoid drift; verified live.
- **Scale:** 11 modules, foundation-first, each independently reviewed (Opus
  implementer + independent Opus review per SDD).
