import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { normalizeSlashCommand, slashCommandKey, type SlashCommand } from './logic'

/**
 * Slash-command catalog + execution (React).
 *
 * Ported from static/js/views/chat.js:2615-2853: the catalog load
 * `_loadSlashCommands` (chat.js:2615, RPC `commands.list_for_surface` with
 * `{ surface: 'web_chat' }`), the command map (chat.js:2621-2627), and the
 * dispatch `_executeSlashCommand` → `_selectSlashCmd` (chat.js:2842/2684).
 *
 * The catalog + the command map live here (one source) so both <SlashMenu> (which
 * renders/filters) and the composer send path (which executes on Enter over a
 * typed `/cmd`) share them — DRY, and avoids two RPC loads.
 *
 * `_selectSlashCmd`'s action switch (chat.js:2691-2839) dispatches on the
 * serialized `execution.action` / `rpc_method`. The RPC-backed branches (reset /
 * usage / model / router.hold.set / router.hold.clear) are ported faithfully as
 * `rpc.call(...) + toast`. Two branches touch session/stream machinery not yet in
 * the React view and are FLAGGED as later-task seams (see `onSessionAction`):
 *  - `new_chat` (chat.js:2692-2715) — the session-swap (park stream, new key,
 *    persist, chip, viz reset, re-subscribe). Owned by a later session task.
 *  - `compact_context` (chat.js:2738-2763) — the in-flight-compaction separator +
 *    `_setCompactInFlight`; the RPC (`sessions.contextCompact`) is fired, but the
 *    in-thread separator/controls belong to the compaction controller (Task 7).
 * When `onSessionAction` is provided (ChatPage wires it to the transcript), those
 * are delegated; otherwise a faithful toast records the unported affordance.
 */

export interface UseSlashCommands {
  /** The normalized catalog (chat.js:2620 `_slashCmds`). */
  commands: SlashCommand[]
  /**
   * Execute a typed slash-command line (chat.js:2842 `_executeSlashCommand`).
   * Looks the command up in the map, splits off args, and dispatches. Returns
   * true when a command was found + dispatched (so the caller does NOT also send
   * the text as a chat message), false when unknown (legacy toasts + returns true
   * on unknown too — see below; we mirror that so `/typo` never sends as text).
   */
  execute: (text: string) => boolean
}

