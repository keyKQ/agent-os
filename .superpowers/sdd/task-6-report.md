# Plan-3 Task 6 report — Router-fx animation engine (imperative)

> Note: this path previously held the Plan-2 Agents-view report; overwritten with
> the Plan-3 Task-6 report per the brief's report path.

## Status: DONE

The ~80-function router-fx subsystem (chat.js:3263-4680) ported near-verbatim as
one cohesive `transcript/routerFx.ts` module — pure top-level helpers +
`createRouterFxRenderer(deps)` — composed into `createStreamController` (mirroring
the tools/artifacts composition), with the `session.event.router_decision` seam in
`useTranscript` filled by `controller.handleRouterDecision`. `npm run check` is
green (945 tests / 38 files). Pure helpers TDD'd failing-first.

## Files

- **Created** `frontend/src/views/chat/transcript/routerFx.ts` — the whole
  engine. Pure exports (helpers + `createRouterFxRegistry` + roster builders +
  pref/seed helpers) and `createRouterFxRenderer(deps)` (all DOM/animation
  methods, module-globals rebound to registry/instance state).
- **Created** `frontend/src/views/chat/transcript/routerFx.test.ts` — 35 tests
  (30 pure-helper TDD + 5 factory smoke).
- **Modified** `frontend/src/views/chat/transcript/stream.ts` — composed
  `createRouterFxRenderer`; the router-fx lifecycle hooks the stream path already
  called as no-op deps now route to the renderer; exposed `handleRouterDecision`
  + friends on the controller. Added router-fx renderer inputs to
  `StreamControllerDeps` (registry / pref / routerFeatureEnabled / dock /
  awaitConfig / history flags) with faithful defaults.
- **Modified** `frontend/src/views/chat/useTranscript.ts` — the
  `session.event.router_decision` handler now calls
  `controller.handleRouterDecision(payload)` (kept the `seams().handleRouterDecision?.()`
  passthrough, mirroring tool/artifact events).
- **Modified** `docs/superpowers/specs/2026-07-19-console-rewrite-parity-matrix.md`
  — Task-6 banner + 20 rows.

## Function inventory ported from chat.js:3263-4680 (nothing dropped)

| Concern | Legacy fn(s) | Legacy lines | In routerFx.ts |
| --- | --- | --- | --- |
| pref load/save | `_routerFxLoadPref`/`_routerFxSavePref` | 3398-3417 | `routerFxLoadPref`/`routerFxSavePref` |
| tier sort/normalize/register | `_routerFxSortTiers`/`_routerFxNormalizeTier`/`_routerFxRegisterTier` | 3419-3440 | `routerFxSortTiers`/`routerFxNormalizeTier` + registry.registerTier |
| model display / strip provider | `_modelDisplayName`/`_routerFxStripProvider` | 3444-3453 | `modelDisplayName`/`routerFxStripProvider` |
| request kind (attach/normalize/decision) | `_routerFxRequestKindFromAttachments`/`_routerFxNormalizeRequestKind`/`_routerFxRequestKindFromDecision` | 3455-3506 | same names |
| tier config/remember/match | `_routerFxTierConfig`/`_routerFxRememberTierDecision`/`_routerFxTierMatchesRequestKind` | 3468-3498 | registry.tierConfig/rememberTierDecision + `routerFxTierMatchesRequestKind` |
| visual entries / multi-candidate | `_routerFxVisualEntries`/`_routerFxHasMultipleCandidates` | 3508-3553 | `routerFxVisualEntries`/`routerFxHasMultipleCandidates` (pure over registry) |
| config-ready gate | `_routerFxMarkConfigReady`/`_routerFxAwaitConfig` | 3559-3575 | injected `awaitConfig` dep (gate owner = config loader, later task) |
| seed key/trim/resolve/layout | `_routerFxSeedCacheKey`/`_routerFxSeedCacheTrim`/`_routerFxResolveSeed`/`_routerFxResolveLayoutSeed` | 3582-3630 | same names |
| identity helpers | `_routerFxIdentity`/`_routerFxDecisionIdentity`/`_routerFxUsageIdentity` | 3631-3644 | same names |
| user-msg count/last/for-assistant | `_routerFxCountUserMessages`/`_routerFxLastUserMessage`/`_routerFxUserMessageForAssistant` | 3645-4413 | `countUserMessages`/`lastUserMessage`/`userMessageForAssistant` |
| pending cache/flush | `_pendingRouterDecisionKey`/`_cachePendingRouterDecision`/`_flushPendingRouterDecisions` | 3652-3685 | `cachePendingRouterDecision`/`flushPendingRouterDecisions` |
| real entries / grid cells | `_routerFxRealEntries`/`_routerFxBuildGridCells` | 3691-3706 | `realEntries`/`buildGridCells` |
| build element / winner cell | `_buildRouterFxElement`/`_routerFxWinnerCellIndex` | 3708-3793 | `buildRouterFxElement`/`winnerCellIndex` |
| selector position / ping | `_routerFxPositionSelector`/`_routerFxPing` | 3797-3822 | `positionSelector`/`ping` |
| timers/settled/residue/normalize/removeStrip | `_routerFxClearAnimationTimers`/`_routerFxApplySettledSemantics`/`_routerFxClearVisualResidue`/`_routerFxNormalizeSettledStrip`/`_routerFxDisconnectLabelFit`/`_routerFxRemoveStrip` | 3824-3895 | same-named methods |
| dock strips/mount/staticize | `_routerFxStrips`/`_routerFxMountStrip`/`_routerFxStaticizeCompletedStrips` | 3900-3927 | `strips`/`mountStrip`/`staticizeCompletedStrips` |
| settle immediate / burst | `_settleRouterFxImmediate`/`_routerFxFireBurst` | 3929-3968 | `settleRouterFxImmediate`/`fireBurst` |
| one-shot animate | `_animateRouterFx` | 3970-4036 | `animateRouterFx` (retained for parity; not on the delayed-scan path) |
| winner name | `_routerFxWinnerName` | 4039-4045 | `winnerName` |
| scan schedule/begin/roam/stop/pause/resume/finish/settle-for-output | `_scheduleRouterFxBeginScan`/`_routerFxBeginScan`/`_routerFxScanRoam`/`_routerFxStopScan`/`_routerFxPauseScanTimers`/`_routerFxResumeLiveStrip`/`_routerFxFinishScan`/`_routerFxSettleForOutput` + pending-scan helpers | 4047-4341 | same-named methods |
| lock / lock grid | `_routerFxLock`/`_routerFxLockGrid` | 4343-4379 | `lock`/`lockGrid` |
| label fit | `_routerFxMeasureLabels`/`_routerFxScheduleLabelFit`/`_routerFxInstallLabelFit`/`_routerFxFitLabels` | 4419-4463 | same-named methods |
| insert anchored | `_routerFxInsertAnchored` | 4465-4472 | `insertAnchored` (legacy reference-assistant param dropped — dock mount ignores it) |
| live entry | `_handleRouterDecision` | 4480-4631 | `handleRouterDecision` |
| history-from-usage | `_buildRouterFxFromUsage` | 4637-4680 | `buildRouterFxFromUsage` |
| compaction suppress | `_routerFxIsSuppressedForCompactionTurn`/`_suppressRouterFxForCompaction` | 3263-3282 | `isSuppressedForCompactionTurn`/`suppressForCompaction` |
| clear visuals | `_clearRouterFxVisuals` | 4070-4073 | `clearRouterFxVisuals` |

