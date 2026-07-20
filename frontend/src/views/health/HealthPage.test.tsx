import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HealthPage } from './HealthPage'

const mockRpc = {
  waitForConnection: vi.fn().mockResolvedValue(undefined),
  call: vi.fn(),
}
vi.mock('@/app/providers', () => ({
  useRpc: () => mockRpc,
  useBootstrap: () => ({
    version: '1',
    ws_url: 'ws://127.0.0.1:18791/ws',
    auth_mode: 'none',
    base_path: '/control',
    config_path: '/tmp/agentos.toml',
    features: { diagnostics: true },
  }),
}))

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <HealthPage />
    </QueryClientProvider>,
  )
}

describe('HealthPage', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('calls doctor.status deep for agent main and renders grouped findings', async () => {
    mockRpc.call.mockResolvedValue({
      status: 'degraded',
      ready: true,
      summary: 'Mostly fine',
      impactCounts: { blocks_ready: 0, degrades: 1, optional: 0, none: 3 },
      findings: [
        {
          id: 'memory.slow',
          severity: 'warn',
          readinessImpact: 'degrades',
          surface: 'memory',
          title: 'Memory is slow',
          detail: 'latency high',
          fixSteps: [{ label: 'Restart memory', command: 'agentos gateway restart' }],
        },
      ],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Ready with warnings')).toBeInTheDocument())
    expect(mockRpc.call).toHaveBeenCalledWith('doctor.status', { agentId: 'main', deep: true })
    expect(screen.getByText('Degraded capabilities')).toBeInTheDocument()
    expect(screen.getByText('Memory is slow')).toBeInTheDocument()
    expect(screen.getByText('agentos gateway restart')).toBeInTheDocument()
  })

  it('renders the synthetic gateway.unavailable finding on RPC failure', async () => {
    mockRpc.call.mockRejectedValue(new Error('boom'))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Gateway health report unavailable')).toBeInTheDocument(),
    )
    expect(screen.getByText('Health report unavailable')).toBeInTheDocument()
  })

  it('uses config-target fix steps when the stored wsUrl equals the default (health.js:227-238)', async () => {
    // Legacy saveConnectionSettings stores the default URL itself (app.js:210):
    // a stored-but-equal URL must still count as "uses default".
    localStorage.setItem('agentos.wsUrl', 'ws://127.0.0.1:18791/ws')
    mockRpc.call.mockRejectedValue(new Error('boom'))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Gateway health report unavailable')).toBeInTheDocument(),
    )
    expect(screen.getByText('agentos doctor --config /tmp/agentos.toml --json')).toBeInTheDocument()
    expect(screen.getByText('agentos gateway start --config /tmp/agentos.toml')).toBeInTheDocument()
    // Config context row present in the synthetic error report.
    expect(screen.getByText('Config')).toBeInTheDocument()
  })

  it('uses gateway-target fix steps when the stored wsUrl differs from the default', async () => {
    localStorage.setItem('agentos.wsUrl', 'ws://127.0.0.1:19999/ws')
    mockRpc.call.mockRejectedValue(new Error('boom'))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Gateway health report unavailable')).toBeInTheDocument(),
    )
    expect(
      screen.getByText('agentos doctor --gateway ws://127.0.0.1:19999/ws --json'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Config')).not.toBeInTheDocument()
  })

  it('renders the error immediately without retrying (health.js:64-77: one deep call per load)', async () => {
    mockRpc.call.mockRejectedValue(new Error('boom'))
    // App-level defaults (providers.tsx) set retry: 1 — the health query must
    // override so the deep doctor.status call is never silently duplicated.
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } })}
      >
        <HealthPage />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('Health report unavailable')).toBeInTheDocument())
    expect(mockRpc.call).toHaveBeenCalledTimes(1)
  })

  it('reloads fresh on every view entry instead of serving a cached report', async () => {
    mockRpc.call.mockResolvedValue({ status: 'ready', ready: true, findings: [] })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    })
    const first = render(
      <QueryClientProvider client={client}>
        <HealthPage />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(1))
    first.unmount()
    // gcTime 0 drops the cache on unmount (next macrotask).
    await new Promise((resolve) => setTimeout(resolve, 0))
    render(
      <QueryClientProvider client={client}>
        <HealthPage />
      </QueryClientProvider>,
    )
    // Legacy re-entered through _load: loading state, then a fresh deep call.
    expect(screen.getByText('Checking readiness')).toBeInTheDocument()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(2))
  })

  it('refetches when Refresh is clicked', async () => {
    mockRpc.call.mockResolvedValue({ status: 'ready', ready: true, findings: [] })
    renderPage()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(1))
    screen.getByRole('button', { name: /refresh/i }).click()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledTimes(2))
  })
})
