// Pure cron-view helpers ported 1:1 from the legacy view
// (src/agentos/gateway/static/js/views/cron.js). Each function below carries the
// legacy line range it mirrors so the parity matrix stays auditable. RPC calls,
// event subscriptions, and rendering live in CronPage.tsx; this module owns the
// pure derivations (cron parse/humanize + next-run computation, schedule/kind
// labels, run-status derivation, list sorting, and the time/duration
// formatters).

/** A raw cron job row from cron.list (all fields optional; snake or camel). */
export interface RawJob {
  id?: string
  name?: string
  enabled?: boolean
  status?: string
  expression?: string
  schedule?: string
  next_run?: string | number | null
  last_run?: string | number | null
  last_status?: string
  payloadKind?: string
  payload_kind?: string
  sessionTarget?: string
  session_target?: string
  message?: string
  prompt?: string
  [key: string]: unknown
}

/** A raw run-history row from cron.runs (all fields optional; snake or camel). */
export interface RawRun {
  started_at?: string | number
  status?: string
  duration_ms?: number | null
  summary?: string
  sessionKey?: string
  deliveryStatus?: unknown
  delivery_status?: unknown
  [key: string]: unknown
}

// ── job-kind label / class (cron.js:600-610) ────────────────────────────────

/** cron.js:600-605 — the human kind label for a job (reminder / system / agent). */
export function jobKindLabel(job: RawJob): string {
  const kind = job.payloadKind || job.payload_kind
  if (kind === 'reminder') return 'Reminder'
  if (kind === 'system_event') return 'System event'
  return 'Agent task'
}

/** cron.js:607-610 — reminder→is-reminder, everything else→is-agent. */
export function jobKindClass(job: RawJob): 'is-reminder' | 'is-agent' {
  const kind = job.payloadKind || job.payload_kind
  return kind === 'reminder' ? 'is-reminder' : 'is-agent'
}

/** cron.js:622 — the session-target display (camel|snake|—). */
export function jobTarget(job: RawJob): string {
  return String(job.sessionTarget || job.session_target || '—')
}

/** cron.js:618 — the schedule expression display (expression|schedule|—). */
export function jobSchedule(job: RawJob): string {
  return String(job.expression || job.schedule || '—')
}

// ── run-status derivation (cron.js:355-377, 614, 624, 679-686) ──────────────

/**
 * cron.js:355-360 — a job's next run is "upcoming" when it is enabled, not
 * currently running, and its next_run parses to a future timestamp.
 */
export function isUpcomingRun(job: RawJob, now: number = Date.now()): boolean {
  if (!job || !job.enabled || !job.next_run) return false
  if (job.status === 'running') return false
  const ts = new Date(job.next_run as string | number)
  return !Number.isNaN(ts.getTime()) && ts.getTime() > now
}

/**
 * cron.js:614,624,686 — the status dot variant for a job row: off when
 * disabled, error on a failed last run, else on. Status color is expressed via
 * the --tone primitive by the caller; this returns the semantic bucket.
 */
export type CronDot = 'off' | 'error' | 'on'

export function jobDotState(job: RawJob): CronDot {
  if (!job.enabled) return 'off'
  const lastStatus = job.last_status || (job.last_run ? 'ok' : null)
  if (lastStatus === 'error' || lastStatus === 'fail') return 'error'
  return 'on'
}

/** cron.js:400-402 — a last_status is "good" (ok/success) vs anything else. */
export function isOkStatus(status: string | undefined | null): boolean {
  return status === 'ok' || status === 'success'
}

// ── next-run text derivations (cron.js:362-377) ─────────────────────────────

/**
 * cron.js:362-370 — the "next run" cell text: '—' when disabled/absent/invalid,
 * 'running' while running, 'awaiting update' when the timestamp is already in
 * the past, else a human countdown ("in 5m 0s").
 */
export function nextRunText(job: RawJob, now: number = Date.now()): string {
  if (!job || !job.enabled) return '—'
  if (job.status === 'running') return 'running'
  if (!job.next_run) return '—'
  const ts = new Date(job.next_run as string | number)
  if (Number.isNaN(ts.getTime())) return '—'
  if (ts.getTime() <= now) return 'awaiting update'
  return humanCountdown(ts, now)
}

