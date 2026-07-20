import { describe, expect, it } from 'vitest'
import {
  explainCron,
  filterJobs,
  formatDuration,
  humanCountdown,
  humanCountdownPast,
  humanTime,
  isOkStatus,
  isUpcomingRun,
  jobDotState,
  jobKindClass,
  jobKindLabel,
  jobSchedule,
  jobTarget,
  nextRunAbs,
  nextRuns,
  nextRunText,
  parseCron,
  parseField,
  runRow,
  sortJobs,
  type RawJob,
} from './logic'

// A fixed clock so countdown / next-run text is deterministic.
const NOW = new Date('2026-05-18T09:00:00.000Z').getTime()

describe('jobKindLabel / jobKindClass', () => {
  it('labels reminder / system_event / agent (camel or snake)', () => {
    expect(jobKindLabel({ payloadKind: 'reminder' })).toBe('Reminder')
    expect(jobKindLabel({ payload_kind: 'system_event' })).toBe('System event')
    expect(jobKindLabel({ payloadKind: 'agent_turn' })).toBe('Agent task')
    expect(jobKindLabel({})).toBe('Agent task')
  })
  it('maps reminder→is-reminder, else is-agent', () => {
    expect(jobKindClass({ payloadKind: 'reminder' })).toBe('is-reminder')
    expect(jobKindClass({ payloadKind: 'system_event' })).toBe('is-agent')
    expect(jobKindClass({})).toBe('is-agent')
  })
})

describe('jobTarget / jobSchedule', () => {
  it('resolves target (camel|snake|—)', () => {
    expect(jobTarget({ sessionTarget: 'isolated' })).toBe('isolated')
    expect(jobTarget({ session_target: 'main' })).toBe('main')
    expect(jobTarget({})).toBe('—')
  })
  it('resolves schedule (expression|schedule|—)', () => {
    expect(jobSchedule({ expression: '0 9 * * *' })).toBe('0 9 * * *')
    expect(jobSchedule({ schedule: '@daily' })).toBe('@daily')
    expect(jobSchedule({})).toBe('—')
  })
})

describe('isUpcomingRun', () => {
  it('is true only for enabled, non-running jobs with a future next_run', () => {
    const future = new Date(NOW + 60_000).toISOString()
    expect(isUpcomingRun({ enabled: true, next_run: future }, NOW)).toBe(true)
  })
  it('is false when disabled, running, missing, or in the past', () => {
    const future = new Date(NOW + 60_000).toISOString()
    const past = new Date(NOW - 60_000).toISOString()
    expect(isUpcomingRun({ enabled: false, next_run: future }, NOW)).toBe(false)
    expect(isUpcomingRun({ enabled: true, status: 'running', next_run: future }, NOW)).toBe(false)
    expect(isUpcomingRun({ enabled: true }, NOW)).toBe(false)
    expect(isUpcomingRun({ enabled: true, next_run: past }, NOW)).toBe(false)
    expect(isUpcomingRun({ enabled: true, next_run: 'not-a-date' }, NOW)).toBe(false)
  })
})

describe('jobDotState', () => {
  it('off when disabled', () => {
    expect(jobDotState({ enabled: false })).toBe('off')
  })
  it('error on a failed last run', () => {
    expect(jobDotState({ enabled: true, last_status: 'error' })).toBe('error')
    expect(jobDotState({ enabled: true, last_status: 'fail' })).toBe('error')
  })
  it('on otherwise (incl. inferred ok from last_run)', () => {
    expect(jobDotState({ enabled: true, last_status: 'ok' })).toBe('on')
    expect(jobDotState({ enabled: true, last_run: 123 })).toBe('on')
    expect(jobDotState({ enabled: true })).toBe('on')
  })
})

describe('isOkStatus', () => {
  it('true only for ok/success', () => {
    expect(isOkStatus('ok')).toBe(true)
    expect(isOkStatus('success')).toBe(true)
    expect(isOkStatus('error')).toBe(false)
    expect(isOkStatus(null)).toBe(false)
  })
})

describe('nextRunText', () => {
  it('— when disabled / absent / invalid', () => {
    expect(nextRunText({ enabled: false }, NOW)).toBe('—')
    expect(nextRunText({ enabled: true }, NOW)).toBe('—')
    expect(nextRunText({ enabled: true, next_run: 'bad' }, NOW)).toBe('—')
  })
  it('running while running', () => {
    expect(nextRunText({ enabled: true, status: 'running', next_run: 1 }, NOW)).toBe('running')
  })
  it('awaiting update when the timestamp is already in the past', () => {
    const past = new Date(NOW - 1000).toISOString()
    expect(nextRunText({ enabled: true, next_run: past }, NOW)).toBe('awaiting update')
  })
  it('a countdown when the timestamp is in the future', () => {
    const future = new Date(NOW + 5 * 60_000).toISOString()
    expect(nextRunText({ enabled: true, next_run: future }, NOW)).toBe('in 5m 0s')
  })
})

