import { CalendarClock } from 'lucide-react'
import { createHashRouter, Navigate } from 'react-router'
import { ChatView } from '~/views/chat/ChatView'
import { PlaceholderView } from '~/views/PlaceholderView'
import { SettingsView } from '~/views/settings/SettingsView'
import { AppShell } from './AppShell'

// Hash routing: the packaged app loads index.html from disk (file://), where
// history-based routing has no server to fall back to.
//
// Home and a session share ONE route (`sessions/:key?`) on purpose: the first
// send navigates from the keyless home to `/sessions/<key>` and React Router
// keeps the same element mounted, so the composer docks with an animation
// instead of remounting.
export const router = createHashRouter([
  {
    path: '/',
    Component: AppShell,
    children: [
      { index: true, element: <Navigate to="/sessions" replace /> },
      { path: 'sessions/:key?', Component: ChatView },
      {
        path: 'jobs',
        element: (
          <PlaceholderView icon={CalendarClock} title="view.jobs.title" body="view.jobs.body" />
        ),
      },
      { path: 'settings', Component: SettingsView },
    ],
  },
])
