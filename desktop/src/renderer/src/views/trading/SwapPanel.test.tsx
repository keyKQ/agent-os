import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapPanel } from './SwapPanel'
import { ETH, quote, renderDesk, USDC, WALLET } from './test-utils'

const rpcCall = vi.fn()
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))
vi.mock('~/lib/desktop-api', () => ({
  desktopApi: () => ({ app: { openExternal: vi.fn(async () => {}) } }),
  isDesktop: () => true,
}))

function mount(extra: Partial<Parameters<typeof SwapPanel>[0]> = {}) {
  return renderDesk(
    <SwapPanel
      wallets={[WALLET]}
      primary={WALLET.address}
      selectedWallet="all"
      provider="uniswap"
      providerReady
      onSwitchProvider={vi.fn()}
      unlocked
      prefill={{ chainId: 8453, tokenIn: ETH, tokenOut: USDC, seq: 1 }}
      onSent={vi.fn()}
      {...extra}
    />,
  )
}

beforeEach(() => {
  rpcCall.mockReset()
  rpcCall.mockImplementation(async (method: string) => {
    if (method === 'wallet.balances') {
      return {
        balances: [
          {
            chainId: 8453,
            token: ETH,
            raw: '1000000000000000000',
            amount: '1',
            priceUsd: 2500,
            valueUsd: 2500,
            change24hPct: 1.2,
          },
        ],
        updatedAt: Date.now(),
      }
    }
    if (method === 'trading.quote') return quote()
    return {}
  })
})

describe('SwapPanel', () => {
  it('asks for an amount before it quotes, then shows the price, facts and guard', async () => {
    mount()
    const cta = screen.getByTestId('swap-review')
    expect(cta).toBeDisabled()
    expect(cta).toHaveTextContent('Enter an amount')
    expect(rpcCall.mock.calls.some((c) => c[0] === 'trading.quote')).toBe(false)

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } })
    await waitFor(() => expect(screen.getByTestId('quote-out')).toHaveTextContent('250.12'))

    const call = rpcCall.mock.calls.find((c) => c[0] === 'trading.quote')
    expect(call?.[1]).toMatchObject({
      chainId: 8453,
      wallet: WALLET.address,
      tokenIn: ETH.address,
      tokenOut: USDC.address,
      amountIn: '0.1',
      initiator: 'manual',
    })
    expect(screen.getByTestId('quote-facts')).toHaveTextContent('Minimum received')
    expect(screen.getByTestId('quote-facts')).toHaveTextContent('248.87 USDC')
    expect(screen.getByTestId('quote-guard')).toHaveAttribute('data-decision', 'allow')
    expect(screen.getByTestId('swap-review')).not.toBeDisabled()
    expect(screen.getByTestId('swap-review')).toHaveTextContent('Review swap')
  })

  it('refuses more than the wallet holds', async () => {
    mount()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } })
    await waitFor(() => expect(screen.getByTestId('swap-review')).toHaveTextContent('Not enough'))
    expect(screen.getByTestId('swap-review')).toBeDisabled()
  })

  it('reports what the engine would do with an agent swap of this size', async () => {
    rpcCall.mockImplementation(async (method: string) =>
      method === 'trading.quote'
        ? quote({
            valueUsd: 2000,
            guard: {
              decision: 'needs_approval',
              spentTodayUsd: 0,
              dailyCapUsd: 1000,
              thresholdUsd: 100,
            },
          })
        : method === 'wallet.balances'
          ? {
              balances: [
                {
                  chainId: 8453,
                  token: ETH,
                  raw: '1',
                  amount: '10',
                  priceUsd: 2500,
                  valueUsd: 25000,
                  change24hPct: 0,
                },
              ],
            }
          : {},
    )
    mount()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.8' } })
    await waitFor(() =>
      expect(screen.getByTestId('quote-guard')).toHaveAttribute('data-decision', 'needs_approval'),
    )
    expect(screen.getByTestId('quote-guard')).toHaveTextContent('you are confirming it yourself')
  })

  it('opens the confirm sheet from Review and asks the amount to be retyped above 1,000 USD', async () => {
    rpcCall.mockImplementation(async (method: string) =>
      method === 'trading.quote'
        ? quote({ valueUsd: 2500, amountIn: '1', amountOut: '2500' })
        : method === 'wallet.balances'
          ? {
              balances: [
                {
                  chainId: 8453,
                  token: ETH,
                  raw: '1',
                  amount: '10',
                  priceUsd: 2500,
                  valueUsd: 25000,
                  change24hPct: 0,
                },
              ],
            }
          : method === 'trading.swap'
            ? { orders: [{ orderId: 'o9', status: 'submitted', txHash: '0xabc' }] }
            : {},
    )
    const onSent = vi.fn()
    mount({ onSent })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } })
    await waitFor(() => expect(screen.getByTestId('swap-review')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('swap-review'))

    const send = await screen.findByTestId('confirm-send')
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByTestId('confirm-retype'), { target: { value: '1.0' } })
    expect(send).not.toBeDisabled()
    fireEvent.click(send)

    await waitFor(() => expect(onSent).toHaveBeenCalled())
    const swapCall = rpcCall.mock.calls.find((c) => c[0] === 'trading.swap')
    expect(swapCall?.[1]).toMatchObject({
      chainId: 8453,
      wallets: [WALLET.address],
      tokenIn: ETH.address,
      tokenOut: USDC.address,
      amountIn: '1',
      initiator: 'manual',
    })
  })

  it('cannot review without a Uniswap key or an unlocked vault', () => {
    mount({ providerReady: false })
    expect(screen.getByTestId('swap-review')).toHaveTextContent('Add a Uniswap key')
    expect(rpcCall.mock.calls.some((c) => c[0] === 'trading.quote')).toBe(false)
  })

  it('shows the route error the gateway returns', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'trading.quote') throw new Error('trading.no_route: No route for this pair')
      if (method === 'wallet.balances')
        return {
          balances: [
            {
              chainId: 8453,
              token: ETH,
              raw: '1',
              amount: '1',
              priceUsd: 2500,
              valueUsd: 2500,
              change24hPct: 0,
            },
          ],
        }
      return {}
    })
    mount()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } })
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('No route for this pair'),
    )
    expect(screen.getByTestId('swap-review')).toBeDisabled()
  })
})

