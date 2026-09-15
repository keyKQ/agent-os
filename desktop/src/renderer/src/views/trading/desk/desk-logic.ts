import type { RawJob } from '@/views/cron/logic'
import { chainName, formatAmount, formatPct, formatUsd, sameAddress, shortAddress } from '../logic'
import { CHAINS, providerLabel, type Order, type Wallet } from '../types'
import { TRADING_AGENT_ID } from './agent'

/**
 * Pure decisions for the chat-centric desk: the strip's status word, the
 * approval card's facts, mission contracts and their cron payloads, the
 * BOOK's concession chain. Nothing here touches the DOM or the gateway, so
 * every rule the screen shows can be checked in a unit test.
 */

/* ── Status word ─────────────────────────────────────────────────────────── */

export type StatusWord = 'awaiting' | 'live' | 'running' | 'idle'

/** AWAITING beats LIVE beats RUNNING beats IDLE: a pending decision is the one thing to see. */
export function statusWord(input: {
  pendingApprovals: number
  streaming: boolean
  missionRunning: boolean
}): StatusWord {
  if (input.pendingApprovals > 0) return 'awaiting'
  if (input.streaming) return 'live'
  if (input.missionRunning) return 'running'
  return 'idle'
}

/* ── Approval card ───────────────────────────────────────────────────────── */

export const HIGH_RISK_USD = 500
export const HIGH_RISK_IMPACT_PCT = 3

export type Risk = 'high' | 'normal'

export function riskStamp(order: Pick<Order, 'valueUsd' | 'priceImpactPct'>): Risk {
  if (order.valueUsd !== null && order.valueUsd >= HIGH_RISK_USD) return 'high'
  if (order.priceImpactPct !== null && order.priceImpactPct >= HIGH_RISK_IMPACT_PCT) return 'high'
  return 'normal'
}

export interface Fact {
  key: string
  label: string
  value: string
  tone?: 'warn' | 'danger'
}

/** The engine owns expiry: print the moment whole, never a renderer countdown. */
export function formatExpiryWhole(ts: number, locale?: string): string {
  const d = new Date(ts)
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    d,
  )
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '−'
  const abs = Math.abs(offsetMin)
  const hh = Math.floor(abs / 60)
  const mm = abs % 60
  const offset = mm ? `UTC${sign}${hh}:${String(mm).padStart(2, '0')}` : `UTC${sign}${hh}`
  return `${when} (${offset})`
}

export function walletDisplay(address: string, wallets: readonly Wallet[]): string {
  const w = wallets.find((x) => sameAddress(x.address, address))
  return w ? `${w.label} · ${shortAddress(w.address)}` : shortAddress(address)
}

/**
 * Bound facts for an approval card. Absent facts render no row: a "–" would
 * invite the reader to trust a value nobody measured.
 */
export function approvalFacts(
  order: Order,
  wallets: readonly Wallet[],
  labels: Record<string, string>,
  locale?: string,
): Fact[] {
  const facts: Fact[] = []
  const push = (key: string, value: string | null | undefined, tone?: Fact['tone']) => {
    if (value === null || value === undefined || value === '') return
    facts.push({ key, label: labels[key] ?? key, value, ...(tone ? { tone } : {}) })
  }
  push('wallet', walletDisplay(order.wallet, wallets))
  push('chain', chainName(order.chainId))
  push('pay', `${formatAmount(order.amountIn)} ${order.tokenIn.symbol}`)
  if (order.expectedOut)
    push('receive', `${formatAmount(order.expectedOut)} ${order.tokenOut.symbol}`)
  if (order.minOut) push('minimum', `${formatAmount(order.minOut)} ${order.tokenOut.symbol}`)
  if (order.expectedOut) {
    const rate = Number(order.expectedOut) / Number(order.amountIn)
    if (Number.isFinite(rate) && rate > 0) {
      push(
        'rate',
        `1 ${order.tokenIn.symbol} ≈ ${formatAmount(String(rate), 6)} ${order.tokenOut.symbol}`,
      )
    }
  }
  if (order.valueUsd !== null) push('value', formatUsd(order.valueUsd))
  if (order.priceImpactPct !== null) {
    push(
      'impact',
      formatPct(order.priceImpactPct),
      order.priceImpactPct >= HIGH_RISK_IMPACT_PCT
        ? 'danger'
        : order.priceImpactPct >= 1
          ? 'warn'
          : undefined,
    )
  }
  if (order.gasUsd !== null) push('gas', formatUsd(order.gasUsd))
  if (order.provider) push('provider', providerLabel(order.provider))
  push('order', order.orderId)
  if (order.expiresAt) push('expires', formatExpiryWhole(order.expiresAt, locale))
  return facts
}