/**
 * cron.js:372-377 — the absolute "next run" companion string ('' when
 * disabled/running/absent/past, else a friendly today/tomorrow/date+time).
 */
export function nextRunAbs(job: RawJob, now: number = Date.now()): string {
  if (!job || !job.enabled || job.status === 'running' || !job.next_run) return ''
  const ts = new Date(job.next_run as string | number)
  if (Number.isNaN(ts.getTime()) || ts.getTime() <= now) return ''
  return humanTime(ts, now)
}

// ── list sort (cron.js:539-553) ─────────────────────────────────────────────

export type SortCol =
  'name' | 'payloadKind' | 'sessionTarget' | 'expression' | 'last_run' | 'next_run'

/**
 * cron.js:539-553 — non-mutating sort. Date columns (next_run/last_run) compare
 * numerically, pushing missing timestamps to the far end (Infinity asc /
 * -Infinity desc); everything else compares as a lower-cased string. asc flag
 * flips the comparison.
 */
export function sortJobs<T extends RawJob>(list: T[], col: string, asc: boolean): T[] {
  return [...list].sort((a, b) => {
    let va: number | string = (a as Record<string, unknown>)[col] as number | string
    let vb: number | string = (b as Record<string, unknown>)[col] as number | string
    if (va == null) va = ''
    if (vb == null) vb = ''
    if (col === 'next_run' || col === 'last_run') {
      va = va ? new Date(va).getTime() : asc ? Infinity : -Infinity
      vb = vb ? new Date(vb).getTime() : asc ? Infinity : -Infinity
    } else {
      va = String(va).toLowerCase()
      vb = String(vb).toLowerCase()
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0
    return asc ? cmp : -cmp
  })
}

// ── search filter (cron.js:562-569) ─────────────────────────────────────────

/**
 * cron.js:562-569 — case-insensitive filter across name / message|prompt /
 * payloadKind / sessionTarget|session_target / expression|schedule. Empty query
 * keeps everything (returns a copy).
 */
export function filterJobs<T extends RawJob>(list: T[], search: string): T[] {
  const q = search.toLowerCase()
  if (!q) return [...list]
  return list.filter(
    (j) =>
      (j.name || '').toLowerCase().includes(q) ||
      (j.message || j.prompt || '').toLowerCase().includes(q) ||
      (j.payloadKind || '').toLowerCase().includes(q) ||
      String(j.sessionTarget || j.session_target || '')
        .toLowerCase()
        .includes(q) ||
      (j.expression || j.schedule || '').toLowerCase().includes(q),
  )
}

// ── run-history row derivation (cron.js:894-909) ────────────────────────────

export interface RunRow {
  timeLabel: string
  status: string
  statusOk: boolean
  duration: string
  delivery: string
  reply: string
  sessionKey: string
}

/**
 * cron.js:894-909 — derive one run-history table row. deliveryStatus may be an
 * object ({channel, ws}) rendered as "ch: …, ws: …", a bare string, or absent.
 * `relTime` is injected so the pure helper stays clock/format-agnostic.
 */
export function runRow(run: RawRun, relTime: (ts: string | number) => string): RunRow {
  const ds = run.deliveryStatus ?? run.delivery_status
  const delivery =
    ds && typeof ds === 'object'
      ? `ch: ${(ds as Record<string, unknown>).channel ?? '-'}, ws: ${(ds as Record<string, unknown>).ws ?? '-'}`
      : ds != null
        ? String(ds)
        : '—'
  const status = run.status || 'unknown'
  const summary = run.summary ? String(run.summary) : ''
  return {
    timeLabel: run.started_at != null ? relTime(run.started_at) : '—',
    status,
    statusOk: status === 'ok',
    duration: run.duration_ms != null ? run.duration_ms + 'ms' : '—',
    delivery,
    reply: summary ? summary.substring(0, 120) : '—',
    sessionKey: run.sessionKey ? String(run.sessionKey) : '',
  }
}

// ── time / duration formatters (cron.js:1446-1483) ──────────────────────────

/** cron.js:1463-1472 — coarse duration: s / m+s / h+m / d+h. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + (m % 60) + 'm'
  const d = Math.floor(h / 24)
  return d + 'd ' + (h % 24) + 'h'
}

/** cron.js:1446-1454 — signed countdown: "now" / "in <dur>" / "<dur> ago". */
export function humanCountdown(date: Date, now: number = Date.now()): string {
  const diff = date.getTime() - now
  if (diff < 0) return formatDuration(-diff) + ' ago'
  if (diff < 1000) return 'now'
  return 'in ' + formatDuration(diff)
}

/** cron.js:1456-1461 — past-facing: "just now" / "<dur> ago" / "in <dur>". */
export function humanCountdownPast(date: Date, now: number = Date.now()): string {
  const diff = now - date.getTime()
  if (diff < 0) return 'in ' + formatDuration(-diff)
  if (diff < 1000) return 'just now'
  return formatDuration(diff) + ' ago'
}

/** cron.js:1474-1483 — friendly clock: today/tomorrow HH:MM else weekday date. */
export function humanTime(date: Date, now: number = Date.now()): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86400000)
  const dayAfter = new Date(today.getTime() + 2 * 86400000)
  const t = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date >= today && date < tomorrow) return `today ${t}`
  if (date >= tomorrow && date < dayAfter) return `tomorrow ${t}`
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + t
}

