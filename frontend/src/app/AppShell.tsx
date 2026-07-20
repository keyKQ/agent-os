import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { Menu, Moon, Sun } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/stores/theme'
import { useConnection } from '@/stores/connection'
import { VIEWS } from './routes'

// app.js:123 — the drawer breakpoint shared with the legacy CSS.
function mobileQuery(): MediaQueryList | null {
  try {
    return window.matchMedia('(max-width: 768px)')
  } catch {
    return null
  }
}

export function AppShell() {
  const mode = useTheme((s) => s.mode)
  const toggle = useTheme((s) => s.toggle)
  const connState = useConnection((s) => s.state)

  // app.js:119-171 — mobile sidebar drawer: hamburger toggle, close on
  // nav-click / outside-click / Escape, aria-expanded + aria-hidden/inert sync.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => mobileQuery()?.matches ?? false)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const mq = mobileQuery()
    if (!mq) return
    const sync = () => setIsMobile(mq.matches)
    // app.js:131-135 — modern addEventListener with addListener fallback.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync)
      return () => mq.removeEventListener('change', sync)
    }
    mq.addListener(sync)
    return () => mq.removeListener(sync)
  }, [])

  useEffect(() => {
    if (!sidebarOpen) return
    // app.js:144-151 — click outside the sidebar (and not on the toggle)
    // closes the drawer; the CSS backdrop can't receive pointer events.
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (sidebarRef.current?.contains(target) || toggleRef.current?.contains(target)) return
      setSidebarOpen(false)
    }
    // app.js:152-157 — Esc closes the drawer for keyboard users.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeydown)
    }
  }, [sidebarOpen])

  // app.js:160-171 — a closed drawer on mobile is hidden from AT and inert.
  const drawerHidden = isMobile && !sidebarOpen

  return (
    <div className="flex h-dvh font-sans">
      <aside
        ref={sidebarRef}
        id="sidebar-nav"
        aria-hidden={drawerHidden || undefined}
        inert={drawerHidden || undefined}
        className={`w-56 shrink-0 border-r bg-background p-3 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform ${
          sidebarOpen ? '' : 'max-md:-translate-x-full'
        }`}
      >
        <div className="mb-4 px-2 font-semibold">AgentOS Control</div>
        <nav aria-label="Main">
          {VIEWS.map((v) => (
            <NavLink
              key={v.path}
              to={`/${v.path}`}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `block rounded px-2 py-1.5 text-sm ${isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'}`
              }
            >
              {v.title}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {connState !== 'connected' && (
          <div role="status" className="bg-destructive/10 px-4 py-1.5 text-sm">
            {connState === 'connecting' ? 'Connecting to gateway…' : 'Disconnected — reconnecting…'}
          </div>
        )}
        <header className="flex items-center justify-between border-b px-4 py-2">
          <Button
            ref={toggleRef}
            variant="ghost"
            size="icon"
            className="md:hidden"
            title="Toggle menu"
            aria-label="Toggle menu"
            aria-controls="sidebar-nav"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <Menu className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={toggle}
            title={`Theme: ${mode}`}
            aria-label={`Theme: ${mode}. Toggle theme`}
            aria-pressed={mode === 'dark'}
          >
            {mode === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  )
}
