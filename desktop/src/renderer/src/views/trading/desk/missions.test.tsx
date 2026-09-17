import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnection } from '@/stores/connection'
import { MISSION_COMPLETE_MARKER } from './desk-logic'
import { useMissions } from './missions'

const rpcCall = vi.fn()
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const SESSION = 'agent:main:desk'

function job(extra: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    name: 'DCA',
    enabled: true,
    targetSessionKey: SESSION,
    last_run: '2026-09-17T10:00:00Z',
    run_count: 3,
    message: 'do the thing',
    ...extra,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function methods(): string[] {
  return rpcCall.mock.calls.map(([m]) => String(m))
}

function updates(): unknown[] {
  return rpcCall.mock.calls.filter(([m]) => m === 'cron.update').map(([, p]) => p)
}

/** Waits for the list query to land, then lets the reconciliation it kicks off settle. */
async function settle() {
  await waitFor(() => expect(methods()).toContain('cron.list'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('mission completion is reconciled, not only observed live', () => {
  beforeEach(() => {
    useConnection.getState().setState('connected')
    rpcCall.mockReset()
  })

  it('stops a mission that reported completion while the window was closed', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'cron.list') return [job()]
      if (method === 'cron.runs') {
        return [{ id: 'r9', summary: `bought 25 USDC\n${MISSION_COMPLETE_MARKER}` }]
      }
      return {}
    })
    renderHook(() => useMissions(SESSION), { wrapper })
    await settle()
    expect(updates()).toContainEqual({ id: 'j1', enabled: false })
  })

  it('reads the full output when the preview truncated the marker away', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'cron.list') return [job()]
      // The marker is the last thing the agent says, and cron.runs caps the
      // summary at its first 500 characters — so the preview can hide it.
      if (method === 'cron.runs') {
        return [{ id: 'r9', summary: 'a very long report', summaryTruncated: true }]
      }
      if (method === 'cron.runOutput') {
        return { output: `a very long report …\n${MISSION_COMPLETE_MARKER}` }
      }
      return {}
    })
    renderHook(() => useMissions(SESSION), { wrapper })
    await settle()
    expect(methods()).toContain('cron.runOutput')
    expect(updates()).toContainEqual({ id: 'j1', enabled: false })
  })

  it('leaves an unfinished mission alone and does not fetch the full output', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'cron.list') return [job()]
      if (method === 'cron.runs') return [{ id: 'r9', summary: 'nothing to do this run' }]
      return {}
    })
    renderHook(() => useMissions(SESSION), { wrapper })
    await settle()
    expect(methods()).toContain('cron.runs')
    expect(methods()).not.toContain('cron.runOutput')
    expect(updates()).toHaveLength(0)
  })

  it('does not check a mission that has never run or is already stopped', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'cron.list') {
        return [job({ id: 'fresh', last_run: null }), job({ id: 'off', enabled: false })]
      }
      return {}
    })
    renderHook(() => useMissions(SESSION), { wrapper })
    await settle()
    expect(methods()).not.toContain('cron.runs')
  })

  it('checks a job once per run, not once per render', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'cron.list') return [job()]
      if (method === 'cron.runs') return [{ id: 'r9', summary: 'nothing to do' }]
      return {}
    })
    const { rerender } = renderHook(() => useMissions(SESSION), { wrapper })
    await settle()
    rerender()
    await settle()
    expect(methods().filter((m) => m === 'cron.runs')).toHaveLength(1)
  })
})
