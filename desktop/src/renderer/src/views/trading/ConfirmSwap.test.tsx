import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmSwap } from './ConfirmSwap'
import { ETH, quote, renderDesk, USDC, WALLET } from './test-utils'

const rpcCall = vi.fn(async () => ({ orders: [] }))
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))

describe('ConfirmSwap · the quote is frozen while the sheet is open', () => {
  const sheet = (
    amountOut: string,
    fetchedAt: number,
    refreshing: boolean,
    onRefresh = vi.fn(),
  ) => (
    <ConfirmSwap
      quote={quote({ amountOut, minOut: amountOut })}
      fetchedAt={fetchedAt}
      wallet={WALLET}
      tokenIn={ETH}
      tokenOut={USDC}
      amount="0.1"
      slippagePct={undefined}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onClose={vi.fn()}
      onSent={vi.fn()}
    />
  )

  it('keeps the numbers it opened with while the panel behind re-quotes', () => {
    const now = Date.now()
    const { rerender } = renderDesk(sheet('250.12', now, false))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('250.12')
    rerender(sheet('199.00', now + 15_000, false))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('250.12')
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('199')
    expect(screen.queryByTestId('confirm-stale')).toBeNull()
  })

  it('adopts the next quote only after Refresh quote was asked for', () => {
    const now = Date.now()
    const onRefresh = vi.fn()
    const { rerender } = renderDesk(sheet('250.12', now, false, onRefresh))
    fireEvent.click(screen.getByTestId('confirm-refresh-quote'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    // Still fetching: the old numbers stay on screen.
    rerender(sheet('250.12', now, true, onRefresh))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('250.12')
    rerender(sheet('199.00', now + 3_000, false, onRefresh))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('199')
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('250.12')
  })

  it('still counts the frozen quote down and refreshes through the stale button', () => {
    const onRefresh = vi.fn()
    const { rerender } = renderDesk(sheet('250.12', 0, false, onRefresh))
    expect(screen.getByTestId('confirm-stale')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(sheet('251.00', Date.now(), false, onRefresh))
    expect(screen.queryByTestId('confirm-stale')).toBeNull()
    expect(screen.getByTestId('confirm-send')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('251')
  })
})