export function useSlashCommands(opts?: {
  sessionKey: string
  /** Delegate the session/stream-mutating actions (new_chat / compact) to the
   * transcript owner. Receives the resolved action + the command + args. */
  onSessionAction?: (action: string, cmd: SlashCommand, args: string) => void
  /** Append a system message row (chat.js:2814 `/model` result). */
  addSystemMessage?: (text: string) => void
}): UseSlashCommands {
  const rpc = useRpc()
  const sessionKey = opts?.sessionKey ?? ''
  const [commands, setCommands] = useState<SlashCommand[]>([])

  // Late-bound holders so the `execute` closure always reads the latest session
  // key / delegates. Written in an effect (never during render) — `execute` is
  // called imperatively, so it does not need to be recreated when these change.
  const sessionKeyRef = useRef(sessionKey)
  const onSessionActionRef = useRef(opts?.onSessionAction)
  const addSystemMessageRef = useRef(opts?.addSystemMessage)
  useEffect(() => {
    sessionKeyRef.current = sessionKey
    onSessionActionRef.current = opts?.onSessionAction
    addSystemMessageRef.current = opts?.addSystemMessage
  }, [sessionKey, opts?.onSessionAction, opts?.addSystemMessage])

  // ── Catalog load (chat.js:2615-2635 `_loadSlashCommands`) ─────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await rpc.waitForConnection()
        const res = (await rpc.call('commands.list_for_surface', { surface: 'web_chat' })) as {
          commands?: unknown[]
        } | null
        if (cancelled) return
        const list = Array.isArray(res?.commands) ? res.commands : []
        setCommands(list.map((c) => normalizeSlashCommand(c as Record<string, unknown>)))
      } catch {
        if (!cancelled) setCommands([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rpc])

  // The command map (chat.js:2621-2627): name + every alias → the command. Held
  // in a ref (written in an effect) so the imperative `execute` reads the latest
  // without re-creating — never read/written during render.
  const commandMap = useMemo(() => {
    const map = new Map<string, SlashCommand>()
    commands.forEach((cmd) => {
      map.set(slashCommandKey(cmd.name), cmd)
      ;(cmd.aliases || []).forEach((alias) => map.set(slashCommandKey(alias), cmd))
    })
    return map
  }, [commands])
  const commandMapRef = useRef(commandMap)
  useEffect(() => {
    commandMapRef.current = commandMap
  }, [commandMap])

  // ── _selectSlashCmd action switch (chat.js:2684-2839), RPC-backed branches ──
  const dispatch = useCallback(
    (cmd: SlashCommand, args: string) => {
      const key = sessionKeyRef.current
      const commandName = cmd?.cmd || cmd?.name || ''
      // chat.js:2719 — a `/reset` command whose name is actually `/new` runs the
      // new_chat action. Resolve that remap here rather than recursing.
      let action = cmd?.execution?.action || cmd.cmd || cmd.name || ''
      if (
        (action === 'reset_session' || action === 'sessions.reset' || action === '/reset') &&
        commandName === '/new'
      ) {
        action = 'new_chat'
      }

      switch (action) {
        // chat.js:2692-2715 — session swap. Not yet portable in the React view.
        case 'new_chat':
        case '/new': {
          if (onSessionActionRef.current) onSessionActionRef.current('new_chat', cmd, args)
          else toast.info('New chat is available from the session menu')
          return
        }
        // chat.js:2716-2737 — reset the current session. (The `/new`-named-but-
        // reset-action remap is resolved above into `new_chat`.)
        case 'reset_session':
        case 'sessions.reset':
        case '/reset': {
          rpc
            .call('sessions.reset', { key })
            .then(() => toast.info('Session reset'))
            .catch((err: unknown) =>
              toast.error('Reset failed: ' + (err instanceof Error ? err.message : String(err))),
            )
          return
        }
        // chat.js:2738-2763 — manual compaction. The RPC is fired; the in-thread
        // separator + in-flight controls belong to the compaction controller.
        case 'compact_context':
        case 'sessions.contextCompact':
        case '/compact': {
          if (onSessionActionRef.current) {
            onSessionActionRef.current('compact_context', cmd, args)
            return
          }
          rpc
            .call('sessions.contextCompact', { key })
            .then(() => toast.info('Context compaction requested'))
            .catch((err: unknown) =>
              toast.error(
                'Compaction failed: ' + (err instanceof Error ? err.message : String(err)),
              ),
            )
          return
        }
        // chat.js:2764-2789 — usage status / cost.
        case 'usage_status':
        case 'usage.status':
        case '/usage': {
          const arg = args.trim().toLowerCase()
          if (arg === 'page') {
            toast.info('Usage page is available from the sidebar')
            return
          }
          const method = arg === 'cost' ? 'usage.cost' : 'usage.status'
          rpc
            .call(method)
            .then((result: unknown) => {
              const r = (result ?? {}) as Record<string, unknown>
              const totals = (r.totals ?? {}) as Record<string, unknown>
              if (method === 'usage.cost') {
                const total = r.totalCostUsd ?? r.total_cost_usd ?? totals.cost ?? totals.cost_usd
                toast.info(
                  total != null
                    ? `Usage cost: $${Number(total).toFixed(6)}`
                    : 'Usage cost unavailable',
                )
                return
              }
              const tokens = Number(
                r.totalTokens ??
                  r.total_tokens ??
                  totals.tokens ??
                  totals.total_tokens ??
                  totals.totalTokens ??
                  0,
              )
              const cost = r.totalCostUsd ?? r.total_cost_usd ?? totals.cost ?? totals.cost_usd
              toast.info(
                `Usage: ${tokens.toLocaleString()} tokens` +
                  (cost != null ? ` · $${Number(cost).toFixed(6)}` : ''),
              )
            })
            .catch((err: unknown) =>
              toast.error('Usage failed: ' + (err instanceof Error ? err.message : String(err))),
            )
          return
        }
        // chat.js:2790-2818 — model list (optionally filtered), into a system row.
        case 'models.list':
        case '/model': {
          const filter = args.trim().toLowerCase()
          rpc
            .call('models.list', {})
            .then((models: unknown) => {
              const list = Array.isArray(models) ? (models as Record<string, unknown>[]) : []
              const matches = filter
                ? list.filter((m) =>
                    [m.id, m.name, m.provider].some((v) =>
                      String(v || '')
                        .toLowerCase()
                        .includes(filter),
                    ),
                  )
                : list
              if (matches.length === 0) {
                toast.info(filter ? `No models match "${filter}"` : 'No models available')
                return
              }
              const lines = matches.map((m) => {
                const ctx =
                  Number(m.contextWindow) > 0
                    ? ` · ${Math.round(Number(m.contextWindow) / 1000)}k ctx`
                    : ''
                return `• ${m.name || m.id} (${m.id}) — ${m.provider || 'unknown'}${ctx}`
              })
              const title = filter
                ? `Models matching "${filter}" (${matches.length}/${list.length}):`
                : `Available models (${list.length}):`
              const body = [title, ...lines].join('\n')
              if (addSystemMessageRef.current) addSystemMessageRef.current(body)
              else toast.info(title)
            })
            .catch((err: unknown) =>
              toast.error(
                'Model list failed: ' + (err instanceof Error ? err.message : String(err)),
              ),
            )
          return
        }
        // chat.js:2819-2829 — pin the router to a tier (/c0-/c3).
        case 'router.hold.set': {
          const tier = (commandName || '').replace(/^\//, '').toLowerCase()
          rpc
            .call('router.hold.set', { key, tier })
            .then((res: unknown) => {
              const model = (res as { model?: string })?.model
              toast.info('Router pinned to ' + tier + (model ? ' → ' + model : ''))
            })
            .catch((err: unknown) =>
              toast.error(
                'Router pin failed: ' + (err instanceof Error ? err.message : String(err)),
              ),
            )
          return
        }
        // chat.js:2830-2838 — restore automatic routing.
        case 'router.hold.clear': {
          rpc
            .call('router.hold.clear', { key })
            .then((res: unknown) =>
              toast.info(
                (res as { cleared?: boolean })?.cleared
                  ? 'Automatic routing restored'
                  : 'Automatic routing already active',
              ),
            )
            .catch((err: unknown) =>
              toast.error(
                'Router unpin failed: ' + (err instanceof Error ? err.message : String(err)),
              ),
            )
          return
        }
        default:
          // An unmapped action (chat.js: switch falls through with no-op).
          return
      }
    },
    [rpc],
  )

  // chat.js:2842-2853 `_executeSlashCommand`: split cmd + args, look up the map,
  // toast on an unknown command, else dispatch. Returns true either way so the
  // caller never falls through to sending the text as a chat message.
  const execute = useCallback(
    (text: string): boolean => {
      const parts = text.trim().split(/\s+/)
      const cmdText = parts[0] ?? ''
      const rest = parts.slice(1)
      const cmd = commandMapRef.current.get(slashCommandKey(cmdText))
      if (!cmd) {
        toast.warning('Unsupported command: ' + cmdText)
        return true
      }
      dispatch(cmd, rest.join(' '))
      return true
    },
    [dispatch],
  )

  return { commands, execute }
}