export function ordersForSession<T extends Pick<Order, 'sessionKey'>>(
  orders: readonly T[],
  sessionKey: string,
): T[] {
  return orders.filter((o) => o.sessionKey === sessionKey)
}

/** The chat message a rejection leaves for the agent, so it can re-plan. */
export function rejectionMessage(order: Pick<Order, 'orderId'>, reason: string): string {
  const clean = reason.trim()
  return clean
    ? `Rejected order ${order.orderId}: ${clean}`
    : `Rejected order ${order.orderId}. Do not retry it without asking first.`
}

/* ── Missions ────────────────────────────────────────────────────────────── */

export type MissionKind = 'swap' | 'dca' | 'dip' | 'rebalance' | 'custom'

export type StopRule =
  | { kind: 'none' }
  | { kind: 'until'; until: string }
  | { kind: 'runs'; runs: number }
  | { kind: 'goal' }

export type Interval = { kind: 'every'; seconds: number } | { kind: 'cron'; expr: string }

export interface MissionForm {
  kind: MissionKind
  name: string
  goal: string
  wallets: string[]
  chains: number[]
  budgetTotalUsd: string
  budgetPerOrderUsd: string
  stop: StopRule
  interval: Interval
  dryRun: boolean
}

export const INTERVALS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: '1 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 900, label: '15 min' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 14_400, label: '4 hours' },
  { seconds: 86_400, label: '1 day' },
]

/** What the four chips prefill. `swap` is a one-shot prompt, not a job. */
export function missionPrefill(
  kind: MissionKind,
  ctx: { primary: string | null; chains?: number[] },
): MissionForm {
  const wallets = ctx.primary ? [ctx.primary] : []
  const chains = ctx.chains?.length ? ctx.chains : [8453]
  const base: MissionForm = {
    kind,
    name: '',
    goal: '',
    wallets,
    chains,
    budgetTotalUsd: '100',
    budgetPerOrderUsd: '50',
    stop: { kind: 'none' },
    interval: { kind: 'every', seconds: 3600 },
    dryRun: true,
  }
  switch (kind) {
    case 'swap':
      return { ...base, name: 'Swap', goal: 'Swap 10 USDC to ETH on Base.', dryRun: false }
    case 'dca':
      return {
        ...base,
        name: 'DCA ETH',
        goal: 'Buy 10 USD of ETH with USDC on Base each run.',
        budgetTotalUsd: '300',
        budgetPerOrderUsd: '10',
        interval: { kind: 'every', seconds: 86_400 },
        stop: { kind: 'runs', runs: 30 },
      }
    case 'dip':
      return {
        ...base,
        name: 'Buy the dip',
        goal: 'If ETH is at or below 2,300 USD, buy 25 USD of ETH with USDC on Base; otherwise do nothing.',
        budgetTotalUsd: '100',
        budgetPerOrderUsd: '25',
        interval: { kind: 'every', seconds: 300 },
        stop: { kind: 'goal' },
      }
    case 'rebalance':
      return {
        ...base,
        name: 'Rebalance',
        goal: 'Keep the wallet at 70% ETH / 30% USDC by value on Base; trade only when a side drifts more than 5 points.',
        budgetTotalUsd: '500',
        budgetPerOrderUsd: '100',
        interval: { kind: 'every', seconds: 3600 },
      }
    default:
      return base
  }
}

export const MISSION_COMPLETE_MARKER = 'MISSION COMPLETE'
export const MISSION_TAG = '[Trading desk mission]'
const DRY_RUN_LINE = 'Dry run: this run, only quote and report. Do not swap.'

function usd(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? formatUsd(n) : ''
}

/**
 * The prompt a mission posts into the chat on every run. Deterministic, so
 * the preview in the contract modal is exactly what the agent will read.
 */
