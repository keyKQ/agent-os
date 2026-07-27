import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvPage } from './EnvPage'
import type { EnvListResponse, EnvVarRow } from './logic'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const mockRpc = { call: vi.fn(), waitForConnection: vi.fn().mockResolvedValue(undefined) }

vi.mock('@/app/providers', () => ({
  useRpc: () => mockRpc,
  useBootstrap: () => ({ base_path: '/control', features: {} }),
}))

const SECRET = 'sk-live-supersecret-value'

function row(partial: Partial<EnvVarRow> & { name: string }): EnvVarRow {
  return {
    isSet: false,
    source: 'unset',
    masked: null,
    secret: true,
    description: '',
    url: '',
    category: 'custom',
    owner: '',
    required: false,
    writable: true,
    restartRequired: false,
    missing: false,
    ...partial,
  }
}

const PAYLOAD: EnvListResponse = {
  envFilePath: '~/.agentos/.env',
  setCount: 1,
  totalCount: 4,
  shadowedCount: 0,
  vars: [
    row({
      name: 'OPENAI_API_KEY',
      isSet: true,
      source: 'home_file',
      masked: 'sk-l…alue',
      category: 'provider',
      owner: 'openai',
      description: 'API key for OpenAI (LLM provider).',
      restartRequired: true,
    }),
    row({
      name: 'BASE_RPC_URL',
      category: 'skill',
      owner: 'onchain',
      secret: false,
      description: 'Base L2 RPC endpoint',
      url: 'https://docs.example.invalid/',
      required: true,
      missing: true,
    }),
    row({ name: 'PATH', isSet: true, source: 'process', masked: '/usr/bin', writable: false }),
    row({ name: 'MY_OWN', category: 'custom' }),
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <EnvPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRpc.call.mockImplementation((method: string) => {
    if (method === 'env.list') return Promise.resolve(PAYLOAD)
    return Promise.resolve({})
  })
})

describe('EnvPage', () => {
  it('groups variables and names who needs each one', async () => {
    renderPage()
    expect(await screen.findByText('LLM providers')).toBeTruthy()
    expect(screen.getByText('Skills')).toBeTruthy()
    expect(screen.getByText(/Needed by onchain/)).toBeTruthy()
  })

  it('shows masked values, never the real one', async () => {
    const { container } = renderPage()
    await screen.findByText('OPENAI_API_KEY')
    expect(container.textContent).toContain('sk-l…alue')
    expect(container.textContent).not.toContain(SECRET)
  })

  it('locks variables the server refuses to write and offers no edit control', async () => {
    renderPage()
    await screen.findByText('PATH')
    // An operator who cannot see why the row is inert will file a bug; the
    // lock plus its title is the explanation.
    expect(screen.getByLabelText('Not writable through AgentOS')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Set PATH/ })).toBeNull()
  })

  it('warns when a value is shadowed by the process environment', async () => {
    mockRpc.call.mockImplementation((method: string) => {
      if (method === 'env.list') return Promise.resolve({ ...PAYLOAD, shadowedCount: 1 })
      return Promise.resolve({})
    })
    renderPage()
    expect(
      await screen.findByText(
        /Editing them here will not take effect until the export is removed/i,
      ),
    ).toBeTruthy()
  })

  it('links to where a credential can be obtained', async () => {
    renderPage()
    await screen.findByText('BASE_RPC_URL')
    const link = screen.getByRole('link', { name: /where to get this/i })
    expect(link.getAttribute('href')).toBe('https://docs.example.invalid/')
  })

  it('saves a value through env.set', async () => {
    renderPage()
    await screen.findByText('BASE_RPC_URL')

    fireEvent.click(screen.getByRole('button', { name: 'Set BASE_RPC_URL' }))
    fireEvent.change(screen.getByLabelText('Value for BASE_RPC_URL'), {
      target: { value: 'https://rpc.example.invalid' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => {
      expect(mockRpc.call).toHaveBeenCalledWith('env.set', {
        name: 'BASE_RPC_URL',
        value: 'https://rpc.example.invalid',
      })
    })
  })

  it('filters to the variables that still need attention', async () => {
    renderPage()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.click(screen.getByRole('button', { name: 'Missing' }))
    await waitFor(() => expect(screen.queryByText('OPENAI_API_KEY')).toBeNull())
    expect(screen.getByText('BASE_RPC_URL')).toBeTruthy()
  })

  it('rejects an invalid new name before calling the server', async () => {
    renderPage()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.click(screen.getByRole('button', { name: /Add variable/ }))
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: '1BAD' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(mockRpc.call).not.toHaveBeenCalledWith('env.set', expect.anything())
  })

  it('requires confirmation before revealing a value', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPage()
    await screen.findByText('OPENAI_API_KEY')

    fireEvent.click(screen.getByRole('button', { name: /Reveal OPENAI_API_KEY/ }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRpc.call).not.toHaveBeenCalledWith('env.reveal', expect.anything())
    confirmSpy.mockRestore()
  })

  it('reveals only after the operator agrees', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockRpc.call.mockImplementation((method: string) => {
      if (method === 'env.list') return Promise.resolve(PAYLOAD)
      if (method === 'env.reveal') return Promise.resolve({ value: SECRET })
      return Promise.resolve({})
    })
    renderPage()
    await screen.findByText('OPENAI_API_KEY')

    fireEvent.click(screen.getByRole('button', { name: /Reveal OPENAI_API_KEY/ }))
    expect(await screen.findByText(SECRET)).toBeTruthy()
    confirmSpy.mockRestore()
  })

  it('surfaces a load failure with a retry instead of a blank page', async () => {
    mockRpc.call.mockRejectedValue(new Error('gateway is down'))
    renderPage()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('gateway is down')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
  })
})
