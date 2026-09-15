import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDesk, WALLET } from './test-utils'
import { WalletSheet } from './WalletSheet'

const rpcCall = vi.fn()
vi.mock('@/app/providers', () => ({
  useRpc: () => ({ call: rpcCall, waitForConnection: async () => {}, on: () => () => {} }),
}))

beforeEach(() => {
  rpcCall.mockReset()
  rpcCall.mockResolvedValue({})
})

describe('WalletSheet', () => {
  it('creates the vault with a matching password and the chosen unlock mode', async () => {
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'setup' }} onClose={onClose} />)
    const submit = screen.getByTestId('setup-submit')
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Vault password'), { target: { value: 'short' } })
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Vault password'), {
      target: { value: 'correct horse' },
    })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct hors' },
    })
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct horse' },
    })
    expect(submit).not.toBeDisabled()

    fireEvent.click(screen.getByLabelText(/Ask me each time/))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('wallet.setup', {
        password: 'correct horse',
        unlockMode: 'manual',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('creates a wallet with a label', async () => {
    rpcCall.mockResolvedValue({ wallet: WALLET })
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'create' }} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Ops' } })
    fireEvent.click(screen.getByTestId('create-submit'))
    await waitFor(() => expect(rpcCall).toHaveBeenCalledWith('wallet.create', { label: 'Ops' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('imports from a private key', async () => {
    rpcCall.mockResolvedValue({ wallet: WALLET })
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'import' }} onClose={onClose} />)
    const submit = screen.getByTestId('import-submit')
    expect(submit).toBeDisabled()
    const key = `0x${'ab'.repeat(32)}`
    fireEvent.change(screen.getByLabelText('Private key'), { target: { value: key } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Cold' } })
    fireEvent.click(submit)
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('wallet.import', { label: 'Cold', privateKey: key }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('imports from a keystore with its password', async () => {
    rpcCall.mockResolvedValue({ wallet: WALLET })
    renderDesk(<WalletSheet mode={{ kind: 'import' }} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Keystore file' }))
    fireEvent.change(screen.getByLabelText('Keystore JSON'), {
      target: { value: '{"version":3}' },
    })
    fireEvent.change(screen.getByLabelText('Keystore password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByTestId('import-submit'))
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('wallet.import', {
        label: 'Imported',
        keystoreJson: '{"version":3}',
        keystorePassword: 'pw',
      }),
    )
  })

  it('exports only after the vault password, then shows and copies the secret once', async () => {
    rpcCall.mockResolvedValue({ privateKey: '0xdeadbeef' })
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    renderDesk(<WalletSheet mode={{ kind: 'export', wallet: WALLET }} onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Anyone with this key controls the funds')
    const reveal = screen.getByTestId('export-reveal')
    expect(reveal).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Raw private key' }))
    fireEvent.change(screen.getByLabelText('Vault password'), {
      target: { value: 'correct horse' },
    })
    fireEvent.click(reveal)
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('wallet.export', {
        address: WALLET.address,
        password: 'correct horse',
        format: 'privateKey',
      }),
    )
    expect(await screen.findByTestId('export-secret')).toHaveTextContent('0xdeadbeef')
    fireEvent.click(screen.getByTestId('export-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('0xdeadbeef'))
  })

  it('marks a wrong unlock password without closing', async () => {
    rpcCall.mockRejectedValue(new Error('wallet.bad_password'))
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'unlock' }} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('unlock-submit'))
    expect(await screen.findByText('That password does not open the vault.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes a wallet only with the vault password', async () => {
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'remove', wallet: WALLET }} onClose={onClose} />)
    expect(screen.getByTestId('remove-submit')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Vault password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByTestId('remove-submit'))
    await waitFor(() =>
      expect(rpcCall).toHaveBeenCalledWith('wallet.remove', {
        address: WALLET.address,
        password: 'pw',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

/* The desk's rails are 300–520 px wide and only ever showed a wallet's name,
   so this sheet is where the address and everything that acts on a wallet
   lives. The address must be the whole address: shortening it here would
   reproduce the gap the sheet exists to close. */
describe('WalletSheet · manage', () => {
  const SECOND = {
    ...WALLET,
    address: '0x2222222222222222222222222222222222222222',
    label: '10k',
    primary: false,
  }

  function mockVault() {
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'wallet.list') return { wallets: [WALLET, SECOND], primary: WALLET.address }
      if (method === 'wallet.status')
        return {
          initialized: true,
          unlocked: true,
          unlockMode: 'session',
          walletCount: 2,
          primary: WALLET.address,
          vaultPath: '/v',
        }
      if (method === 'trading.status')
        return {
          enabled: true,
          chains: [
            {
              chainId: 8453,
              key: 'base',
              name: 'Base',
              native: 'ETH',
              explorer: 'https://basescan.org',
              rpcUrl: '',
              healthy: true,
            },
          ],
        }
      if (method === 'trading.portfolio')
        return { totals: {}, holdings: [], wallets: [], updatedAt: 0, syncing: false }
      return {}
    })
  }

  it('writes every address out in full and copies the whole one', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    mockVault()
    renderDesk(<WalletSheet mode={{ kind: 'manage' }} onClose={vi.fn()} />)

    const rows = await screen.findAllByTestId('manage-address')
    expect(rows.map((n) => n.textContent)).toEqual([WALLET.address, SECOND.address])

    fireEvent.click(screen.getAllByTestId('manage-copy')[1]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECOND.address))
  })

  it('offers make-primary only on the wallets that are not primary', async () => {
    mockVault()
    renderDesk(<WalletSheet mode={{ kind: 'manage' }} onClose={vi.fn()} />)
    await screen.findAllByTestId('manage-address')
    // Two wallets, one of them primary: exactly one offer to change that.
    expect(screen.getAllByTestId('manage-primary')).toHaveLength(1)
    expect(screen.getAllByTestId('manage-remove')).toHaveLength(2)
  })

  it('returns to the manager when a flow it opened is closed', async () => {
    mockVault()
    const onClose = vi.fn()
    renderDesk(<WalletSheet mode={{ kind: 'manage' }} onClose={onClose} />)
    await screen.findAllByTestId('manage-address')

    fireEvent.click(screen.getAllByTestId('manage-rename')[0]!)
    expect(screen.getByText('Rename wallet')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Cancel'))
    await screen.findAllByTestId('manage-address')
    // Closing the sub-flow must not close the sheet the caller opened.
    expect(onClose).not.toHaveBeenCalled()
  })
})
