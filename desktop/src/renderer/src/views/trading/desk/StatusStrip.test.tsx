import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderDesk, WALLET } from '../test-utils'
import { ComposerSeats } from './ComposerSeats'
import { StatusStrip } from './StatusStrip'

const pill = { mode: 'trading' as const, onSwitchMode: vi.fn() }

describe('StatusStrip', () => {
  it('carries one status word and a pin only when something is waiting', () => {
    const onOpenApprovals = vi.fn()
    const { rerender } = renderDesk(
      <StatusStrip
        {...pill}
        missions={[]}
        running={new Set()}
        sessionPending={0}
        globalPending={null}
        streaming={false}
        deskMode={false}
        onToggleDesk={vi.fn()}
        onOpenApprovals={onOpenApprovals}
      />,
    )
    expect(screen.getByTestId('status-word')).toHaveTextContent('Idle')
    expect(screen.queryByTestId('strip-pin')).toBeNull()
    rerender(
      <StatusStrip
        {...pill}
        missions={[
          {
            id: 'j1',
            name: 'DCA ETH',
            enabled: true,
            next_run: new Date(Date.now() + 60_000).toISOString(),
          },
        ]}
        running={new Set(['j1'])}
        sessionPending={2}
        globalPending={3}
        streaming={true}
        deskMode={false}
        onToggleDesk={vi.fn()}
        onOpenApprovals={onOpenApprovals}
      />,
    )
    expect(screen.getByTestId('status-word')).toHaveTextContent('Awaiting')
    expect(screen.getByTestId('status-strip')).toHaveTextContent('DCA ETH')
    expect(screen.getByTestId('status-strip')).toHaveTextContent('Running')
    fireEvent.click(screen.getByTestId('strip-pin'))
    expect(onOpenApprovals).toHaveBeenCalled()
    expect(screen.getByTestId('strip-pin')).toHaveTextContent('3')
  })

  it('offers the desk toggle in both directions', () => {
    const onToggleDesk = vi.fn()
    renderDesk(
      <StatusStrip
        {...pill}
        missions={[]}
        running={new Set()}
        sessionPending={0}
        globalPending={0}
        streaming={false}
        deskMode={true}
        onToggleDesk={onToggleDesk}
        onOpenApprovals={vi.fn()}
      />,
    )
    const toggle = screen.getByTestId('desk-toggle')
    expect(toggle).toHaveTextContent('Chat')
    fireEvent.click(toggle)
    expect(onToggleDesk).toHaveBeenCalled()
  })

  it('is only the mode pill in Chat mode, and the pill switches modes', () => {
    const onSwitchMode = vi.fn()
    renderDesk(<StatusStrip mode="chat" onSwitchMode={onSwitchMode} />)
    expect(screen.queryByTestId('status-word')).toBeNull()
    expect(screen.queryByTestId('desk-toggle')).toBeNull()
    expect(screen.getByTestId('mode-chat')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTestId('mode-chat'))
    expect(onSwitchMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mode-trading'))
    expect(onSwitchMode).toHaveBeenCalledWith('trading')
    fireEvent.keyDown(screen.getByTestId('mode-pill'), { key: 'ArrowRight' })
    expect(onSwitchMode).toHaveBeenCalledTimes(2)
  })
})

describe('ComposerSeats', () => {
  it('names the authority it has and prefills a quick action', () => {
    const onQuick = vi.fn()
    const onOpenSettings = vi.fn()
    renderDesk(
      <ComposerSeats
        limits={{
          dailyCapUsd: 1000,
          spentTodayUsd: 12,
          thresholdUsd: 100,
          approvalTtlSeconds: 900,
        }}
        provider="uniswap"
        wallet={WALLET}
        typing={false}
        onOpenSettings={onOpenSettings}
        onOpenWallets={vi.fn()}
        onQuick={onQuick}
      />,
    )
    expect(screen.getByTestId('permission-seat')).toHaveTextContent(
      'Asks above $100.00 · $1,000.00/day · Uniswap',
    )
    expect(screen.getByTestId('wallet-seat')).toHaveTextContent('Main')
    fireEvent.click(screen.getByTestId('permission-seat'))
    expect(onOpenSettings).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('quick-dip'))
    expect(onQuick).toHaveBeenCalledWith('dip')
  })

  it('takes the chips out of the tab order while typing', () => {
    renderDesk(
      <ComposerSeats
        limits={null}
        provider="kyber"
        wallet={null}
        typing
        onOpenSettings={vi.fn()}
        onOpenWallets={vi.fn()}
        onQuick={vi.fn()}
      />,
    )
    expect(screen.getByTestId('composer-seats')).toHaveAttribute('data-typing')
    expect(screen.getByTestId('quick-swap')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('permission-seat')).toHaveTextContent('KyberSwap')
  })
})
