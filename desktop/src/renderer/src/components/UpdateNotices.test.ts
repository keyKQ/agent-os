import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseUpdate } from '@shared/updates'

const toastFn = Object.assign(vi.fn(), { success: vi.fn(), dismiss: vi.fn() })
vi.mock('sonner', () => ({ toast: toastFn }))

const { announceRelease } = await import('./UpdateNotices')

const none: ReleaseUpdate = { kind: 'none' }
const available: ReleaseUpdate = {
  kind: 'available',
  version: '2026.9.23',
  engine: true,
  app: true,
}
const engineOnly: ReleaseUpdate = {
  kind: 'available',
  version: '2026.9.23',
  engine: true,
  app: false,
}
const working: ReleaseUpdate = {
  kind: 'working',
  version: '2026.9.23',
  step: 'engine',
  percent: null,
}
const restart: ReleaseUpdate = { kind: 'restart', version: '2026.9.23', blocked: null }

const act = { update: vi.fn(), restart: vi.fn(), restartGateway: vi.fn() }
type Opts = { action: { onClick(): void }; description?: string; id: string }

beforeEach(() => {
  toastFn.mockClear()
  toastFn.success.mockClear()
  toastFn.dismiss.mockClear()
  act.update.mockClear()
  act.restart.mockClear()
  act.restartGateway.mockClear()
})

describe('announceRelease', () => {
  it('offers one Update for the release, once, and says when both sides move', () => {
    announceRelease(none, available, act)
    announceRelease(available, { ...available }, act)
    expect(toastFn).toHaveBeenCalledTimes(1)
    const [text, opts] = toastFn.mock.calls[0] as [string, Opts]
    expect(text).toContain('2026.9.23')
    expect(opts.id).toBe('agentos-release')
    expect(opts.description).toMatch(/engine updates in place/)
    opts.action.onClick()
    expect(act.update).toHaveBeenCalledTimes(1)

    announceRelease(none, engineOnly, act)
    expect((toastFn.mock.calls[1] as [string, Opts])[1].description).toBeNull()
  })

  it('goes quiet while working, then offers the restart with its block reason', () => {
    announceRelease(available, working, act)
    expect(toastFn.dismiss).toHaveBeenCalledWith('agentos-release')

    announceRelease(working, restart, act)
    expect(toastFn.success).toHaveBeenCalledTimes(1)
    // The card keeps its id across steps, so the last description is cleared explicitly.
    expect((toastFn.success.mock.calls[0] as [string, Opts])[1].description).toBeNull()
    ;(toastFn.success.mock.calls[0] as [string, Opts])[1].action.onClick()
    expect(act.restart).toHaveBeenCalledTimes(1)

    announceRelease(restart, { ...restart, blocked: 'engine-updating' }, act)
    expect(toastFn.success).toHaveBeenCalledTimes(2)
    expect((toastFn.success.mock.calls[1] as [string])[0]).toMatch(/engine is being updated/)
  })

  it('says an engine-only update finished, and offers the gateway restart after a terminal upgrade', () => {
    announceRelease(working, none, act)
    expect(toastFn.success).toHaveBeenCalledTimes(1)
    expect((toastFn.success.mock.calls[0] as [string])[0]).toMatch(/Engine updated to 2026.9.23/)

    const gw: ReleaseUpdate = {
      kind: 'gateway-restart',
      version: '2026.9.23',
      running: '2026.9.22',
    }
    announceRelease(none, gw, act)
    const [text, opts] = toastFn.mock.calls[0] as [string, Opts]
    expect(text).toBe('Engine 2026.9.23 is installed.')
    expect(opts.description).toBe('The gateway is still running 2026.9.22.')
    opts.action.onClick()
    expect(act.restartGateway).toHaveBeenCalledTimes(1)

    announceRelease(gw, none, act)
    expect(toastFn.dismiss).toHaveBeenCalledWith('agentos-release')
  })
})