describe('SwapPanel · providers', () => {
  it('names the provider on the quote line', async () => {
    rpcCall.mockImplementation(async (method: string) =>
      method === 'trading.quote'
        ? quote({ provider: 'kyber' })
        : method === 'wallet.balances'
          ? {
              balances: [
                {
                  chainId: 8453,
                  token: ETH,
                  raw: '1',
                  amount: '1',
                  priceUsd: 2500,
                  valueUsd: 2500,
                  change24hPct: 0,
                },
              ],
            }
          : {},
    )
    mount({ provider: 'kyber' })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } })
    await waitFor(() =>
      expect(screen.getByTestId('quote-provider')).toHaveTextContent('via KyberSwap'),
    )
  })

  it('offers to switch to Uniswap when the provider is blocked in this region', async () => {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'trading.quote') {
        const err = new Error(
          'KyberSwap is not available from your region (HTTP 403).',
        ) as Error & {
          code?: string
        }
        err.code = 'trading.provider_blocked'
        throw err
      }
      if (method === 'wallet.balances')
        return {
          balances: [
            {
              chainId: 8453,
              token: ETH,
              raw: '1',
              amount: '1',
              priceUsd: 2500,
              valueUsd: 2500,
              change24hPct: 0,
            },
          ],
        }
      return {}
    })
    const onSwitchProvider = vi.fn()
    mount({ provider: 'kyber', onSwitchProvider })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } })
    const fix = await screen.findByTestId('provider-blocked-fix')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'KyberSwap is not available from your region',
    )
    fireEvent.click(fix)
    expect(onSwitchProvider).toHaveBeenCalled()
    expect(screen.getByTestId('swap-review')).toBeDisabled()
  })

  it('does not ask for a key when Kyber is the provider', () => {
    mount({ provider: 'kyber', providerReady: true })
    expect(screen.getByTestId('swap-review')).toHaveTextContent('Enter an amount')
  })
})

describe('SwapPanel · provider warnings', () => {
  it('lists what the provider flagged, in the ticket and again in the confirm sheet', async () => {
    rpcCall.mockImplementation(async (method: string) =>
      method === 'trading.quote'
        ? quote({ provider: 'kyber', warnings: ['USDC charges a 1% fee on transfer.', ''] })
        : method === 'wallet.balances'
          ? {
              balances: [
                {
                  chainId: 8453,
                  token: ETH,
                  raw: '1',
                  amount: '1',
                  priceUsd: 2500,
                  valueUsd: 2500,
                  change24hPct: 0,
                },
              ],
            }
          : {},
    )
    mount({ provider: 'kyber' })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } })
    const list = await screen.findByTestId('quote-warnings')
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(list).toHaveTextContent('USDC charges a 1% fee on transfer.')
    fireEvent.click(screen.getByTestId('swap-review'))
    await screen.findByTestId('confirm-send')
    expect(screen.getAllByTestId('quote-warnings')).toHaveLength(2)
  })
})
