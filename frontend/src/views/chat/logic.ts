// Chat view — pure logic helpers ported verbatim from the legacy
// static/js/views/chat.js. Every function here is pure and side-effect free:
// URL / storage inputs are injected as strings rather than read off `window`,
// so each helper is unit-testable in isolation. Cited legacy line ranges are
// against static/js/views/chat.js.

import type { ChatMessage, Role } from './types'

// The stable webchat session key (chat.js:11).
const WEBCHAT_SESSION_KEY = 'agent:main:webchat:default'

/**
 * Normalize an agent id (chat.js:1138-1143). Lowercased, non-`[a-z0-9_-]`
 * collapsed to `-`, leading/trailing `-` trimmed; empty or `default` → `main`.
 */
export function normalizeAgentId(agentId: string): string {
  const raw = String(agentId ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'default') return 'main'
  const normalized = raw.replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
  return normalized && normalized !== 'default' ? normalized : 'main'
}

/**
 * Extract the agent id from a session key (chat.js:1145-1149). A non-`agent:`
 * key → `main`; otherwise segment [1] normalized.
 */
export function agentIdFromSessionKey(key: string): string {
  const value = String(key ?? '').trim()
  if (!value.startsWith('agent:')) return 'main'
  return normalizeAgentId(value.split(':')[1] || 'main')
}

/**
 * Build a webchat session key for an agent (chat.js:1151-1153).
 */
export function webchatSessionKey(agentId: string, suffix = 'default'): string {
  return 'agent:' + normalizeAgentId(agentId) + ':webchat:' + suffix
}

/**
 * Canonicalize a session key / alias to the stable key (chat.js:1159-1165).
 * Empty / `default` / `webchat:default` → the stable webchat key; an
 * `agent:default:` prefix is rewritten to `agent:main:`; a legacy `sess-`
 * prefix becomes an `agent:main:webchat:` key; anything else passes through.
 */
export function canonicalSessionKey(key: string): string {
  const value = (key ?? '').trim()
  if (!value || value === 'default' || value === 'webchat:default') return WEBCHAT_SESSION_KEY
  if (value.startsWith('agent:default:'))
    return 'agent:main:' + value.slice('agent:default:'.length)
  if (value.startsWith('sess-')) return 'agent:main:webchat:' + value.slice('sess-'.length)
  return value
}

/**
 * Read `?session=` from a search string (chat.js:1182-1187), pure over the
 * injected search rather than `window.location.search`. Returns the value or
 * `null` when absent / unparseable (legacy returns '' from `_readSessionFromUrl`;
 * the caller treats falsy as "no session", so `null` is the faithful pure form).
 */
export function readSessionFromUrl(search: string): string | null {
  try {
    const params = new URLSearchParams(search)
    return params.get('session')
  } catch {
    return null
  }
}

/**
 * The stable transcript id for a message (chat.js:3086-3090). Legacy reads the
 * raw `transcript_id` field and coerces via `Number`, returning the number when
 * finite else `null`. We return the finite value stringified (the brief's
 * `string | null` contract) so downstream identity maps key on a string.
 */
export function messageTranscriptId(msg: ChatMessage): string | null {
  const raw = (msg as { transcript_id?: unknown })?.transcript_id
  const value = Number(raw)
  return Number.isFinite(value) ? String(value) : null
}

/**
 * Stable history identity for a message (chat.js:5833-5836): `message_id` else
 * `id`, stringified; empty string when neither is present. These fields ride on
 * the raw history payload, not the narrowed ChatMessage, so they are read off
 * the loosely-typed object exactly as legacy does.
 */
export function historyStableMessageIdentity(msg: ChatMessage): string {
  const raw = msg as { message_id?: unknown; id?: unknown }
  const stableId = raw?.message_id || raw?.id || ''
  return stableId ? String(stableId) : ''
}

/**
 * Fallback history identity when there is no stable id (chat.js:5838-5839):
 * `${role}|${text}`. Legacy pipes the text through `_historyFallbackText`
 * (chat.js:5842-5846), a role-specific strip pipeline ported by later tasks;
 * this foundation trims the text (the common tail of every legacy branch).
 */
export function historyFallbackMessageIdentity(role: Role, text: string): string {
  return `${role || ''}|${(text || '').trim()}`
}

// chat.js:430 — the "[<iso> <weekday> <tz>]\n" prefix the engine prepends to
// user messages for the model; stripped from the display text.
const TIME_PREFIX_RE =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+\-]\d{2}:\d{2} (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z0-9_+\-/]+\]\n/

/** chat.js:431-433 — strip the leading time prefix from a user message. */
export function stripTimePrefix(text: string): string {
  return typeof text === 'string' ? text.replace(TIME_PREFIX_RE, '') : text
}

/** chat.js:7833-7838 — the `YYYY-MM-DD` day key for a timestamp ('' when bad). */
export function dayKey(ts: string | number | null | undefined): string {
  if (!ts) return ''
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/** chat.js:7840-7849 — human label for a day key (Today/Yesterday/`Mon D`). */
export function dayLabel(isoDay: string): string {
  if (!isoDay) return ''
  const today = new Date()
  const todayKey = today.toISOString().slice(0, 10)
  const yesterKey = new Date(today.getTime() - 86400000).toISOString().slice(0, 10)
  if (isoDay === todayKey) return 'Today'
  if (isoDay === yesterKey) return 'Yesterday'
  const d = new Date(isoDay + 'T12:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Whether the composer should autofocus on view entry (chat.js:1353-1360
 * `_shouldAutofocusComposer`). Legacy returns false on a narrow viewport
 * (`max-width:768px`) or a coarse pointer (touch), else true; a `matchMedia`
 * throw falls through to true. Ported pure over an injected env (an object
 * exposing `matchMedia`) so it is testable without a real `window` — the
 * component passes `window`.
 */
export function shouldAutofocusComposer(env: {
  matchMedia?: (query: string) => { matches: boolean }
}): boolean {
  try {
    const mm = env?.matchMedia
    if (typeof mm !== 'function') return true
    if (mm('(max-width: 768px)').matches) return false
    if (mm('(pointer: coarse)').matches) return false
  } catch {
    /* legacy swallows matchMedia errors and autofocuses (chat.js:1357) */
  }
  return true
}

/**
 * Send-button enable + label state.
 *
 * Label is the verbatim port of `_updateSendButton`'s title ternary
 * (chat.js:7012-7016): compaction-in-flight wins over streaming, which wins
 * over the plain "Send". Legacy keeps the button ALWAYS enabled (a click while
 * streaming enqueues, chat.js:7004-7008) and lets `_onSend` no-op on an empty
 * composer (chat.js:6118). The React composer instead disables Send when the
 * trimmed input is empty — a UI affordance, NOT a legacy behavior — so the
 * button visibly reflects "nothing to send". The enqueue-while-streaming path
 * (and its attachments/slash nuances) lands in Task 9; until then `busy` only
 * drives the label, never re-enabling an empty composer.
 */
export function sendButtonState(
  input: string,
  busy: boolean,
  pendingCompaction: boolean,
): { disabled: boolean; label: string } {
  const disabled = (input ?? '').trim().length === 0
  const label = pendingCompaction
    ? 'Send (queues until compaction finishes)'
    : busy
      ? 'Send (queues for after current response)'
      : 'Send'
  return { disabled, label }
}

// chat.js:661 — minimal HTML-entity escape for text interpolated into innerHTML.
export function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
