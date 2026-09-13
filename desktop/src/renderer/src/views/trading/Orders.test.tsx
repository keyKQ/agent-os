import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Orders } from './Orders'
import { order, renderDesk, USDC } from './test-utils'

const rpcCall = vi.fn()
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))
const openExternal = vi.fn(async () => {})
vi.mock('~/lib/desktop-api', () => ({
  desktopApi: () => ({ app: { openExternal } }),
  isDesktop: () => true,
}))

beforeEach(() => {
  rpcCall.mockReset()
  rpcCall.mockResolvedValue({})
  openExternal.mockClear()
})

describe('Orders · approvals', () => {
  it('lists what the agent is waiting on, with a timer, and approves it', () => {
    const onDecide = vi.fn()
    const waiting = order()
    renderDesk(
      <Orders
        orders={[
          waiting,
          order({
            orderId: 'o2',
            status: 'confirmed',
            txHash: '0xabc',
            explorerUrl: 'https://basescan.org/tx/0xabc',
          }),
        ]}
        approvalsOnly
        deciding={null}
        onDecide={onDecide}
        showWallet={false}
        highlight={null}
      />,
    )
    const rows = screen.getAllByTestId('order-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('0.2 ETH')
    expect(rows[0]).toHaveTextContent('USDC')
    expect(rows[0]).toHaveTextContent('Needs approval')
    expect(rows[0]).toHaveTextContent(/expires in 9:5\d|expires in 10:00/)
    expect(rows[0]).toHaveTextContent('Agent')
    expect(rows[0]).toHaveTextContent('Note: DCA')

    fireEvent.click(screen.getByTestId('order-approve'))
    expect(onDecide).toHaveBeenCalledWith(waiting, true)
    fireEvent.click(screen.getByTestId('order-reject'))
    expect(onDecide).toHaveBeenCalledWith(waiting, false)
  })

  it('locks the buttons while a decision is in flight', () => {
    renderDesk(
      <Orders
        orders={[order()]}
        approvalsOnly
        deciding="o1"
        onDecide={vi.fn()}
        showWallet={false}
        highlight={null}
      />,
    )
    expect(screen.getByTestId('order-approve')).toBeDisabled()
    expect(screen.getByTestId('order-reject')).toBeDisabled()
  })

  it('says why a settled order did not go through, and opens the explorer for one that did', () => {
    renderDesk(
      <Orders
        orders={[
          order({ orderId: 'f1', status: 'failed', reason: 'insufficient gas', expiresAt: null }),
          order({
            orderId: 'c1',
            status: 'confirmed',
            txHash: '0xabc',
            explorerUrl: 'https://basescan.org/tx/0xabc',
            expiresAt: null,
          }),
        ]}
        approvalsOnly={false}
        deciding={null}
        onDecide={vi.fn()}
        showWallet
        highlight={null}
      />,
    )
    const rows = screen.getAllByTestId('order-row')
    expect(rows[0]).toHaveTextContent('Reason: insufficient gas')
    expect(rows[0]).toHaveTextContent('0x1111…1111')
    fireEvent.click(screen.getByRole('button', { name: 'View transaction' }))
    expect(openExternal).toHaveBeenCalledWith('https://basescan.org/tx/0xabc')
  })

  it('offers to unwrap when a swap to ETH delivered WETH', async () => {
    rpcCall.mockImplementation(async (method: string) =>
      method === 'trading.unwrap' ? { txHash: '0xdef' } : {},
    )
    renderDesk(
      <Orders
        orders={[
          order({
            orderId: 'w1',
            status: 'confirmed',
            tokenIn: USDC,
            deliveredToken: { ...USDC, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
            expiresAt: null,
          }),
        ]}
        approvalsOnly={false}
        deciding={null}
        onDecide={vi.fn()}
        showWallet={false}
        highlight={null}
      />,
    )
    expect(screen.getByTestId('order-delivered')).toHaveTextContent('Received WETH instead of ETH.')
    fireEvent.click(screen.getByTestId('unwrap'))
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('trading.unwrap', {
        chainId: 8453,
        wallet: order().wallet,
      }),
    )
  })

  it('shows the empty invitation when nothing waits', () => {
    renderDesk(
      <Orders
        orders={[]}
        approvalsOnly
        deciding={null}
        onDecide={vi.fn()}
        showWallet={false}
        highlight={null}
      />,
    )
    expect(screen.getByText('Nothing waiting')).toBeInTheDocument()
  })
})