// ── cron expression parser (cron.js:1255-1343) ──────────────────────────────

export interface CronField {
  all: boolean
  set?: Set<number>
}

export interface ParsedCron {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
  raw: string
}

function toNum(
  token: string | null | undefined,
  names: Record<string, number> | undefined,
): number | null {
  if (token == null) return null
  const t = String(token).trim().toLowerCase()
  if (t === '') return null
  if (names && names[t] !== undefined) return names[t]
  const n = parseInt(t, 10)
  if (Number.isNaN(n)) return null
  return n
}

/** cron.js:1255-1279 — parse one cron field (lists, ranges, steps, names). */
export function parseField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField {
  if (field === '*' || field === '?') return { all: true }
  const out = new Set<number>()
  field.split(',').forEach((part) => {
    let stepStr = '1'
    let core = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      core = part.slice(0, slash)
      stepStr = part.slice(slash + 1)
    }
    const step = Math.max(1, parseInt(stepStr, 10) || 1)
    let lo = min
    let hi = max
    if (core === '*' || core === '') {
      lo = min
      hi = max
    } else if (core.includes('-')) {
      const [a, b] = core.split('-')
      const na = toNum(a, names)
      const nb = toNum(b, names)
      lo = na as number
      hi = nb as number
    } else {
      const n = toNum(core, names)
      lo = hi = n as number
    }
    if (lo === null || hi === null || lo > max || hi < min) return
    lo = Math.max(min, lo)
    hi = Math.min(max, hi)
    for (let v = lo; v <= hi; v += step) out.add(v)
  })
  return { all: false, set: out }
}

/**
 * cron.js:1291-1307 — parse a 5-field cron expression; returns null on any
 * malformed input (wrong field count or a throwing field). 7→0 folds Sunday.
 */
export function parseCron(expr: string): ParsedCron | null {
  if (!expr) return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const monthNames: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  }
  const dowNames: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  }
  try {
    const minute = parseField(parts[0]!, 0, 59)
    const hour = parseField(parts[1]!, 0, 23)
    const dom = parseField(parts[2]!, 1, 31)
    const month = parseField(parts[3]!, 1, 12, monthNames)
    const dow = parseField(parts[4]!, 0, 6, dowNames)
    if (!dow.all && dow.set!.has(7)) {
      dow.set!.delete(7)
      dow.set!.add(0)
    }
    return { minute, hour, dom, month, dow, raw: expr }
  } catch {
    return null
  }
}

function matches(field: CronField, v: number): boolean {
  return field.all || field.set!.has(v)
}

/**
 * cron.js:1311-1343 — the next `count` fire times from `fromTs` (default now),
 * scanning minute-by-minute up to a year out. Vixie DOM/DOW semantics: when both
 * are restricted, match either.
 */
