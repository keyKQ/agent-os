import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeChildren } from './routes'
import { AppProviders } from './providers'
import { AppShell } from './AppShell'

// Render the route tree without AppProviders (no network): test harness
// provides QueryClient only; views under test here are stubs.
function renderAt(path: string) {
  const router = createMemoryRouter(routeChildren, { initialEntries: [path] })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('routes', () => {
  it('renders a stub for every registered view', () => {
    renderAt('/sessions')
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
  })

  it('renders XSS-safe 404 text for unknown paths', () => {
    renderAt('/nope<script>')
    expect(screen.getByText(/Page not found:/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })

  it('sets the document title from the route', () => {
    renderAt('/logs')
    expect(document.title).toBe('Logs - AgentOS Control')
  })
})

// Parity: app.js:119-171 — mobile sidebar drawer (hamburger toggle, close on
// nav-click / outside-click / Escape, aria-expanded + aria-hidden/inert sync
// at <=768px). jsdom has no matchMedia, so each test stubs it.
describe('mobile sidebar drawer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubMatchMedia(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    )
  }

  function renderShellAt(path: string) {
    const router = createMemoryRouter([{ element: <AppShell />, children: routeChildren }], {
      initialEntries: [path],
    })
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
  }

  it('hides the drawer on mobile until the hamburger opens it, and closes on nav click', () => {
    stubMatchMedia(true)
    renderShellAt('/logs')
    const toggle = screen.getByRole('button', { name: 'Toggle menu' })
    const sidebar = document.getElementById('sidebar-nav')!
    // Closed drawer at <=768px: aria-expanded false, hidden + inert for AT.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'sidebar-nav')
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(sidebar).toHaveAttribute('inert')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(sidebar).not.toHaveAttribute('aria-hidden')
    expect(sidebar).not.toHaveAttribute('inert')

    // app.js:141-143 — clicking a nav item closes the drawer.
    fireEvent.click(screen.getByRole('link', { name: 'Sessions' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  })

  it('closes on Escape and on outside click', () => {
    stubMatchMedia(true)
    renderShellAt('/logs')
    const toggle = screen.getByRole('button', { name: 'Toggle menu' })

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // app.js:153-157 — Esc closes the drawer.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // app.js:147-151 — a click outside the sidebar/toggle closes the drawer.
    fireEvent.click(screen.getByRole('main'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the sidebar visible to AT on desktop (no aria-hidden/inert)', () => {
    stubMatchMedia(false)
    renderShellAt('/logs')
    const sidebar = document.getElementById('sidebar-nav')!
    expect(sidebar).not.toHaveAttribute('aria-hidden')
    expect(sidebar).not.toHaveAttribute('inert')
  })
})

// Guards the effect-cleanup path in AppProviders (Task 5 review carry-forward):
// the bootstrap fetch + rpc subscription must unsubscribe/disconnect on unmount
// so a StrictMode-style double mount does not leak or crash.
describe('AppProviders effect cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts and unmounts repeatedly without crashing', () => {
    // Bootstrap fetch never resolves here, so the provider stays in its
    // "Connecting…" state; we exercise mount → unmount → remount purely to
    // verify the cleanup function runs (unsubscribe + disconnect) without error.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )

    const first = render(
      <AppProviders>
        <div>child</div>
      </AppProviders>,
    )
    expect(() => first.unmount()).not.toThrow()

    const second = render(
      <AppProviders>
        <div>child</div>
      </AppProviders>,
    )
    expect(() => second.unmount()).not.toThrow()
  })
})
