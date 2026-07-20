import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { CronPage } from './CronPage'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

const navigateSpy = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigateSpy }
})

// A minimal event-bus stub matching the WsRpcClient surface CronPage uses.
type Handler = (...args: unknown[]) => void
function makeRpc() {
  const listeners = new Map<string, Set<Handler>>()
  return {
    waitForConnection: vi.fn().mockResolvedValue(undefined),
    call: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return () => listeners.get(event)?.delete(handler)
    }),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((h) => h(...args))
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0
    },
  }
}
let mockRpc = makeRpc()

vi.mock('@/app/providers', () => ({
  useRpc: () => mockRpc,
  useBootstrap: () => ({
    version: '1',
    ws_url: 'ws://127.0.0.1:18791/ws',
    auth_mode: 'none',
    base_path: '/control',
    config_path: '/tmp/agentos.toml',
    features: {},
  }),
}))

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString()

const REMINDER_JOB = {
  id: 'job-rem',
  name: 'Daily standup',
  enabled: true,
  expression: '0 9 * * 1-5',
  payloadKind: 'reminder',
  sessionTarget: 'isolated',
  next_run: FUTURE,
  message: 'time for standup',
}
const AGENT_JOB = {
  id: 'job-agent',
  name: 'Health check',
  enabled: false,
  expression: '0 * * * *',
  payloadKind: 'agent_turn',
  sessionTarget: 'main',
  last_status: 'ok',
  last_run: Date.now() - 3600_000,
}

const RUNS = [
  {
    started_at: Date.now() - 60_000,
    status: 'ok',
    duration_ms: 120,
    summary: 'ran fine',
    sessionKey: 'agent:main:webchat:x',
  },
]

