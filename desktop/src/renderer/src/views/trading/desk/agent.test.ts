import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureTradingSessionKey,
  readTradingSessionKey,
  writeTradingSessionKey,
} from '~/stores/trading-ui'
import {
  type AgentRpc,
  isTradingAgentKey,
  syncTradingAgent,
  TRADING_AGENT_ID,
  TRADING_AGENT_VERSION,
  tradingAgentFiles,
  tradingAgentSpec,
} from './agent'
import { mintTradingSessionKey } from './mode-logic'

describe('trading agent spec', () => {
  it('narrows to a named profile plus an allowlist, never an allowlist alone', () => {
    const spec = tradingAgentSpec()
    expect(spec.id).toBe(TRADING_AGENT_ID)
    expect(spec.tools.profile).toBe('minimal')
    expect(spec.tools.allow).toContain('exec_command')
    expect(spec.tools.allow).toContain('ask_user')
  })
  it('keeps the desk away from editing, code and messaging tools', () => {
    const allow: readonly string[] = tradingAgentSpec().tools.allow
    for (const tool of [
      'write_file',
      'edit_file',
      'apply_patch',
      'execute_code',
      'git_commit',
      'message',
      'cron',
      'sessions_spawn',
    ]) {
      expect(allow).not.toContain(tool)
    }
  })
  it('owns the persona files and stamps each with the spec version', () => {
    const files = tradingAgentFiles()
    expect(Object.keys(files).sort()).toEqual(
      ['AGENTS.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md'].sort(),
    )
    for (const content of Object.values(files)) {
      expect(content).toContain(`trading agent v${TRADING_AGENT_VERSION}`)
    }
    expect(files['AGENTS.md']).toContain('wallet-trading')
    expect(files['IDENTITY.md']).toContain('Name: Trading desk')
    // USER.md and MEMORY.md are the agent's own; the desktop never rewrites them.
    expect(files).not.toHaveProperty('USER.md')
    expect(files).not.toHaveProperty('MEMORY.md')
  })
  it('makes the primary the only wallet an order touches unless the user names another', () => {
    // A desk once answered "swap 50% ETH" by reading the second wallet's
    // balance too and holding on both; the rule now names one wallet.
    const files = tradingAgentFiles()
    expect(files['AGENTS.md']).toContain('## Which wallet')
    expect(files['AGENTS.md']).toMatch(/Never look up another wallet's balance/)
    expect(files['AGENTS.md']).toMatch(/a small balance does not/)
    expect(files['AGENTS.md']).toMatch(/Size is the user's call/)
    expect(files['SOUL.md']).toMatch(/The wallet is never ambiguous/)
    expect(files['TOOLS.md']).toMatch(/No `--wallet` means the\s+primary/)
    expect(files['TOOLS.md']).not.toMatch(/wallet balances \[ADDR\]/)
  })
})

describe('syncTradingAgent', () => {
  function rpcWith(agents: Array<{ id: string }>) {
    const calls: Array<[string, Record<string, unknown>]> = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'agents.list') return { agents }
      return {}
    })
    const rpc: AgentRpc = { call: call as AgentRpc['call'] }
    return { rpc, calls }
  }

  it('creates the agent when the registry lacks it, then writes its files', async () => {
    const { rpc, calls } = rpcWith([{ id: 'main' }])
    await syncTradingAgent(rpc)
    expect(calls.map(([m]) => m)).toEqual([
      'agents.list',
      'agents.create',
      ...Array(5).fill('agents.files.set'),
    ])
    expect(calls[1]?.[1]).toMatchObject({ id: 'trading', tools: { profile: 'minimal' } })
    expect(calls[2]?.[1]).toMatchObject({ agentId: 'trading', name: 'AGENTS.md' })
  })

  it('refreshes the policy of an existing agent instead of recreating it', async () => {
    const { rpc, calls } = rpcWith([{ id: 'main' }, { id: 'trading' }])
    await syncTradingAgent(rpc)
    expect(calls[1]?.[0]).toBe('agents.update')
    expect(calls[1]?.[1]).toMatchObject({ id: 'trading', enabled: true })
    expect(calls.some(([m]) => m === 'agents.create')).toBe(false)
  })
})

describe('desk session keys', () => {
  beforeEach(() => localStorage.clear())

  it('belong to the trading agent', () => {
    expect(isTradingAgentKey(mintTradingSessionKey())).toBe(true)
    expect(isTradingAgentKey('agent:main:webchat:trading-old')).toBe(false)
  })

  it('a key minted before the desk had its own agent reads as absent', () => {
    writeTradingSessionKey('agent:main:webchat:trading-old')
    expect(readTradingSessionKey()).toBe('')
    const fresh = ensureTradingSessionKey(mintTradingSessionKey)
    expect(isTradingAgentKey(fresh)).toBe(true)
    expect(readTradingSessionKey()).toBe(fresh)
  })
})
