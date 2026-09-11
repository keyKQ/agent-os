import { useEffect, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { useKeyboardShortcut } from '@/components/KeyboardShortcuts'
import { Sidebar } from '~/components/Sidebar'
import { Toolbar } from '~/components/Toolbar'
import { sessionPath } from '~/components/sidebar/SessionRow'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { readLastSession } from '~/lib/last-session'
import { useApprovalSignal } from '~/lib/use-notifications'
import { bindGatewayEvents } from '~/stores/gateway'
import { useSettings } from '~/stores/settings'
import { useUi } from '~/stores/ui'
import { JobsPanel } from '~/views/jobs/JobsPanel'
import { settingsPath } from '~/views/settings/sections'

/** Window chrome: translucent full-height sidebar, then toolbar + routed content. */
export function AppShell() {
  useEffect(() => bindGatewayEvents(), [])
  useSettingsEntry()
  useShellShortcuts()
  useLaunchView()
  useApprovalSignal()

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="mac-content flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <main className="relative z-[2] min-h-0 flex-1 overflow-auto" data-selectable>
          <Outlet />
        </main>
      </div>
      {/* Layers over the whole window, whichever route is showing. */}
      <JobsPanel />
    </div>
  )
}

export function isSettingsRoute(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

/**
 * Settings is a route. Entering it from anywhere records where "Done" should
 * return to; the app menu's "Settings…" (⌘, at the OS level) arrives over IPC.
 */
function useSettingsEntry() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const setReturnTo = useUi((s) => s.setSettingsReturnTo)
  const last = useRef(pathname)
  useEffect(() => {
    if (isSettingsRoute(pathname) && !isSettingsRoute(last.current)) setReturnTo(last.current)
    last.current = pathname
  }, [pathname, setReturnTo])
  useEffect(
    () =>
      desktopApi().settings.onOpenRequested(() => {
        if (!isSettingsRoute(window.location.hash.replace(/^#/, ''))) {
          void navigate(settingsPath())
        }
      }),
    [navigate],
  )
}

/** ⌘, settings · ⌘N new session · ⌘⇧S sidebar. Registered with the console's
 *  registry so they show in its cheat sheet and respect open overlays. */
function useShellShortcuts() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const returnTo = useUi((s) => s.settingsReturnTo)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const category = t('settings.shortcuts.app')

  useKeyboardShortcut(
    {
      combo: 'mod+,',
      description: t('settings.shortcuts.settings'),
      category,
      allowInInputs: true,
      allowWithOverlays: true,
    },
    (e) => {
      e.preventDefault()
      void navigate(isSettingsRoute(pathname) ? returnTo || '/sessions' : settingsPath())
    },
  )
  useKeyboardShortcut(
    {
      combo: 'mod+n',
      description: t('settings.shortcuts.newSession'),
      category,
      allowInInputs: true,
    },
    (e) => {
      e.preventDefault()
      void navigate('/sessions')
    },
  )
  useKeyboardShortcut(
    {
      combo: 'mod+shift+s',
      description: t('settings.shortcuts.toggleSidebar'),
      category,
      allowInInputs: true,
    },
    (e) => {
      e.preventDefault()
      toggleSidebar()
    },
  )
}

/**
 * "Open at launch: Last session". Runs once, after settings have loaded and
 * only while still on the keyless home route, so a deep link or a click that
 * beat the settings read is never overridden.
 */
function useLaunchView() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const loaded = useSettings((s) => s.loaded)
  const launchView = useSettings((s) => s.settings.general.launchView)
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !loaded) return
    done.current = true
    if (launchView !== 'last') return
    const last = readLastSession()
    if (last && (pathname === '/sessions' || pathname === '/')) {
      void navigate(sessionPath(last), { replace: true })
    }
  }, [loaded, launchView, pathname, navigate])
}
