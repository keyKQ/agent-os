import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, isValidHost, normalizeSettings } from '@shared/settings'
import {
  diagnosticsReport,
  draftFromGateway,
  filterSections,
  formatUptime,
  gatewayDirty,
  gatewayDraftErrors,
  gatewayFromDraft,
  gatewayNeedsRestart,
  modelOptions,
  routerTiers,
} from './logic'

const GW = DEFAULT_SETTINGS.gateway

describe('gateway draft', () => {
  it('round-trips the saved settings', () => {
    expect(gatewayFromDraft(draftFromGateway(GW))).toEqual(GW)
    expect(gatewayDirty(GW, draftFromGateway(GW))).toBe(false)
  })

  it('treats an empty token or cli path as null', () => {
    const next = gatewayFromDraft({ ...draftFromGateway(GW), token: '  ', cliPath: '' })
    expect(next.token).toBeNull()
    expect(next.cliPath).toBeNull()
  })

  it('flags a bad host and a bad port', () => {
    expect(gatewayDraftErrors({ ...draftFromGateway(GW), host: 'http://x' })).toEqual({
      host: 'invalid',
    })
    expect(gatewayDraftErrors({ ...draftFromGateway(GW), port: '70000' })).toEqual({
      port: 'invalid',
    })
    expect(gatewayDraftErrors({ ...draftFromGateway(GW), port: '80a' })).toEqual({
      port: 'invalid',
    })
    expect(gatewayDraftErrors(draftFromGateway(GW))).toEqual({})
  })

  it('is dirty when anything meaningful changes', () => {
    expect(gatewayDirty(GW, { ...draftFromGateway(GW), port: '18792' })).toBe(true)
    expect(gatewayDirty(GW, { ...draftFromGateway(GW), mode: 'external' })).toBe(true)
    expect(gatewayDirty(GW, { ...draftFromGateway(GW), host: ' 127.0.0.1 ' })).toBe(false)
  })

  it('asks for a restart only when the running endpoint differs', () => {
    const running = {
      state: 'running' as const,
      pid: 1,
      url: 'http://127.0.0.1:18791',
      error: null,
    }
    expect(gatewayNeedsRestart(GW, running)).toBe(false)
    expect(gatewayNeedsRestart({ ...GW, port: 19000 }, running)).toBe(true)
    expect(gatewayNeedsRestart({ ...GW, port: 19000 }, { ...running, state: 'stopped' })).toBe(
      false,
    )
  })
})

describe('host validation', () => {
  it('accepts hostnames and IPs, rejects urls and ports', () => {
    expect(isValidHost('localhost')).toBe(true)
    expect(isValidHost('127.0.0.1')).toBe(true)
    expect(isValidHost('[::1]')).toBe(true)
    expect(isValidHost('gateway.local')).toBe(true)
    expect(isValidHost('http://localhost')).toBe(false)
    expect(isValidHost('localhost:18791')).toBe(false)
    expect(isValidHost('')).toBe(false)
  })

  it('normalizes new sections with defaults and drops junk', () => {
    const s = normalizeSettings({
      general: { openAtLogin: 'yes', launchView: 'last' },
      appearance: { textSize: 'huge', reduceTransparency: true },
      notifications: { sound: false },
    })
    expect(s.general).toEqual({ ...DEFAULT_SETTINGS.general, launchView: 'last' })
    expect(s.appearance).toEqual({ textSize: 'default', reduceTransparency: true })
    expect(s.notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, sound: false })
  })
})

describe('models', () => {
  const catalog = [
    { id: 'a/one', name: 'One', provider: 'p' },
    { id: 'a/two', name: 'a/two', provider: 'p' },
    { id: 'b/three', name: 'Three', provider: 'other' },
    { id: 'a/one', name: 'One again', provider: 'p' },
  ]

  it('lists only the active provider, once each, and keeps the current model', () => {
    const opts = modelOptions(catalog, 'p', 'a/two')
    expect(opts.map((o) => o.id)).toEqual(['a/one', 'a/two'])
    expect(opts[0]?.label).toBe('One  ·  a/one')
    expect(opts[1]?.label).toBe('a/two')
  })

  it('prepends an unknown current model as custom', () => {
    const opts = modelOptions(catalog, 'p', 'typed/by-hand')
    expect(opts[0]).toEqual({ id: 'typed/by-hand', label: 'typed/by-hand', custom: true })
  })

  it('reads router tiers from the config dict', () => {
    expect(
      routerTiers({ c1: { model: 'x', thinking: 'low' }, c2: { model: 'y' }, bad: 'nope' }),
    ).toEqual([
      { tier: 'c1', model: 'x' },
      { tier: 'c2', model: 'y' },
    ])
    expect(routerTiers(null)).toEqual([])
  })
})

describe('about + advanced', () => {
  it('formats uptime at the right granularity', () => {
    expect(formatUptime(40_000)).toBe('40s')
    expect(formatUptime(12 * 60_000)).toBe('12m')
    expect(formatUptime((2 * 3600 + 5 * 60) * 1000)).toBe('2h 05m')
    expect(formatUptime((3 * 86400 + 4 * 3600) * 1000)).toBe('3d 4h')
  })

  it('never includes the auth token in diagnostics', () => {
    const report = diagnosticsReport({
      info: null,
      gateway: { state: 'running', pid: 42, url: 'http://127.0.0.1:18791', error: null },
      settings: { ...DEFAULT_SETTINGS, gateway: { ...GW, token: 'sekrit-token' } },
      now: new Date(0),
    })
    expect(report).not.toContain('sekrit-token')
    expect(report).toContain('<redacted>')
    expect(report).toContain('pid 42')
  })

  it('filters sections by title or blurb', () => {
    const sections = [
      { id: 'general' as const, title: 'General', blurb: 'Launch and quit' },
      { id: 'about' as const, title: 'About', blurb: 'Versions' },
    ]
    expect(filterSections(sections, 'quit').map((s) => s.id)).toEqual(['general'])
    expect(filterSections(sections, 'ABOUT').map((s) => s.id)).toEqual(['about'])
    expect(filterSections(sections, '  ')).toHaveLength(2)
  })
})
