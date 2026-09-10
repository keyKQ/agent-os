// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { GatewaySettings } from '@shared/settings'
import { GatewaySupervisor } from './supervisor'

const external: GatewaySettings = {
  mode: 'external',
  host: '127.0.0.1',
  port: 18791,
  token: null,
  cliPath: null,
}

describe('GatewaySupervisor (external mode)', () => {
  it('reports running once the endpoint answers /health', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const sup = new GatewaySupervisor(() => external, { probe })
    const seen: string[] = []
    sup.subscribe((s) => seen.push(s.state))
    const status = await sup.start()
    expect(status).toMatchObject({ state: 'running', url: 'http://127.0.0.1:18791', pid: null })
    expect(seen).toEqual(['starting', 'running'])
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:18791')
  })

  it('reports an error when nothing answers', async () => {
    vi.useFakeTimers()
    const sup = new GatewaySupervisor(() => external, { probe: async () => false })
    const pending = sup.start()
    await vi.advanceTimersByTimeAsync(6_000)
    const status = await pending
    vi.useRealTimers()
    expect(status.state).toBe('error')
    expect(status.error).toContain('No gateway answering')
  })

  it('stop() never spawns and resets to stopped', async () => {
    const sup = new GatewaySupervisor(() => external, { probe: async () => true })
    await sup.start()
    expect((await sup.stop()).state).toBe('stopped')
  })
})

describe('GatewaySupervisor (managed mode)', () => {
  it('adopts a gateway that is already up instead of spawning', async () => {
    const managed: GatewaySettings = { ...external, mode: 'managed' }
    const sup = new GatewaySupervisor(() => managed, { probe: async () => true })
    const status = await sup.start()
    expect(status).toMatchObject({ state: 'running', pid: null })
  })

  it('errors out when the CLI cannot be found', async () => {
    const managed: GatewaySettings = { ...external, mode: 'managed' }
    const sup = new GatewaySupervisor(() => managed, {
      probe: async () => false,
      locate: () => null,
    })
    const status = await sup.start()
    expect(status.state).toBe('error')
    expect(status.error).toContain('agentos CLI not found')
  })
})
