import { describe, expect, it } from 'vitest'
import { t } from '~/i18n'
import { WALLET } from '../test-utils'
import { composeMissionPrompt, validateMission } from './desk-logic'
import { formFromPreset, MISSION_PRESETS, presetById, presetDefaults } from './presets'

const CTX = { primary: WALLET.address }

function form(id: string, params: Record<string, string> = {}) {
  const preset = presetById(id)
  if (!preset) throw new Error(`no preset ${id}`)
  return formFromPreset(preset, { ...presetDefaults(preset), ...params }, CTX)
}

describe('mission presets', () => {
  it('has unique ids and copy for every label it points at', () => {
    const ids = MISSION_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of MISSION_PRESETS) {
      expect(t(preset.name)).toBeTruthy()
      expect(t(preset.hint)).toBeTruthy()
      if (preset.caveat) expect(t(preset.caveat)).toBeTruthy()
      for (const knob of preset.knobs) {
        expect(t(knob.label)).toBeTruthy()
        for (const option of knob.options ?? []) expect(t(option.label)).toBeTruthy()
      }
    }
  })

  it('starts every preset as a contract the validator accepts', () => {
    for (const preset of MISSION_PRESETS) {
      const built = formFromPreset(preset, presetDefaults(preset), CTX)
      expect(validateMission(built)).toEqual({ ok: true })
      expect(built.name.trim()).toBeTruthy()
      expect(built.goal.trim()).toBeTruthy()
    }
  })

  // The watch group is the safe way in; a preset that quietly traded would
  // make that promise worthless.
  it('keeps the watch-only presets away from money', () => {
    const watch = MISSION_PRESETS.filter((p) => p.group === 'watch')
    expect(watch.length).toBeGreaterThan(0)
    for (const preset of watch) {
      expect(preset.readOnly).toBe(true)
      const built = formFromPreset(preset, presetDefaults(preset), CTX)
      expect(built.budgetTotalUsd).toBe('')
      expect(built.budgetPerOrderUsd).toBe('')
      // Dry run is "quote but do not swap"; with no swap there is nothing to hold back.
      expect(built.dryRun).toBe(false)
      expect(built.goal.toLowerCase()).toMatch(/never swap|never approve|do not swap/)
    }
    // And every trading preset does arrive with the first run held back.
    for (const preset of MISSION_PRESETS.filter((p) => !p.readOnly)) {
      expect(formFromPreset(preset, presetDefaults(preset), CTX).dryRun).toBe(true)
    }
  })

  it('writes the knobs into both the name and the goal', () => {
    const dca = form('dca', { token: 'WBTC', usd: '40' })
    expect(dca.name).toBe('DCA WBTC')
    expect(dca.goal).toContain('40 USD of WBTC')

    const alert = form('price-alert', { token: 'ETH', direction: 'above', price: '4000' })
    expect(alert.goal).toContain('at or above')
    expect(alert.goal).toContain('4000 USD')

    const rebalance = form('rebalance', { targetPct: '60' })
    expect(rebalance.goal).toContain('60% ETH / 40% USDC')
  })

  it('falls back rather than writing a zero into the prompt', () => {
    // An emptied field must never become "buy 0 USD of ": the prompt is the
    // contract, and a nonsense number in it is a nonsense instruction.
    const emptied = form('dca', { usd: '', token: '' })
    expect(emptied.goal).toContain('10 USD of ETH')
    const junk = form('dca', { usd: 'abc' })
    expect(junk.goal).toContain('10 USD of ETH')
    const negative = form('dip', { price: '-5' })
    expect(negative.goal).toContain('2300 USD')
  })

  it('points the stock preset at Robinhood Chain and resolves the ticker first', () => {
    const stock = form('dca-stock', { ticker: 'tsla' })
    expect(stock.chains).toEqual([4663])
    expect(stock.name).toBe('DCA TSLA')
    expect(stock.goal).toContain('--chain robinhood TSLA')
  })

  it('composes a prompt the agent can act on, with no budget line when there is no budget', () => {
    const report = composeMissionPrompt(form('portfolio-report'), {
      wallets: [WALLET],
      limits: { thresholdUsd: 100, dailyCapUsd: 1000 },
    })
    expect(report).toContain('[Trading desk mission] Portfolio report')
    expect(report).not.toContain('Budget:')
    // The engine's real limits are still named, even to a mission that never trades.
    expect(report).toContain('Engine limits')

    const dca = composeMissionPrompt(form('dca'), { wallets: [WALLET], limits: null })
    expect(dca).toContain('Budget: at most $300.00 in total')
    expect(dca).toContain('every 1 day')
  })
})