**Gaps / not-dropped-but-deferred:** none silently dropped. The config-load path
(`_loadFeatureToggles`, chat.js:1478-1545) that populates the registry +
resolves the config-ready gate is a **later task** (no config loader in the
frontend yet); `awaitConfig` defaults to `Promise.resolve()` and the registry
stays empty (`configTiers === null`), so strips are suppressed until it lands.

## Module-globals → state mapping

- `_routerFxSlotList` / `_routerFxModels` / `_routerFxTierConfigs` /
  `_routerFxConfigTiers` → `RouterFxRegistry` (`createRouterFxRegistry`), owned by
  the controller and shared with the (future) config loader.
- `_routerFx` (enabled/variant) → `RouterFxPref`, hydrated via `routerFxLoadPref`
  at controller composition.
- `_routerFeatureEnabled` → injected `routerFeatureEnabled()` dep (default false).
- `_pendingRouterDecisions` (Map) → renderer instance field.
- `_routerFxScanPending` / `_routerFxScanDelayTimer` → renderer instance `let`s.
- `_compactSuppressedRouterSessionKey` / `_compactSuppressedRouterTurnIndex` →
  renderer instance `let`s (overridable by an injected predicate for Task 7).
- `_routerFxDock` (DOM element) → injected `dock()`; `hasDock()` = `!!dock()`,
  preserving legacy `if (!_routerFxDock)` short-circuit semantics.
- Per-strip `wrap._fx*` expandos → typed `RouterFxStripElement` interface.

## Seam fill + controller composition

Composed inside `createStreamController` exactly how `createToolRenderer` /
`createArtifactRenderer` are. The stream lifecycle's router-fx hooks (previously
no-op deps) now default to the renderer's methods: `settleForOutput`
(ensureStreamBubble), `cancelPendingRouterFxScan` + `staticizeCompletedStrips`
(endStreaming), `pauseScanTimers`/`resumeLiveStrip` +
`currentSessionLiveRouterStrips` + `insertLiveRouterStripForAnchor` +
`routerFxDock` (park/restore). `handleRouterDecision` (+ `buildRouterFxFromUsage`,
`flushPendingRouterDecisions`, `cachePendingRouterDecision`,
`scheduleRouterFxBeginScan`, `suppressRouterFxForCompaction`, `routerFxRegistry`,
`routerFxPref`) are exposed on the controller. `useTranscript`'s
`session.event.router_decision` handler calls `controller.handleRouterDecision(payload)`
after the epoch/seq gate, keeping the `seams().handleRouterDecision?.()` passthrough.

## M-3 (history-render config gate): FLAGGED FORWARD