describe('nextRunAbs', () => {
  it("'' when disabled / running / absent / past", () => {
    expect(nextRunAbs({ enabled: false }, NOW)).toBe('')
    expect(nextRunAbs({ enabled: true, status: 'running', next_run: 1 }, NOW)).toBe('')
    expect(nextRunAbs({ enabled: true }, NOW)).toBe('')
    expect(nextRunAbs({ enabled: true, next_run: new Date(NOW - 1000).toISOString() }, NOW)).toBe(
      '',
    )
  })
  it('a friendly time for a future run', () => {
    const future = new Date(NOW + 5 * 60_000).toISOString()
    expect(nextRunAbs({ enabled: true, next_run: future }, NOW)).toMatch(/today/)
  })
})

describe('sortJobs', () => {
  const jobs: RawJob[] = [
    { name: 'beta', next_run: new Date(NOW + 3000).toISOString() },
    { name: 'alpha', next_run: new Date(NOW + 1000).toISOString() },
    { name: 'gamma' }, // missing next_run
  ]
  it('sorts by string column asc/desc without mutating', () => {
    const asc = sortJobs(jobs, 'name', true)
    expect(asc.map((j) => j.name)).toEqual(['alpha', 'beta', 'gamma'])
    const desc = sortJobs(jobs, 'name', false)
    expect(desc.map((j) => j.name)).toEqual(['gamma', 'beta', 'alpha'])
    // original untouched
    expect(jobs.map((j) => j.name)).toEqual(['beta', 'alpha', 'gamma'])
  })
  it('sorts date columns numerically, pushing missing timestamps to the end', () => {
    const asc = sortJobs(jobs, 'next_run', true)
    expect(asc.map((j) => j.name)).toEqual(['alpha', 'beta', 'gamma'])
    // desc: missing goes to -Infinity → last
    const desc = sortJobs(jobs, 'next_run', false)
    expect(desc[desc.length - 1]!.name).toBe('gamma')
    expect(desc[0]!.name).toBe('beta')
  })
})

describe('filterJobs', () => {
  const jobs: RawJob[] = [
    { name: 'Daily standup', message: 'time for standup', expression: '0 9 * * 1-5' },
    {
      name: 'Health check',
      prompt: 'run health',
      payloadKind: 'agent_turn',
      sessionTarget: 'isolated',
    },
  ]
  it('returns a copy on empty query', () => {
    const out = filterJobs(jobs, '')
    expect(out).toHaveLength(2)
    expect(out).not.toBe(jobs)
  })
  it('matches name / message / prompt / kind / target / expression (case-insensitive)', () => {
    expect(filterJobs(jobs, 'STANDUP').map((j) => j.name)).toEqual(['Daily standup'])
    expect(filterJobs(jobs, 'run health').map((j) => j.name)).toEqual(['Health check'])
    expect(filterJobs(jobs, 'agent_turn').map((j) => j.name)).toEqual(['Health check'])
    expect(filterJobs(jobs, 'isolated').map((j) => j.name)).toEqual(['Health check'])
    expect(filterJobs(jobs, '1-5').map((j) => j.name)).toEqual(['Daily standup'])
    expect(filterJobs(jobs, 'zzz')).toHaveLength(0)
  })
})

describe('runRow', () => {
  const rel = (ts: string | number) => `rel:${ts}`
  it('renders an object deliveryStatus as ch/ws', () => {
    const row = runRow(
      {
        started_at: 100,
        status: 'ok',
        duration_ms: 42,
        summary: 'done',
        sessionKey: 'k',
        deliveryStatus: { channel: 'slack', ws: 'sent' },
      },
      rel,
    )
    expect(row).toEqual({
      timeLabel: 'rel:100',
      status: 'ok',
      statusOk: true,
      duration: '42ms',
      delivery: 'ch: slack, ws: sent',
      reply: 'done',
      sessionKey: 'k',
    })
  })
  it('falls back for a string / absent deliveryStatus and missing fields', () => {
    expect(runRow({ delivery_status: 'queued', status: 'error' }, rel)).toMatchObject({
      delivery: 'queued',
      statusOk: false,
      duration: '—',
      reply: '—',
      timeLabel: '—',
      sessionKey: '',
    })
    expect(runRow({}, rel)).toMatchObject({ status: 'unknown', delivery: '—' })
  })
})

