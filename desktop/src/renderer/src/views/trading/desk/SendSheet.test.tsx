import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDesk, WALLET } from '../test-utils'
import { SendSheet } from './SendSheet'

const rpcCall = vi.fn()
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))
vi.mock('~/lib/desktop-api', () => ({
  desktopApi: () => ({ app: { openExternal: vi.fn(async () => {}) } }),
  isDesktop: () => true,
}))

const A = '0x2222222222222222222222222222222222222222'
const B = '0x3333333333333333333333333333333333333333'

beforeEach(() => {
  rpcCall.mockReset()
})

function fill() {
  fireEvent.change(screen.getByTestId('send-token'), { target: { value: 'USDC' } })
  fireEvent.change(screen.getByTestId('send-recipients'), {
    target: { value: `${A}\n${B}=2.5` },
  })
  fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '10' } })
}

describe('SendSheet', () => {
  it('refuses to ask or send until the form is whole', () => {
    const onAsk = vi.fn()
    renderDesk(
      <SendSheet wallets={[WALLET]} primary={WALLET.address} onClose={vi.fn()} onAsk={onAsk} />,
    )
    fireEvent.click(screen.getByTestId('send-ask'))
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByTestId('send-error')).toHaveTextContent('Name the token')
    fireEvent.change(screen.getByTestId('send-token'), { target: { value: 'USDC' } })
    fireEvent.change(screen.getByTestId('send-recipients'), { target: { value: 'vitalik.eth' } })
    fireEvent.click(screen.getByTestId('send-ask'))
    expect(screen.getByTestId('send-error')).toHaveTextContent('not an address')
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('asks the desk with an exact prompt the preview also shows', () => {
    const onAsk = vi.fn()
    renderDesk(
      <SendSheet wallets={[WALLET]} primary={WALLET.address} onClose={vi.fn()} onAsk={onAsk} />,
    )
    fill()
    expect(screen.getByTestId('send-sheet')).toHaveTextContent('2 recipients')
    fireEvent.click(screen.getByTestId('send-preview-toggle'))
    const preview = screen.getByTestId('send-preview').textContent ?? ''
    expect(preview).toContain(`- ${A} → 10 USDC`)
    expect(preview).toContain(`- ${B} → 2.5 USDC`)
    fireEvent.click(screen.getByTestId('send-ask'))
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onAsk.mock.calls[0]![0]).toBe(preview)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('sends now only on the second click, as the user, with each leg sized', async () => {
    rpcCall.mockResolvedValue({
      orders: [{ orderId: 'a', status: 'submitted' }],
      batchId: 'bat_1',
    })
    const onClose = vi.fn()
    renderDesk(
      <SendSheet wallets={[WALLET]} primary={WALLET.address} onClose={onClose} onAsk={vi.fn()} />,
    )
    fill()
    const now = screen.getByTestId('send-now')
    fireEvent.click(now)
    expect(now).toHaveTextContent('Click again to send')
    expect(rpcCall).not.toHaveBeenCalled()
    fireEvent.click(now)
    await waitFor(() => expect(rpcCall).toHaveBeenCalledTimes(1))
    expect(rpcCall).toHaveBeenCalledWith('trading.send', {
      chainId: 8453,
      wallet: WALLET.address,
      token: 'USDC',
      recipients: [
        { to: A, amount: '10' },
        { to: B, amount: '2.5' },
      ],
      initiator: 'manual',
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