export function composeMissionPrompt(
  form: MissionForm,
  ctx: {
    wallets: readonly Wallet[]
    limits: { thresholdUsd: number; dailyCapUsd: number } | null
  },
): string {
  const lines: string[] = []
  lines.push(`${MISSION_TAG} ${form.name.trim() || 'Untitled'}`)
  lines.push(`Goal: ${form.goal.trim()}`)
  const wallets = form.wallets.map((a) => walletDisplay(a, ctx.wallets)).join(', ')
  const chains = form.chains.map((c) => chainName(c)).join(', ')
  lines.push(`Wallets: ${wallets || 'the primary wallet'} · Chains: ${chains || 'Base'}`)
  const total = usd(form.budgetTotalUsd)
  const per = usd(form.budgetPerOrderUsd)
  const budget: string[] = []
  if (total) budget.push(`at most ${total} in total for this mission`)
  if (per) budget.push(`at most ${per} per order`)
  if (budget.length) lines.push(`Budget: ${budget.join(' and ')}. Never exceed it.`)
  if (ctx.limits) {
    lines.push(
      `Engine limits (not yours to change): orders above ${formatUsd(ctx.limits.thresholdUsd)} wait for approval; ${formatUsd(ctx.limits.dailyCapUsd)} per wallet per day.`,
    )
  }
  if (form.kind !== 'swap') {
    lines.push(
      form.interval.kind === 'every'
        ? `Cadence: this message arrives every ${intervalLabel(form.interval.seconds)} from a scheduled job.`
        : `Cadence: this message arrives on the schedule "${form.interval.expr}" from a scheduled job.`,
    )
  }
  lines.push(
    'Rules: use the wallet-trading skill (`agentos trade … --json`). Quote before you swap. ' +
      'If a swap needs approval, wait for it with `agentos trade order <id> --wait-seconds 600 --json` and report the outcome. ' +
      'If nothing should be done this run, say so in one line. Always report order ids and explorer links.',
  )
  const stop = stopLine(form.stop)
  if (stop) lines.push(stop)
  if (form.dryRun) lines.push(DRY_RUN_LINE)
  return lines.join('\n')
}

function stopLine(stop: StopRule): string {
  switch (stop.kind) {
    case 'until':
      return `Stop: after ${stop.until}. When that moment has passed, reply exactly "${MISSION_COMPLETE_MARKER}" and do nothing else.`
    case 'runs':
      return `Stop: after ${stop.runs} runs. Count the previous runs in this conversation; on the last one, end your reply with "${MISSION_COMPLETE_MARKER}".`
    case 'goal':
      return `Stop: when the goal is reached, end your reply with "${MISSION_COMPLETE_MARKER}".`
    default:
      return ''
  }
}

export function intervalLabel(seconds: number): string {
  const known = INTERVALS.find((i) => i.seconds === seconds)
  if (known) return known.label
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

/** Strip the dry-run line once the first run has happened. */
export function withoutDryRun(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== DRY_RUN_LINE)
    .join('\n')
}

export function isDryRunText(text: string | undefined): boolean {
  return Boolean(text && text.split('\n').some((line) => line.trim() === DRY_RUN_LINE))
}

export type MissionError = 'name' | 'goal' | 'interval' | 'budget' | 'stop'

export interface MissionValidation {
  ok: boolean
  error?: MissionError
}

export function validateMission(form: MissionForm): MissionValidation {
  if (!form.name.trim()) return { ok: false, error: 'name' }
  if (!form.goal.trim()) return { ok: false, error: 'goal' }
  if (form.kind !== 'swap' && form.interval.kind === 'every' && form.interval.seconds < 60)
    return { ok: false, error: 'interval' }
  if (form.kind !== 'swap' && form.interval.kind === 'cron' && !form.interval.expr.trim())
    return { ok: false, error: 'interval' }
  for (const v of [form.budgetTotalUsd, form.budgetPerOrderUsd]) {
    if (v.trim() && !(Number(v) > 0)) return { ok: false, error: 'budget' }
  }
  if (form.stop.kind === 'runs' && !(form.stop.runs >= 1)) return { ok: false, error: 'stop' }
  if (form.stop.kind === 'until' && !form.stop.until.trim()) return { ok: false, error: 'stop' }
  return { ok: true }
}

/** The `cron.add` params for a mission that posts into this chat, run by the desk's agent. */
export function missionCronPayload(
  form: MissionForm,
  prompt: string,
  sessionKey: string,
  tz?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    enabled: true,
    payloadKind: 'agent_turn',
    agentId: TRADING_AGENT_ID,
    sessionTarget: 'current',
    targetSessionKey: sessionKey,
    text: prompt,
    schedule:
      form.interval.kind === 'every'
        ? { kind: 'every', every_seconds: form.interval.seconds }
        : { kind: 'cron', expr: form.interval.expr.trim(), ...(tz ? { tz } : {}) },
  }
  if (tz) payload.tz = tz
  return payload
}

