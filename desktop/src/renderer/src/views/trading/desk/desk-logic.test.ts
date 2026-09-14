import { describe, expect, it } from 'vitest'
import { order, WALLET } from '../test-utils'
import {
  approvalFacts,
  bookConcession,
  composeMissionPrompt,
  composerPlaceholder,
  formatExpiryWhole,
  isDryRunText,
  isSessionMission,
  MISSION_COMPLETE_MARKER,
  missionCronPayload,
  missionFromJob,
  missionPrefill,
  missionStatus,
  ordersForSession,
  PLACEHOLDERS,
  rejectionMessage,
  riskStamp,
  statusWord,
  validateMission,
  withoutDryRun,
} from './desk-logic'

describe('statusWord', () => {
  it('ranks awaiting over live over running over idle', () => {
    expect(statusWord({ pendingApprovals: 1, streaming: true, missionRunning: true })).toBe(
      'awaiting',
    )
    expect(statusWord({ pendingApprovals: 0, streaming: true, missionRunning: true })).toBe('live')
    expect(statusWord({ pendingApprovals: 0, streaming: false, missionRunning: true })).toBe(
      'running',
    )
    expect(statusWord({ pendingApprovals: 0, streaming: false, missionRunning: false })).toBe(
      'idle',
    )
  })
})

describe('riskStamp', () => {
  it('is high from 500 USD or 3% impact', () => {
    expect(riskStamp({ valueUsd: 499, priceImpactPct: 0.5 })).toBe('normal')
    expect(riskStamp({ valueUsd: 500, priceImpactPct: 0.5 })).toBe('high')
    expect(riskStamp({ valueUsd: 10, priceImpactPct: 3 })).toBe('high')
    expect(riskStamp({ valueUsd: null, priceImpactPct: null })).toBe('normal')
  })
})

