import { act, fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { order, renderDesk, WALLET } from '../test-utils'
import { ApprovalCard } from './ApprovalCard'
import { ApprovalsRegion } from './ApprovalsRegion'

const openExternal = vi.fn(async () => {})
vi.mock('~/lib/desktop-api', () => ({
  desktopApi: () => ({ app: { openExternal } }),
  isDesktop: () => true,
}))

beforeEach(() => {
  openExternal.mockClear()
})

describe('ApprovalCard', () => {
  it('shows bound facts, focuses Reject first, and approves a normal order in one click', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    renderDesk(
      <ApprovalCard
        order={order({ valueUsd: 120, priceImpactPct: 0.3, note: 'DCA leg 3' })}
        wallets={[WALLET]}
        deciding={false}
        onApprove={onApprove}
        onReject={onReject}
        focusOnMount
      />,
    )
    const card = screen.getByTestId('approval-card')
    expect(card).toHaveTextContent('Approval needed · Swap')
    expect(card).toHaveTextContent('Main · 0x1111…1111')
    expect(card).toHaveTextContent('0.2 ETH')
    expect(card).toHaveTextContent('500 USDC')
    expect(card).toHaveTextContent('DCA leg 3')
    expect(card).toHaveTextContent(/UTC[+−]/)
    expect(screen.queryByTestId('risk-high')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('card-reject'))
    fireEvent.click(screen.getByTestId('card-approve'))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('arms a high-risk approve and executes on the second click within the window', () => {
    vi.useFakeTimers()
    const onApprove = vi.fn()
    renderDesk(
      <ApprovalCard
        order={order({ valueUsd: 900 })}
        wallets={[WALLET]}
        deciding={false}
        onApprove={onApprove}
        onReject={vi.fn()}
        focusOnMount={false}
      />,
    )
    expect(screen.getByTestId('risk-high')).toBeInTheDocument()
    const approve = screen.getByTestId('card-approve')
    fireEvent.click(approve)
    expect(onApprove).not.toHaveBeenCalled()
    expect(approve).toHaveTextContent('Click again to approve and execute')
    act(() => {
      vi.advanceTimersByTime(4100)
    })
    expect(approve).toHaveTextContent('Approve')
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('rejects with a note the agent will read', () => {
    const onReject = vi.fn()
    renderDesk(
      <ApprovalCard
        order={order()}
        wallets={[WALLET]}
        deciding={false}
        onApprove={vi.fn()}
        onReject={onReject}
        focusOnMount={false}
      />,
    )
    fireEvent.click(screen.getByTestId('card-reject'))
    const reason = screen.getByTestId('reject-reason')
    fireEvent.change(reason, { target: { value: 'slippage too high' } })
    fireEvent.click(screen.getByTestId('card-reject'))
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1' }),
      'slippage too high',
    )
  })

  it('sends the note once on Enter and ignores a second Enter while the decision is in flight', () => {
    const onReject = vi.fn()
    const card = (deciding: boolean) => (
      <ApprovalCard
        order={order()}
        wallets={[WALLET]}
        deciding={deciding}
        onApprove={vi.fn()}
        onReject={onReject}
        focusOnMount={false}
      />
    )
    const { rerender } = renderDesk(card(false))
    fireEvent.click(screen.getByTestId('card-reject'))
    const reason = screen.getByTestId('reject-reason')
    fireEvent.change(reason, { target: { value: 'not now' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    expect(onReject).toHaveBeenCalledTimes(1)
    // The owner marks the order as deciding; the same key again does nothing.
    rerender(card(true))
    fireEvent.keyDown(screen.getByTestId('reject-reason'), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('card-reject'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('leaves a settled stamp with the outcome and the tx link', () => {
    renderDesk(
      <ApprovalCard
        order={order({
          status: 'confirmed',
          txHash: '0xabcdef1234',
          explorerUrl: 'https://basescan.org/tx/0xabcdef1234',
        })}
        wallets={[WALLET]}
        deciding={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        focusOnMount={false}
      />,
    )
    expect(screen.queryByTestId('card-approve')).toBeNull()
    const settled = screen.getByTestId('approval-card')
    expect(settled).toHaveTextContent('Confirmed')
    // An agent swap under the limits settles without ever asking, so the
    // heading must not claim an approval that was never requested.
    expect(settled).not.toHaveTextContent('Approval needed')
    expect(settled.querySelector('.trd-card__title')).toHaveTextContent('Swap')
    fireEvent.click(screen.getByText(/0xabcd/))
    expect(openExternal).toHaveBeenCalledWith('https://basescan.org/tx/0xabcdef1234')
  })
})

describe('ApprovalsRegion', () => {
  it('renders nothing with no asks, and docks pending cards before settled stamps', () => {
    const { container, rerender } = renderDesk(
      <ApprovalsRegion
        pending={[]}
        settled={[]}
        wallets={[WALLET]}
        deciding={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        focusOrderId={null}
      />,
    )
    expect(container.querySelector('[data-testid=approvals-region]')).toBeNull()
    rerender(
      <ApprovalsRegion
        pending={[order({ orderId: 'p1' })]}
        settled={[order({ orderId: 's1', status: 'rejected', reason: 'user' })]}
        wallets={[WALLET]}
        deciding={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        focusOrderId={null}
      />,
    )
    const cards = screen.getAllByTestId('approval-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveAttribute('data-order', 'p1')
    expect(screen.getByTestId('approval-stamp')).toHaveTextContent('Rejected')
  })

  it('closes a settled stamp by hand, and never offers that on a pending ask', () => {
    const onDismiss = vi.fn()
    renderDesk(
      <ApprovalsRegion
        pending={[order({ orderId: 'p1' })]}
        settled={[order({ orderId: 's1', status: 'confirmed' })]}
        wallets={[WALLET]}
        deciding={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        focusOrderId={null}
        onDismiss={onDismiss}
      />,
    )
    const dismiss = screen.getAllByTestId('card-dismiss')
    expect(dismiss).toHaveLength(1)
    expect(screen.getByTestId('approval-stamp')).toContainElement(dismiss[0]!)
    fireEvent.click(dismiss[0]!)
    expect(onDismiss).toHaveBeenCalledWith('s1')
  })
})