describe('formatDuration', () => {
  it('formats s / m+s / h+m / d+h', () => {
    expect(formatDuration(5_000)).toBe('5s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(3_660_000)).toBe('1h 1m')
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })
})

describe('humanCountdown / humanCountdownPast', () => {
  it('signs the countdown', () => {
    expect(humanCountdown(new Date(NOW + 5 * 60_000), NOW)).toBe('in 5m 0s')
    expect(humanCountdown(new Date(NOW), NOW)).toBe('now')
    expect(humanCountdown(new Date(NOW - 5 * 60_000), NOW)).toBe('5m 0s ago')
  })
  it('past-facing formatter', () => {
    expect(humanCountdownPast(new Date(NOW), NOW)).toBe('just now')
    expect(humanCountdownPast(new Date(NOW - 5 * 60_000), NOW)).toBe('5m 0s ago')
    expect(humanCountdownPast(new Date(NOW + 5 * 60_000), NOW)).toBe('in 5m 0s')
  })
})

describe('humanTime', () => {
  it('labels today / tomorrow / a dated weekday', () => {
    expect(humanTime(new Date(NOW + 3 * 3600_000), NOW)).toMatch(/^today /)
    expect(humanTime(new Date(NOW + 26 * 3600_000), NOW)).toMatch(/^tomorrow /)
    expect(humanTime(new Date(NOW + 5 * 86400_000), NOW)).not.toMatch(/^(today|tomorrow) /)
  })
})

describe('parseField', () => {
  it('handles wildcard, list, range, step, and names', () => {
    expect(parseField('*', 0, 59).all).toBe(true)
    expect([...parseField('1,3,5', 0, 59).set!]).toEqual([1, 3, 5])
    expect([...parseField('1-3', 0, 59).set!]).toEqual([1, 2, 3])
    expect([...parseField('*/15', 0, 59).set!]).toEqual([0, 15, 30, 45])
    expect([
      ...parseField('mon-fri', 0, 6, { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 })
        .set!,
    ]).toEqual([1, 2, 3, 4, 5])
  })
})

describe('parseCron', () => {
  it('returns null for non-5-field or garbage input', () => {
    expect(parseCron('')).toBeNull()
    expect(parseCron('0 9 * *')).toBeNull()
    expect(parseCron('0 9 * * * *')).toBeNull()
  })
  it('parses a 5-field expression; Sunday via 0 lands in the dow set', () => {
    const p = parseCron('0 9 * * 0')
    expect(p).not.toBeNull()
    expect(p!.dow.set!.has(0)).toBe(true)
  })
  it('mirrors the legacy out-of-range guard: a bare 7 (>max 6) yields an empty dow set', () => {
    // cron.js:1274 returns early when the token exceeds max, so `7` is never
    // added — the 7→0 fold at cron.js:1304 is legacy dead code we keep for
    // 1:1 fidelity but which never fires for a plain `7`.
    const p = parseCron('0 9 * * 7')
    expect(p).not.toBeNull()
    expect(p!.dow.all).toBe(false)
    expect(p!.dow.set!.size).toBe(0)
  })
})

describe('nextRuns', () => {
  it('returns the next N fire times from a fixed start', () => {
    // "every day at 09:00" — from NOW (09:00Z) the next fires are on subsequent
    // days. Assert count + strictly increasing + all in the future.
    const p = parseCron('0 9 * * *')
    const runs = nextRuns(p, 3, NOW)
    expect(runs).toHaveLength(3)
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.getTime()).toBeGreaterThan(runs[i - 1]!.getTime())
    }
    expect(runs[0]!.getTime()).toBeGreaterThan(NOW)
  })
  it('returns [] for an unparseable expression', () => {
    expect(nextRuns(parseCron('nope'), 3, NOW)).toEqual([])
  })
})

describe('explainCron', () => {
  it('describes common patterns', () => {
    expect(explainCron('* * * * *')).toBe('Every minute')
    expect(explainCron('30 * * * *')).toBe('Every hour at :30')
    expect(explainCron('0 9 * * *')).toBe('Every day at 09:00')
    expect(explainCron('0 9 * * 1-5')).toBe('Weekdays at 09:00')
    expect(explainCron('0 0 * * 0,6')).toBe('Weekends at 00:00')
    expect(explainCron('*/15 * * * *')).toBe('Every 15 minutes')
    expect(explainCron('0 0 1 * *')).toBe('Day 1 of every month at 00:00')
  })
  it('returns "" for an unparseable expression', () => {
    expect(explainCron('nope')).toBe('')
  })
  it('falls back to an at-minute/hour phrasing for uncommon cadences', () => {
    expect(explainCron('5 8,20 * * *')).toContain('at minute')
  })
})