Legacy `_loadHistory` awaits `_routerFxAwaitConfig()` before rendering (chat.js:5456)
so history router strips don't render with tier-id placeholders. I did NOT wire a
gate because there is nothing to gate yet: (a) the frontend history renderer
(`transcript/history.ts`) does not build router strips (Task 3 deferred the
router-fx machinery in `_renderHistoryMessages` to me and it remains no-op), and
(b) there is no config loader populating the registry, so `awaitConfig` is a
resolved default and the registry stays empty (→ strips suppressed regardless).
The gate becomes meaningful only once BOTH the config loader AND history
router-strip rendering exist — both later tasks that own `_renderHistoryMessages`
internals / config-load I should not touch here. The plumbing is ready:
`createStreamController` accepts `routerFxAwaitConfig` + `historyHasRendered` +
`historyHydrating` deps, and `handleRouterDecision` already routes through them +
`cachePendingRouterDecision` on the anchor race. **Flag: wire `routerFxAwaitConfig`
into the history-render gate when the config loader + history router-strip build land.**

## Pure-helper test names + counts

`routerFx.test.ts` — **35/35 pass**:
- `modelDisplayName` (5), `routerFxStripProvider` (1), `routerFxNormalizeRequestKind` (1),
  `routerFxRequestKindFromAttachments` (4), `routerFxSeedCacheKey` (2),
  `routerFxNormalizeTier` (3), `routerFxSortTiers` (2), `routerFxIdentity` (3),
  `routerFxDecisionIdentity/routerFxUsageIdentity` (3), `routerFxVisualEntries` (4),
  `routerFxHasMultipleCandidates` (2) — **30 pure-helper**.
- `createRouterFxRenderer (factory smoke)` (5): build-null ≤1 candidate; build 3-cell
  grid; hasDock reflects the injected dock; disabled-pref no-op (tier still warm-cached);
  no-tier skip — **5 factory**.

TDD followed: wrote tests → ran (FAIL: module resolution error) → implemented →
ran (PASS 30) → added factory smoke → 35 PASS.

## `npm run check` summary

Green: `tsc --noEmit` clean, `eslint src` 0 errors / 0 warnings, `prettier
--check src` clean, **945 vitest tests / 38 files pass** (was 910/37; +35
router-fx tests, +1 file).

## Parity rows

`### chat`: a Task-6 banner + 20 rows. Pure helpers cite the **real unit test
names**; `buildRouterFxElement` / `handleRouterDecision` cite the factory-smoke
tests as **partial** and mark the full scan→lock→settle DOM path as **"live-sweep
pending (controller)"**; every DOM/animation row (scan lifecycle, label-fit,
settle/burst, seed-cache side-effects) is **"live-sweep pending (controller)"**.
The dock row records **no dock in the frontend → suppressed**.

## What the read surfaced that the brief/design missed

1. **Brief-example value confirmed WRONG (as the brief warned):** the brief's
   `normalizeRequestKind('TEXT')===normalizeRequestKind('text')` example is true,
   but ONLY because legacy does NOT lowercase — both are non-`"image"`→text.
   `"IMAGE"` (uppercase) → text, NOT image. Ported the case-SENSITIVE legacy
   behavior verbatim and unit-asserted the `"IMAGE"`→text edge.
2. **`_routerFxDock` is a DOM ELEMENT, not a boolean flag** (Task-2 flagged it).
   Wired `hasDock()` = `!!dock()`; `dock()` defaults to null → every strip is
   suppressed, faithful to legacy `if (!_routerFxDock)`. Router-fx is therefore
   **inert end-to-end until the dock element ships** (a later task) — correct.
3. **Tasks 4/5 route their events through `controller.appendToolCall` /
   `controller.appendArtifact`, NOT the `useTranscript` seam** (the seam call is
   an additional passthrough; nothing fills the seam object — ChatPage passes no
   seams). Mirrored that exactly for router_decision rather than filling the
   `seams().handleRouterDecision` no-op — otherwise nothing would drive it.
4. **The config-load path + history router-strip rendering are both absent** in
   the frontend (see M-3). Flagged forward with the plumbing in place.
5. **`_animateRouterFx` (chat.js:3970-4036) is dead on the shipped path** — the
   delayed-scan path (`scanRoam` + `finishScan`/`lock`) drives the animation;
   `_animateRouterFx` is a one-shot variant not called by any live entry point in
   the range. Ported verbatim for completeness; exposed but unused. Flagged.

## jsdom limitations

Factory-smoke tests exercise only the branch logic that does not need layout:
build-null / build-grid / hasDock / disabled-pref no-op / no-tier skip. Anything
needing real layout — `positionSelector` (`getBoundingClientRect`),
`measureLabels` (`clientWidth`/`scrollWidth`), the rAF/timer-driven
scan→lock→settle→burst sequence, `ResizeObserver` / `document.fonts.ready`
label-fit — is NOT asserted here (jsdom returns 0-size rects, no real layout); it
is **live-sweep pending (controller)** per the sanctioned test surface.

## Commit

`3b04a8f..5dab119` — `feat(frontend): chat router-fx animation engine (imperative)`
(no AI-attribution trailer).