describe('approvalFacts', () => {
  const labels = { wallet: 'Wallet', pay: 'Pay', expires: 'Expires', gas: 'Gas' }
  it('binds the order values and omits what is absent', () => {
    const facts = approvalFacts(
      order({ gasUsd: null, priceImpactPct: null, expiresAt: null }),
      [WALLET],
      labels,
    )
    const keys = facts.map((f) => f.key)
    expect(keys).toContain('wallet')
    expect(keys).toContain('pay')
    expect(keys).not.toContain('gas')
    expect(keys).not.toContain('impact')
    expect(keys).not.toContain('expires')
    expect(facts.find((f) => f.key === 'wallet')?.value).toBe('Main · 0x1111…1111')
    expect(facts.find((f) => f.key === 'pay')?.value).toBe('0.2 ETH')
    expect(facts.find((f) => f.key === 'wallet')?.label).toBe('Wallet')
  })
  it('prints the expiry whole with a UTC offset, never a countdown', () => {
    const facts = approvalFacts(order({ expiresAt: Date.UTC(2026, 8, 13, 9, 30) }), [], labels)
    const expires = facts.find((f) => f.key === 'expires')?.value ?? ''
    expect(expires).toMatch(/\(UTC[+−]\d/)
    expect(expires).not.toMatch(/in \d/)
    expect(formatExpiryWhole(Date.UTC(2026, 0, 1), 'en-US')).toMatch(/2026/)
  })
  it('tones a heavy price impact', () => {
    const facts = approvalFacts(order({ priceImpactPct: 4 }), [], labels)
    expect(facts.find((f) => f.key === 'impact')?.tone).toBe('danger')
  })
})

describe('ordersForSession / rejectionMessage', () => {
  it('keeps only this chat’s orders', () => {
    const mine = order({ orderId: 'a', sessionKey: 's1' })
    const other = order({ orderId: 'b', sessionKey: 's2' })
    expect(ordersForSession([mine, other], 's1')).toEqual([mine])
  })
  it('writes the reason the agent reads', () => {
    expect(rejectionMessage({ orderId: 'o9' }, ' too much slippage ')).toBe(
      'Rejected order o9: too much slippage',
    )
    expect(rejectionMessage({ orderId: 'o9' }, '')).toContain('Do not retry')
  })
})

describe('missions', () => {
  it('prefills the four chips and validates the contract', () => {
    const dca = missionPrefill('dca', { primary: WALLET.address })
    expect(dca.interval).toEqual({ kind: 'every', seconds: 86_400 })
    expect(dca.wallets).toEqual([WALLET.address])
    expect(validateMission(dca).ok).toBe(true)
    expect(validateMission({ ...dca, name: '' })).toEqual({ ok: false, error: 'name' })
    expect(validateMission({ ...dca, goal: '  ' })).toEqual({ ok: false, error: 'goal' })
    expect(validateMission({ ...dca, budgetTotalUsd: '-1' })).toEqual({
      ok: false,
      error: 'budget',
    })
    expect(validateMission({ ...dca, interval: { kind: 'every', seconds: 30 } })).toEqual({
      ok: false,
      error: 'interval',
    })
    expect(validateMission({ ...dca, stop: { kind: 'runs', runs: 0 } })).toEqual({
      ok: false,
      error: 'stop',
    })
  })

  it('composes a deterministic prompt with budget, cadence, stop and dry run', () => {
    const form = missionPrefill('dip', { primary: WALLET.address })
    const prompt = composeMissionPrompt(form, {
      wallets: [WALLET],
      limits: { thresholdUsd: 100, dailyCapUsd: 1000 },
    })
    expect(prompt.split('\n')[0]).toBe('[Trading desk mission] Buy the dip')
    expect(prompt).toContain('Wallets: Main · 0x1111…1111 · Chains: Base')
    expect(prompt).toContain('at most $100.00 in total')
    expect(prompt).toContain('at most $25.00 per order')
    expect(prompt).toContain('orders above $100.00 wait for approval')
    expect(prompt).toContain('every 5 min')
    expect(prompt).toContain(MISSION_COMPLETE_MARKER)
    expect(isDryRunText(prompt)).toBe(true)
    const stripped = withoutDryRun(prompt)
    expect(isDryRunText(stripped)).toBe(false)
    expect(stripped).toContain('Goal:')
    expect(
      composeMissionPrompt(form, {
        wallets: [WALLET],
        limits: { thresholdUsd: 100, dailyCapUsd: 1000 },
      }),
    ).toBe(prompt)
  })

  it('builds the cron.add payload that posts into this chat', () => {
    const form = missionPrefill('dca', { primary: WALLET.address })
    form.name = 'DCA ETH'
    const payload = missionCronPayload(
      form,
      'PROMPT',
      'agent:trading:webchat:trading-x',
      'Asia/Tokyo',
    )
    expect(payload).toMatchObject({
      name: 'DCA ETH',
      enabled: true,
      payloadKind: 'agent_turn',
      agentId: 'trading',
      sessionTarget: 'current',
      targetSessionKey: 'agent:trading:webchat:trading-x',
      text: 'PROMPT',
      schedule: { kind: 'every', every_seconds: 86_400 },
      tz: 'Asia/Tokyo',
    })
    form.interval = { kind: 'cron', expr: '0 9 * * *' }
    expect(missionCronPayload(form, 'P', 's').schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' })
  })

  it('matches jobs to the session by any of the target keys', () => {
    expect(isSessionMission({ targetSessionKey: 's' }, 's')).toBe(true)
    expect(isSessionMission({ target_session_key: 's' }, 's')).toBe(true)
    expect(isSessionMission({ sessionKey: 'other' }, 's')).toBe(false)
    expect(isSessionMission({ targetSessionKey: 's' }, '')).toBe(false)
  })

  it('reads a mission state from the job and the live signals', () => {
    const next = new Date(Date.now() + 600_000).toISOString()
    expect(
      missionStatus({ enabled: true, next_run: next }, { running: true, pendingApprovals: 0 })
        .state,
    ).toBe('running')
    expect(
      missionStatus({ enabled: true, next_run: next }, { running: false, pendingApprovals: 2 })
        .state,
    ).toBe('awaiting')
    const sleeping = missionStatus(
      { enabled: true, next_run: next },
      { running: false, pendingApprovals: 0 },
    )
    expect(sleeping.state).toBe('sleeping')
    expect(sleeping.until).toBeGreaterThan(Date.now())
    expect(missionStatus({ enabled: false }, { running: false, pendingApprovals: 0 }).state).toBe(
      'paused',
    )
    expect(
      missionStatus(
        { enabled: true, next_run: next, last_status: 'error' },
        { running: false, pendingApprovals: 0 },
      ).state,
    ).toBe('failed')
    expect(
      missionStatus({ enabled: true, next_run: null }, { running: false, pendingApprovals: 0 })
        .state,
    ).toBe('done')
  })

  it('edits a job back into a form', () => {
    const form = missionFromJob(
      {
        name: 'DCA ETH',
        message:
          '[Trading desk mission] DCA ETH\nGoal: Buy 10 USD of ETH.\nDry run: this run, only quote and report. Do not swap.',
        scheduleKind: 'every',
        scheduleRaw: 3600,
      },
      WALLET.address,
    )
    expect(form.name).toBe('DCA ETH')
    expect(form.goal).toBe('Buy 10 USD of ETH.')
    expect(form.dryRun).toBe(true)
    expect(form.interval).toEqual({ kind: 'every', seconds: 3600 })
  })
})

describe('bookConcession', () => {
  it('keeps the preference while the chat has its floor, then shrinks, then collapses', () => {
    expect(bookConcession(1200, 360, true)).toEqual({ book: 360, collapsed: false })
    expect(bookConcession(900, 360, true)).toEqual({ book: 300, collapsed: false })
    expect(bookConcession(850, 360, true)).toEqual({ book: 48, collapsed: true })
    expect(bookConcession(1200, 360, false)).toEqual({ book: 48, collapsed: true })
    expect(bookConcession(1600, 999, true)).toEqual({ book: 520, collapsed: false })
  })
})

describe('composerPlaceholder', () => {
  it('prefers steering copy while busy, then the mission word, then rotates real orders', () => {
    expect(
      composerPlaceholder({
        missionWord: 'DCA · Sleeping',
        busy: true,
        tick: 0,
        steering: 'steer',
      }),
    ).toBe('steer')
    expect(
      composerPlaceholder({
        missionWord: 'DCA · Sleeping',
        busy: false,
        tick: 0,
        steering: 'steer',
      }),
    ).toBe('DCA · Sleeping')
    expect(
      composerPlaceholder({ missionWord: null, busy: false, tick: 0, steering: 'steer' }),
    ).toBe(PLACEHOLDERS[0])
    expect(
      composerPlaceholder({
        missionWord: null,
        busy: false,
        tick: PLACEHOLDERS.length + 1,
        steering: 'steer',
      }),
    ).toBe(PLACEHOLDERS[1])
  })
})