export function jobSessionKey(job: RawJob): string {
  return String(
    job.targetSessionKey || job.target_session_key || job.sessionKey || job.session_key || '',
  )
}

export function isSessionMission(job: RawJob, sessionKey: string): boolean {
  return Boolean(sessionKey) && jobSessionKey(job) === sessionKey
}

export type MissionState = 'running' | 'awaiting' | 'sleeping' | 'paused' | 'failed' | 'done'

export interface MissionStatus {
  state: MissionState
  /** Next wake, when the mission sleeps. */
  until: number | null
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

export function missionStatus(
  job: RawJob,
  ctx: { running: boolean; pendingApprovals: number },
): MissionStatus {
  if (ctx.running) return { state: 'running', until: null }
  if (ctx.pendingApprovals > 0) return { state: 'awaiting', until: null }
  if (job.enabled === false) {
    return { state: job.last_status === 'error' ? 'failed' : 'paused', until: null }
  }
  const next = toEpochMs(job.next_run)
  if (job.last_status === 'error') return { state: 'failed', until: next }
  if (next === null) return { state: 'done', until: null }
  return { state: 'sleeping', until: next }
}

export function jobText(job: RawJob): string {
  return String(job.message || job.prompt || '')
}

/** "$1,234.50" as the form writes it: "1234.5". Absent → "". */
function usdField(text: string): string {
  const n = Number(text.replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? String(n) : ''
}

/**
 * The wallets a `Wallets:` line names, in order, resolved against the list.
 * Each entry is what `walletDisplay` wrote: `label · 0x1111…1111`, or just the
 * short address for a wallet the list did not know at the time.
 */
function walletsFromLine(part: string, wallets: readonly Wallet[]): string[] {
  const out: string[] = []
  for (const token of part.split(', ')) {
    const entry = token.trim()
    if (!entry) continue
    const sep = entry.lastIndexOf(' · ')
    const label = sep >= 0 ? entry.slice(0, sep) : entry
    const short = sep >= 0 ? entry.slice(sep + 3) : entry
    const hit =
      wallets.find((w) => shortAddress(w.address) === short) ??
      wallets.find((w) => sep >= 0 && w.label === label) ??
      wallets.find((w) => sep < 0 && w.label === label)
    if (hit && !out.some((a) => sameAddress(a, hit.address))) out.push(hit.address)
  }
  return out
}

function stopFromLine(line: string | undefined): StopRule {
  if (!line) return { kind: 'none' }
  const runs = /^Stop: after (\d+) runs\./.exec(line)
  if (runs) return { kind: 'runs', runs: Number(runs[1]) }
  const until = /^Stop: after (.+?)\. When that moment has passed/.exec(line)
  if (until?.[1]) return { kind: 'until', until: until[1] }
  if (line.startsWith('Stop: when the goal is reached')) return { kind: 'goal' }
  return { kind: 'none' }
}

/**
 * The form a job edits back into. Everything `composeMissionPrompt` wrote is
 * read back — goal, budget, wallets, chains, stop rule, dry run — so editing
 * a mission starts from what it is, not from the blank contract's defaults.
 */
export function missionFromJob(
  job: RawJob,
  primary: string | null,
  wallets: readonly Wallet[] = [],
): MissionForm {
  const form = missionPrefill('custom', { primary })
  form.name = String(job.name || '')
  const text = jobText(job)
  const lines = text.split('\n')
  const goal = lines.find((l) => l.startsWith('Goal: '))
  form.goal = goal ? goal.slice('Goal: '.length) : text
  form.dryRun = isDryRunText(text)

  const budget = lines.find((l) => l.startsWith('Budget: '))
  form.budgetTotalUsd = usdField(/at most \$([\d,.]+) in total/.exec(budget ?? '')?.[1] ?? '')
  form.budgetPerOrderUsd = usdField(/at most \$([\d,.]+) per order/.exec(budget ?? '')?.[1] ?? '')

  const scope = lines.find((l) => l.startsWith('Wallets: '))
  if (scope) {
    const cut = scope.lastIndexOf(' · Chains: ')
    const walletPart = (cut >= 0 ? scope.slice(0, cut) : scope).slice('Wallets: '.length)
    const chainPart = cut >= 0 ? scope.slice(cut + ' · Chains: '.length) : ''
    if (walletPart !== 'the primary wallet') {
      const named = walletsFromLine(walletPart, wallets)
      if (named.length) form.wallets = named
    }
    const chains: number[] = []
    for (const name of chainPart.split(', ')) {
      const id = CHAINS.find((c) => c.name === name.trim())?.id
      if (id !== undefined) chains.push(id)
    }
    if (chains.length) form.chains = chains
  }

  form.stop = stopFromLine(lines.find((l) => l.startsWith('Stop: ')))

  const kind = String(job.scheduleKind || job.schedule_kind || '')
  const raw = job.scheduleRaw ?? job.schedule_raw ?? job.expression ?? job.schedule
  if (kind === 'every' && Number(raw) > 0) form.interval = { kind: 'every', seconds: Number(raw) }
  else if (typeof raw === 'string' && raw.trim().split(/\s+/).length >= 5)
    form.interval = { kind: 'cron', expr: raw.trim() }
  return form
}

/* ── BOOK concession chain ───────────────────────────────────────────────── */

export const CHAT_MIN = 560
export const BOOK_MIN = 300
export const BOOK_MAX = 520
export const BOOK_DEFAULT = 360
export const BOOK_SPINE = 48

/**
 * Who yields when the frame narrows: the BOOK shrinks to its floor, then
 * collapses to the spine; the chat never drops below its floor. The stored
 * preference is never rewritten — widening restores it.
 */
export function bookConcession(
  frameWidth: number,
  preferred: number,
  open: boolean,
): { book: number; collapsed: boolean } {
  if (!open) return { book: BOOK_SPINE, collapsed: true }
  const pref = Math.min(BOOK_MAX, Math.max(BOOK_MIN, preferred))
  if (frameWidth - pref >= CHAT_MIN) return { book: pref, collapsed: false }
  if (frameWidth - BOOK_MIN >= CHAT_MIN) return { book: BOOK_MIN, collapsed: false }
  return { book: BOOK_SPINE, collapsed: true }
}

/* ── Composer placeholder ────────────────────────────────────────────────── */

export const PLACEHOLDERS: readonly string[] = [
  'Swap 20 USDC to ETH on Base',
  'What is my portfolio worth right now?',
  'Buy 10 USD of AAPL on Robinhood Chain',
  'Sell half my ETH if it drops 5% today',
]

export function composerPlaceholder(input: {
  missionWord: string | null
  busy: boolean
  tick: number
  steering: string
}): string {
  if (input.busy) return input.steering
  if (input.missionWord) return input.missionWord
  return (
    PLACEHOLDERS[
      ((input.tick % PLACEHOLDERS.length) + PLACEHOLDERS.length) % PLACEHOLDERS.length
    ] ?? ''
  )
}

/* ── Project knowledge for the desk session ──────────────────────────────── */

export const TRADING_PROJECT_NAME = 'Trading desk'

export function tradingProjectKnowledge(ctx: {
  wallets: readonly Wallet[]
  chains: readonly number[]
  limits: { thresholdUsd: number; dailyCapUsd: number } | null
}): string {
  // The primary is the wallet orders come from; the others exist only so a
  // wallet the user names by label can be resolved. Listing them as peers
  // invited the agent to "check the other wallet too".
  const primary = ctx.wallets.find((w) => w.primary) ?? ctx.wallets[0] ?? null
  const others = ctx.wallets.filter((w) => w !== primary)
  const wallets = primary
    ? [
        `Primary wallet: ${primary.label} (${primary.address}). Every order comes from it unless the user names another wallet in this chat; do not read or report any other wallet's balance for an order.`,
        others.length
          ? `Other wallets, only when the user names them: ${others.map((w) => `${w.label} (${w.address})`).join('; ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    : 'Wallets: none yet.'
  const chains = (ctx.chains.length ? ctx.chains : CHAINS.map((c) => c.id))
    .map((c) => chainName(c))
    .join(', ')
  const limits = ctx.limits
    ? `Orders above ${formatUsd(ctx.limits.thresholdUsd)} wait for the user's approval; ${formatUsd(ctx.limits.dailyCapUsd)} per wallet per day.`
    : ''
  return [
    'You are at the trading desk of the AgentOS desktop app. The user can see wallets, holdings and orders beside this chat.',
    `${wallets} Chains: ${chains}.`,
    'Use the wallet-trading skill: `agentos wallet …` and `agentos trade … --json`. Prefer `--wait` on swaps and report the order id, status and explorer link.',
    limits,
    'Never bypass an approval; if the user rejects an order they will say why in this chat.',
  ]
    .filter(Boolean)
    .join('\n')
}