export function nextRuns(parsed: ParsedCron | null, count: number, fromTs?: number): Date[] {
  if (!parsed) return []
  const results: Date[] = []
  const now = Date.now()
  const start = new Date(fromTs ?? now)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  let d = new Date(start)
  const endLimit = now + 365 * 24 * 3600 * 1000
  while (results.length < count && d.getTime() < endLimit) {
    const m = d.getMinutes()
    const h = d.getHours()
    const dom = d.getDate()
    const mon = d.getMonth() + 1
    const dow = d.getDay()
    const domAll = parsed.dom.all
    const dowAll = parsed.dow.all
    const dayOk =
      domAll && dowAll
        ? true
        : domAll
          ? matches(parsed.dow, dow)
          : dowAll
            ? matches(parsed.dom, dom)
            : matches(parsed.dom, dom) || matches(parsed.dow, dow)
    if (
      matches(parsed.minute, m) &&
      matches(parsed.hour, h) &&
      matches(parsed.month, mon) &&
      dayOk
    ) {
      results.push(new Date(d))
    }
    d = new Date(d.getTime() + 60_000)
  }
  return results
}

// ── cron humanizer (cron.js:1345-1399) ──────────────────────────────────────

function humanizeFieldList(field: CronField, allLabel: string, names?: string[]): string {
  if (field.all) return allLabel
  const arr = [...field.set!].sort((a, b) => a - b)
  if (arr.length === 0) return '—'
  const display = arr.map((v) => (names ? names[v]! : String(v).padStart(2, '0')))
  if (display.length === 1) return display[0]!
  if (display.length <= 4) return display.join(', ')
  return display.slice(0, 3).join(', ') + ` & ${display.length - 3} more`
}

/**
 * cron.js:1355-1399 — a best-effort English description of a cron expression;
 * '' when it does not parse. Covers the common patterns (every minute, hourly
 * at :mm, daily/weekday/weekend/date/month at HH:MM, every N minutes) and falls
 * back to a "at minute …, hour …" phrasing.
 */
export function explainCron(expr: string): string {
  const p = parseCron(expr)
  if (!p) return ''
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const monNames = [
    '',
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]

  if (p.minute.all && p.hour.all) return 'Every minute'
  if (!p.minute.all && p.minute.set!.size === 1 && p.hour.all) {
    const m = [...p.minute.set!][0]!
    return `Every hour at :${String(m).padStart(2, '0')}`
  }
  if (!p.minute.all && p.minute.set!.size === 1 && !p.hour.all && p.hour.set!.size === 1) {
    const m = [...p.minute.set!][0]!
    const h = [...p.hour.set!][0]!
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    if (p.dom.all && p.dow.all && p.month.all) return `Every day at ${time}`
    if (!p.dow.all && p.dom.all && p.month.all) {
      const days = [...p.dow.set!].sort((a, b) => a - b).map((v) => dowNames[v]!)
      if (days.length === 5 && days[0] === 'Mon' && days[4] === 'Fri') return `Weekdays at ${time}`
      if (days.length === 2 && days.includes('Sat') && days.includes('Sun'))
        return `Weekends at ${time}`
      return `${days.join(', ')} at ${time}`
    }
    if (!p.dom.all && p.dow.all && p.month.all) {
      const days = [...p.dom.set!].sort((a, b) => a - b).join(', ')
      return `Day ${days} of every month at ${time}`
    }
    if (!p.dom.all && p.dow.all && !p.month.all) {
      const months = [...p.month.set!]
        .sort((a, b) => a - b)
        .map((v) => monNames[v]!)
        .join(', ')
      const days = [...p.dom.set!].sort((a, b) => a - b).join(', ')
      return `${months} ${days} at ${time}`
    }
  }
  if (!p.minute.all && p.minute.set!.size > 1 && p.hour.all) {
    const arr = [...p.minute.set!].sort((a, b) => a - b)
    const diffs = arr.slice(1).map((v, i) => v - arr[i]!)
    if (diffs.length && diffs.every((d) => d === diffs[0]) && arr[0]! % diffs[0]! === 0) {
      return `Every ${diffs[0]} minutes`
    }
  }

  const minPart = humanizeFieldList(p.minute, 'every minute')
  const hourPart = humanizeFieldList(p.hour, 'every hour')
  return `at minute ${minPart}, hour ${hourPart}`
}
