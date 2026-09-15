import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { order, renderDesk, WALLET } from '../test-utils'
import { useDeskFrame } from './TradingDesk'
import { useDeskInstruments } from './useDeskInstruments'
import type { DeskMode } from './mode-logic'

const rpcCall = vi.fn()
const rpcOn = vi.fn(() => () => {})
// One client for the whole test, as in the app: effects keyed on `rpc` must not re-run.
const rpc = { call: rpcCall, waitForConnection: async () => {}, on: rpcOn }
vi.mock('@/app/providers', () => ({ useRpc: () => rpc }))
vi.mock('~/lib/desktop-api', () => ({
  desktopApi: () => ({ app: { openExternal: vi.fn(async () => {}) } }),
  isDesktop: () => true,
}))
// The session filing is someone else's concern here.
vi.mock('./useTradingSession', () => ({
  useTradingSession: () => ({ sessionKey: 'sk', ensureFiled: vi.fn(), startFresh: vi.fn() }),
}))

const SESSION = 'agent:trading:webchat:trading-t1'
const sendText = vi.fn()

/** The same wiring SessionRoute → ChatView does: one frame, its desk into the instruments. */
function Harness({ active, mode = 'trading' }: { active: boolean; mode?: DeskMode }) {
  const frame = useDeskFrame({
    sessionKey: SESSION,
    mode,
    active,
    entering: false,
    onSwitchMode: () => {},
    onSessionPending: () => {},
  })
  const inst = useDeskInstruments(frame.desk, {
    sessionKey: SESSION,
    sendText,
    submitText: () => {},
    busy: false,
    composerValue: '',
    idle: true,
    hasMessages: false,
    focusOrderId: null,
    setFocusOrderId: () => {},
  })
  return (
    <div>
      {frame.strip}
      {frame.banner}
      {inst.region}
      {inst.dockAbove}
    </div>
  )
}

function answers(overrides: Record<string, unknown> = {}) {
  return async (method: string) => {
    if (method in overrides) {
      const v = overrides[method]
      return typeof v === 'function' ? (v as () => unknown)() : v
    }
    switch (method) {
      case 'trading.status':
        return {
          enabled: true,
          apiKeyConfigured: true,
          chains: [{ chainId: 8453 }],
          limits: { approvalThresholdUsd: 100, dailyCapUsd: 1000, approvalTtlSeconds: 900 },
          unlockMode: 'auto',
          unlocked: true,
          syncing: false,
          lastSyncAt: null,
          provider: 'uniswap',
          providers: [],
        }
      case 'wallet.status':
        return { initialized: true, unlocked: true, unlockMode: 'auto', walletCount: 1 }
      case 'wallet.list':
        return { wallets: [WALLET], primary: WALLET.address }
      case 'trading.orders.list':
        return { orders: [order({ sessionKey: SESSION })], pendingApprovals: 1 }
      case 'cron.list':
        return { jobs: [] }
      default:
        return {}
    }
  }
}

beforeEach(() => {
  rpcCall.mockReset()
  rpcOn.mockClear()
  sendText.mockClear()
  rpcCall.mockImplementation(answers())
})

describe('useDeskFrame', () => {
  it('listens to cron.run.finished once for the whole desk', async () => {
    renderDesk(<Harness active />)
    await screen.findByTestId('approval-card')
    const finished = rpcOn.mock.calls.filter((c) => (c as unknown[])[0] === 'cron.run.finished')
    expect(finished).toHaveLength(1)
  })

  it('runs no trading query and binds no listener in an ordinary chat', () => {
    renderDesk(<Harness active={false} mode="chat" />)
    expect(rpcCall).not.toHaveBeenCalled()
    expect(rpcOn).not.toHaveBeenCalled()
    expect(screen.getByTestId('mode-chat')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the pill in the derived mode while the desk is off', () => {
    renderDesk(<Harness active={false} mode="trading" />)
    expect(screen.getByTestId('mode-trading')).toHaveAttribute('aria-selected', 'true')
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('says the gateway did not answer, with a retry, instead of "create your vault"', async () => {
    let fail = true
    rpcCall.mockImplementation(
      answers({
        'wallet.status': () => {
          if (fail) throw new Error('boom')
          return { initialized: true, unlocked: true, unlockMode: 'auto', walletCount: 1 }
        },
      }),
    )
    renderDesk(<Harness active />)
    const retry = await screen.findByTestId('desk-retry')
    expect(screen.getByTestId('desk-gate')).toHaveTextContent('Waiting for the gateway')
    expect(screen.queryByTestId('vault-setup')).toBeNull()
    fail = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByTestId('desk-retry')).toBeNull())
  })
})

describe('useDeskInstruments · reject', () => {
  it('rejects once for a double Enter on the reason, and posts one chat message', async () => {
    let release: (() => void) | null = null
    rpcCall.mockImplementation(
      answers({
        'trading.orders.reject': () =>
          new Promise<unknown>((resolve) => {
            release = () => resolve({ order: order({ status: 'rejected' }) })
          }),
      }),
    )
    renderDesk(<Harness active />)
    await screen.findByTestId('approval-card')
    fireEvent.click(screen.getByTestId('card-reject'))
    const reason = screen.getByTestId('reject-reason')
    fireEvent.change(reason, { target: { value: 'not today' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    fireEvent.keyDown(reason, { key: 'Enter' })
    const rejects = () => rpcCall.mock.calls.filter((c) => c[0] === 'trading.orders.reject')
    await waitFor(() => expect(rejects()).toHaveLength(1))
    expect(rejects()[0]?.[1]).toEqual({ orderId: 'o1', reason: 'not today' })
    // Once the pending state has landed the card is locked too.
    await waitFor(() => expect(screen.getByTestId('card-reject')).toBeDisabled())
    fireEvent.keyDown(screen.getByTestId('reject-reason'), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('card-reject'))
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
    expect(String(sendText.mock.calls[0]?.[0])).toBe('Rejected order o1: not today')
    expect(rejects()).toHaveLength(1)
  })
})
