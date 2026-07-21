import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ChatPage } from './ChatPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

function makeImageFile(name: string, size = 100): File {
  const file = new File([new Blob(['img'], { type: 'image/png' })], name, { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

// Same provider-wrapping pattern SkillsPage.test.tsx uses: there is no shared
// `@/test/utils` wrapper in this repo, so the RPC provider is stubbed via a
// module mock and the tree is wrapped in MemoryRouter + QueryClientProvider.
type Handler = (...args: unknown[]) => void
const SLASH_CATALOG = [
  {
    name: '/help',
    usage: '/help',
    description: 'Show the command list',
    aliases: [],
    execution: { action: '/help' },
  },
  {
    name: '/reset',
    usage: '/reset',
    description: 'Reset the session',
    aliases: [],
    execution: { action: 'reset_session' },
  },
]

function makeRpc() {
  const listeners = new Map<string, Set<Handler>>()
  return {
    waitForConnection: vi.fn().mockResolvedValue(undefined),
    call: vi.fn((...args: unknown[]) => {
      if (args[0] === 'commands.list_for_surface') {
        return Promise.resolve({ surface: 'web_chat', commands: SLASH_CATALOG })
      }
      return Promise.resolve({})
    }),
    on: vi.fn((event: string, handler: Handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return () => listeners.get(event)?.delete(handler)
    }),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((h) => h(...args))
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

// A location probe so tests can assert the URL `?session=` after a switch. Held
// on a mutable object (not a reassigned module `let`) so the effect write is a
// property mutation, which the react-hooks lint rules permit.
const probe = { search: '' }
function LocationProbe() {
  const loc = useLocation()
  useEffect(() => {
    probe.search = loc.search
  }, [loc.search])
  return null
}

function renderPage(initialEntry = '/chat') {
  probe.search = ''
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ChatPage />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // The SessionChip fetches /api/sessions on open (chat.js:2026). Stub a default
  // OK response; individual tests override as needed.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: ['agent:main:webchat:default', 'agent:main:webchat:other'],
      }),
    }),
  )
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatPage', () => {
  it('renders the full-bleed chat shell with a thread region', () => {
    mockRpc = makeRpc()
    renderPage()
    expect(document.querySelector('.chat-thread')).not.toBeNull()
    expect(document.title).toBe('Chat - AgentOS Control')
  })

  it('mounts the thread region above a composer row', () => {
    mockRpc = makeRpc()
    renderPage()
    expect(document.querySelector('.chat-stage')).not.toBeNull()
    expect(document.querySelector('.chat-composer')).not.toBeNull()
  })

  it('sends the composed text via chat.send with the legacy payload (chat.js:6150/6193)', async () => {
    mockRpc = makeRpc()
    renderPage()
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => {
      const sends = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send')
      expect(sends.length).toBe(1)
      const params = sends[0]![1] as Record<string, unknown>
      expect(params.message).toBe('hello world')
      expect(params.sessionKey).toBe('agent:main:webchat:default')
    })
  })

  it('enables an attachments-only send and threads attachments into chat.send (chat.js:6064/6157)', async () => {
    mockRpc = makeRpc()
    renderPage()
    // Attach an image via the composer file picker (fire change on the hidden input).
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [makeImageFile('shot.png')] } })
    })
    // The inline FileReader resolves → the send button enables even with empty text.
    const send = await screen.findByRole('button', { name: /send/i })
    await waitFor(() => expect(send).toBeEnabled())
    fireEvent.click(send)
    await waitFor(() => {
      const sends = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send')
      expect(sends.length).toBe(1)
      const params = sends[0]![1] as Record<string, unknown>
      // Empty-text attachments-only send → the fallback provider prompt.
      expect(params.message).toBe('Describe these attachments')
      const atts = params.attachments as Array<Record<string, unknown>>
      expect(atts).toHaveLength(1)
      expect(atts[0]?.name).toBe('shot.png')
      expect(atts[0]?.mime).toBe('image/png')
    })
  })

  it('opens the slash menu on "/" with the loaded catalog and executes a command (chat.js:2619/6113)', async () => {
    mockRpc = makeRpc()
    renderPage()
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    // Wait for the catalog to load, then type "/" → the menu opens.
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('commands.list_for_surface', {
        surface: 'web_chat',
      }),
    )
    fireEvent.change(ta, { target: { value: '/re' } })
    // The filtered command shows in the menu.
    expect(await screen.findByText('/reset')).toBeInTheDocument()
    // Enter (via the menu keyboard intercept) executes it → sessions.reset, NOT
    // a chat.send with the "/reset" text.
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('sessions.reset', {
        key: 'agent:main:webchat:default',
      }),
    )
    const sends = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send')
    expect(sends.length).toBe(0)
  })

  it('a typed "/reset" sends as a slash command, not a chat message (chat.js:6113)', async () => {
    mockRpc = makeRpc()
    renderPage()
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('commands.list_for_surface', {
        surface: 'web_chat',
      }),
    )
    // A space closes the menu (args mode); click Send with the raw "/reset" text.
    fireEvent.change(ta, { target: { value: '/reset ' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('sessions.reset', {
        key: 'agent:main:webchat:default',
      }),
    )
    expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(0)
  })

  it('the "//" literal-slash escape sends "/help" as text, not a command (chat.js:6072)', async () => {
    mockRpc = makeRpc()
    renderPage()
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('commands.list_for_surface', {
        surface: 'web_chat',
      }),
    )
    // "//help" — the menu must NOT open (literal escape).
    fireEvent.change(ta, { target: { value: '//help' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => {
      const sends = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send')
      expect(sends.length).toBe(1)
      // One "/" stripped → the literal message is "/help".
      expect((sends[0]![1] as Record<string, unknown>).message).toBe('/help')
    })
  })

  it('aborts the in-flight turn via chat.abort while streaming (chat.js:8444)', async () => {
    mockRpc = makeRpc()
    renderPage()
    // Drive the controller into a streaming state via a live text_delta frame.
    await act(async () => {
      mockRpc.emit('session.event.text_delta', { seq: 1, text: 'hi' }, {})
    })
    const abort = await screen.findByRole('button', { name: /abort|stop/i })
    fireEvent.click(abort)
    await waitFor(() => {
      const aborts = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.abort')
      expect(aborts.length).toBe(1)
      const params = aborts[0]![1] as Record<string, unknown>
      expect(params.sessionKey).toBe('agent:main:webchat:default')
    })
  })

  /* ── Session chip + lifecycle (Task 11) ─────────────────────────────────── */

  it('opens ?session=<key> and subscribes that session (chat.js:1211/2857)', async () => {
    mockRpc = makeRpc()
    renderPage('/chat?session=agent%3Atrader%3Awebchat%3Adefault')
    // The chip shows the URL session; the transcript subscribes it.
    expect(screen.getByText('agent:trader:webchat:default')).toBeInTheDocument()
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('sessions.messages.subscribe', {
        key: 'agent:trader:webchat:default',
      }),
    )
  })

  it('opens ?agent=<id> as that agent’s webchat key (chat.js:1214)', async () => {
    mockRpc = makeRpc()
    renderPage('/chat?agent=trader')
    expect(screen.getByText('agent:trader:webchat:default')).toBeInTheDocument()
    // Persisted → the URL is rewritten to ?session= and ?agent= dropped (chat.js:1177).
    await waitFor(() => {
      expect(probe.search).toContain('session=agent%3Atrader%3Awebchat%3Adefault')
      expect(probe.search).not.toContain('agent=')
    })
  })

  it('switching sessions via the chip updates the URL ?session= (chat.js:1176/1809)', async () => {
    mockRpc = makeRpc()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /switch chat session/i }))
    fireEvent.click(await screen.findByText('agent:main:webchat:other'))
    await waitFor(() => expect(probe.search).toContain('session=agent%3Amain%3Awebchat%3Aother'))
    // The new session is subscribed (re-point → re-subscribe, chat.js:1832).
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('sessions.messages.subscribe', {
        key: 'agent:main:webchat:other',
      }),
    )
  })

  it('persists the active session to localStorage (chat.js:1173)', async () => {
    mockRpc = makeRpc()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /switch chat session/i }))
    fireEvent.click(await screen.findByText('agent:main:webchat:other'))
    await waitFor(() =>
      expect(localStorage.getItem('agentos_active_session')).toBe('agent:main:webchat:other'),
    )
  })

  it('copies the session key from the chip (chat.js:1782)', async () => {
    mockRpc = makeRpc()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /copy session key/i }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('agent:main:webchat:default')
      expect(toast.info).toHaveBeenCalledWith('Session key copied')
    })
  })

  it('resets the current session from the chip via sessions.reset (chat.js:2723)', async () => {
    mockRpc = makeRpc()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /reset session/i }))
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('sessions.reset', {
        key: 'agent:main:webchat:default',
      }),
    )
  })

  it('the "/new" slash command starts a new chat + subscribes it (chat.js:2692 via onSessionAction)', async () => {
    // Catalog carries a /new command whose action is new_chat.
    mockRpc = makeRpc()
    mockRpc.call = vi.fn((...args: unknown[]) => {
      if (args[0] === 'commands.list_for_surface') {
        return Promise.resolve({
          surface: 'web_chat',
          commands: [
            {
              name: '/new',
              usage: '/new',
              description: 'New chat',
              aliases: [],
              execution: { action: 'new_chat' },
            },
          ],
        })
      }
      return Promise.resolve({})
    }) as typeof mockRpc.call
    renderPage()
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() =>
      expect(mockRpc.call).toHaveBeenCalledWith('commands.list_for_surface', {
        surface: 'web_chat',
      }),
    )
    // Type "/new " (space closes the menu → args mode) and send it as a command.
    fireEvent.change(ta, { target: { value: '/new ' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    // onSessionAction('new_chat') → a fresh key in the SAME agent, switched to +
    // subscribed. The new key is a webchat key with a random suffix.
    await waitFor(() => {
      const subs = mockRpc.call.mock.calls
        .filter(([m]) => m === 'sessions.messages.subscribe')
        .map(([, p]) => (p as { key: string }).key)
      const newKey = subs.find(
        (k) => k.startsWith('agent:main:webchat:') && k !== 'agent:main:webchat:default',
      )
      expect(newKey).toBeTruthy()
    })
    // A new-chat toast fired, and no chat.send (the command was intercepted).
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('New chat session in the current agent'),
    )
    expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(0)
  })

  it('parks the live stream on switch away and restores it on switch back (chat.js:1813/1831)', async () => {
    mockRpc = makeRpc()
    renderPage()
    // Drive a live stream on the default session → a stream bubble appears.
    await act(async () => {
      mockRpc.emit('session.event.text_delta', { seq: 1, text: 'streaming…' }, {})
    })
    const thread = document.querySelector('.chat-thread') as HTMLElement
    await waitFor(() => expect(thread.querySelector('.msg.assistant')).not.toBeNull())

    // Switch to another session — the outgoing session's live stream is parked
    // (its bubble removed from the DOM), and the new session subscribes.
    fireEvent.click(screen.getByRole('button', { name: /switch chat session/i }))
    fireEvent.click(await screen.findByText('agent:main:webchat:other'))
    await waitFor(() => expect(thread.querySelector('.msg.assistant')).toBeNull())

    // Switch back — the parked stream bubble is restored to the thread.
    fireEvent.click(screen.getByRole('button', { name: /switch chat session/i }))
    fireEvent.click(await screen.findByText('agent:main:webchat:default'))
    await waitFor(() => expect(thread.querySelector('.msg.assistant')).not.toBeNull())
  })

  // ── Pending queue (chat.js:6091-6110 enqueue-while-busy) ───────────────────

  const typeAndSend = (text: string) => {
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: text } })
    fireEvent.keyDown(ta, { key: 'Enter' })
  }

  it('enqueues a send while a turn is streaming — the pending rail renders (chat.js:6091)', async () => {
    mockRpc = makeRpc()
    renderPage()
    // First send starts streaming (the controller flips _isStreaming synchronously).
    typeAndSend('first message')
    await waitFor(() =>
      expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(1),
    )
    // Second send while busy → enqueue, NOT a second chat.send.
    await act(async () => typeAndSend('queued while busy'))
    await waitFor(() => expect(screen.getByText('Pending 1/5')).toBeInTheDocument())
    expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(1)
    expect(screen.getByText('queued while busy')).toBeInTheDocument()
  })

  it('caps the pending queue at MAX_PENDING (5) and toasts when full (chat.js:8511)', async () => {
    mockRpc = makeRpc()
    renderPage()
    typeAndSend('turn')
    await waitFor(() =>
      expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(1),
    )
    for (let i = 0; i < 5; i++) {
      await act(async () => typeAndSend(`q${i}`))
    }
    await waitFor(() => expect(screen.getByText('Pending 5/5')).toBeInTheDocument())
    // A sixth enqueue is rejected with a "queue full" warning.
    await act(async () => typeAndSend('overflow'))
    expect(screen.getByText('Pending 5/5')).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Pending queue full (5)'),
      expect.anything(),
    )
  })

  it('recovers ALL pending into the composer on ESC (abort > recover, chat.js:2535/8596)', async () => {
    mockRpc = makeRpc()
    renderPage()
    typeAndSend('turn')
    await waitFor(() =>
      expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(1),
    )
    await act(async () => typeAndSend('alpha'))
    await act(async () => typeAndSend('beta'))
    await waitFor(() => expect(screen.getByText('Pending 2/5')).toBeInTheDocument())

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    // ESC while streaming: aborts (chat.abort) AND recovers pending into the input.
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Escape' })
    })
    await waitFor(() => {
      const aborts = mockRpc.call.mock.calls.filter(([m]) => m === 'chat.abort')
      expect(aborts.length).toBe(1)
    })
    // The queue is emptied and its texts joined into the composer (FIFO).
    await waitFor(() => expect(screen.queryByText('Pending 2/5')).not.toBeInTheDocument())
    expect(ta.value).toContain('alpha')
    expect(ta.value).toContain('beta')
  })

  it('removing a pending chip drops just that item (chat.js:8459)', async () => {
    mockRpc = makeRpc()
    renderPage()
    typeAndSend('turn')
    await waitFor(() =>
      expect(mockRpc.call.mock.calls.filter(([m]) => m === 'chat.send').length).toBe(1),
    )
    await act(async () => typeAndSend('keep'))
    await act(async () => typeAndSend('drop'))
    await waitFor(() => expect(screen.getByText('Pending 2/5')).toBeInTheDocument())
    const removeButtons = screen.getAllByRole('button', { name: /^Remove Pending message/ })
    fireEvent.click(removeButtons[1] as HTMLElement)
    await waitFor(() => expect(screen.getByText('Pending 1/5')).toBeInTheDocument())
    expect(screen.getByText('keep')).toBeInTheDocument()
    expect(screen.queryByText('drop')).not.toBeInTheDocument()
  })

  // ── Markdown export (chat.js:8389) ─────────────────────────────────────────

  it('exports the transcript as a Markdown download (chat.js:8389-8408)', async () => {
    mockRpc = makeRpc()
    renderPage()
    // Seed a rendered user message into the thread (the export source).
    typeAndSend('exported line')
    await waitFor(() => expect(document.querySelector('.msg.user')).not.toBeNull())

    // jsdom lacks URL.createObjectURL/revokeObjectURL — define them so the Blob
    // download path runs. Capture the anchor the export creates + clicks.
    const createObjectURL = vi.fn().mockReturnValue('blob:mock')
    const revokeObjectURL = vi.fn()
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL
    const clickSpy = vi.fn()
    const origCreate = document.createElement.bind(document)
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLElement
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy
      return el
    })

    fireEvent.click(screen.getByRole('button', { name: /export chat as markdown/i }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Exported as Markdown')
    createSpy.mockRestore()
  })

  it('toasts and skips export when the transcript is empty (chat.js:8390)', () => {
    mockRpc = makeRpc()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /export chat as markdown/i }))
    expect(toast.warning).toHaveBeenCalledWith('No messages to export')
  })
})