function wireRpc(
  opts: {
    jobs?: unknown[]
    listReject?: boolean
    updateReject?: boolean
    runReject?: boolean
    runsReject?: boolean
    removeReject?: boolean
    runs?: unknown[]
  } = {},
) {
  mockRpc.call.mockImplementation((method: string) => {
    switch (method) {
      case 'cron.list':
        return opts.listReject
          ? Promise.reject(new Error('list down'))
          : Promise.resolve(opts.jobs ?? [REMINDER_JOB, AGENT_JOB])
      case 'cron.subscribe':
      case 'cron.unsubscribe':
        return Promise.resolve({})
      case 'cron.update':
        return opts.updateReject ? Promise.reject(new Error('update failed')) : Promise.resolve({})
      case 'cron.run':
        return opts.runReject
          ? Promise.reject(new Error('run failed'))
          : Promise.resolve({ reply: 'done' })
      case 'cron.runs':
        return opts.runsReject
          ? Promise.reject(new Error('runs down'))
          : Promise.resolve(opts.runs ?? RUNS)
      case 'cron.remove':
        return opts.removeReject ? Promise.reject(new Error('remove failed')) : Promise.resolve({})
      default:
        return Promise.resolve({})
    }
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CronPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function callsTo(method: string) {
  return mockRpc.call.mock.calls.filter(([m]) => m === method).length
}

describe('CronPage', () => {
  beforeEach(() => {
    mockRpc = makeRpc()
    navigateSpy.mockReset()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.warning).mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls cron.list after waitForConnection', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledWith('cron.list', {}))
    expect(mockRpc.waitForConnection).toHaveBeenCalled()
  })

  it('renders a card per job with kind pill and schedule', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    const card = screen.getByLabelText('Cron job Daily standup')
    expect(within(card).getByText('Reminder')).toBeInTheDocument()
    expect(within(card).getByText('0 9 * * 1-5')).toBeInTheDocument()
    // second job renders too
    expect(screen.getByText('Health check')).toBeInTheDocument()
  })

  it('renders the stat row from the payload', async () => {
    wireRpc()
    renderPage()
    // 2 total jobs, 1 enabled.
    await waitFor(() => expect(screen.getByLabelText('Active schedules')).toHaveTextContent('1'))
  })

  it('mounts → cron.subscribe', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledWith('cron.subscribe', {}))
  })

  it('unmounts → cron.unsubscribe and removes the cron.run.finished listener', async () => {
    wireRpc()
    const view = renderPage()
    await waitFor(() => expect(mockRpc.listenerCount('cron.run.finished')).toBe(1))
    view.unmount()
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledWith('cron.unsubscribe', {}))
    expect(mockRpc.listenerCount('cron.run.finished')).toBe(0)
  })

  it('subscribes exactly once across a StrictMode-style double effect and cleans up fully', async () => {
    // Simulate mount → unmount → mount (React 18 StrictMode dev double-invoke):
    // each cleanup must unsubscribe, and no listener may leak across remounts.
    wireRpc()
    const first = renderPage()
    await waitFor(() => expect(mockRpc.listenerCount('cron.run.finished')).toBe(1))
    first.unmount()
    expect(mockRpc.listenerCount('cron.run.finished')).toBe(0)
    const second = renderPage()
    await waitFor(() => expect(mockRpc.listenerCount('cron.run.finished')).toBe(1))
    second.unmount()
    expect(mockRpc.listenerCount('cron.run.finished')).toBe(0)
  })

  it('a cron.run.finished event invalidates the job list (targeted refetch)', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(callsTo('cron.list')).toBe(1))
    mockRpc.emit('cron.run.finished', {})
    await waitFor(() => expect(callsTo('cron.list')).toBeGreaterThanOrEqual(2))
  })

  it('a cron.run.finished event invalidates an open runs drawer', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    // open the runs drawer for the first job
    fireEvent.click(screen.getByRole('button', { name: 'Daily standup' }))
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('cron.runs', { id: 'job-rem', limit: 10 }),
    )
    const before = callsTo('cron.runs')
    mockRpc.emit('cron.run.finished', {})
    await waitFor(() => expect(callsTo('cron.runs')).toBeGreaterThan(before))
  })

  it('toggling enable/disable calls cron.update and invalidates', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    // Daily standup is enabled → Pause toggles it off.
    fireEvent.click(screen.getByRole('button', { name: /pause daily standup/i }))
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('cron.update', { id: 'job-rem', enabled: false }),
    )
    await waitFor(() => expect(callsTo('cron.list')).toBeGreaterThanOrEqual(2))
  })

  it('run-now calls cron.run', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /run daily standup now/i }))
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledWith('cron.run', { id: 'job-rem' }))
  })

  it('opening the runs drawer calls cron.runs and renders history', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Daily standup' }))
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('cron.runs', { id: 'job-rem', limit: 10 }),
    )
    expect(await screen.findByText('ran fine')).toBeInTheDocument()
  })

  it('deleting requires confirmation then calls cron.remove and invalidates', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete daily standup/i }))
    // confirm dialog
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(mockRpc.call).toHaveBeenCalledWith('cron.remove', { id: 'job-rem' }))
    await waitFor(() => expect(callsTo('cron.list')).toBeGreaterThanOrEqual(2))
  })

  it('cancelling the delete confirmation does not call cron.remove', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(screen.getByText('Daily standup')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete daily standup/i }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(callsTo('cron.remove')).toBe(0)
  })

  it('refreshes on the Refresh button', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(callsTo('cron.list')).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    await waitFor(() => expect(callsTo('cron.list')).toBeGreaterThanOrEqual(2))
  })

  it('shows the empty state when there are no jobs', async () => {
    wireRpc({ jobs: [] })
    renderPage()
    await waitFor(() => expect(screen.getByText(/No schedules yet/i)).toBeInTheDocument())
  })

  it('toasts when cron.list fails', async () => {
    wireRpc({ listReject: true })
    renderPage()
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it('sets the document title', async () => {
    wireRpc()
    renderPage()
    await waitFor(() => expect(document.title).toBe('Cron - AgentOS Control'))
  })
})
