import { NavLink } from 'react-router'
import { shortAge } from '~/lib/relative-time'
import { useLive } from '~/stores/live'
import type { SessionRow } from '~/stores/sessions'
import { SESSION_DRAG_TYPE } from '~/views/projects/logic'

/** Route path for a session; keys carry colons, so they are encoded once. */
export function sessionPath(key: string): string {
  return `/sessions/${encodeURIComponent(key)}`
}

/** One session row. Draggable so it can be filed into a project folder. */
export function SessionRowLink({ row, nested = false }: { row: SessionRow; nested?: boolean }) {
  const liveLocally = useLive((s) => s.ids.has(row.key))
  return (
    <NavLink
      to={sessionPath(row.key)}
      className="mac-session app-no-drag"
      data-nested={nested}
      title={row.title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, row.key)
        e.dataTransfer.setData('text/plain', row.title)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <span className="mac-session-dot" data-live={row.live || liveLocally} aria-hidden />
      <span className="mac-session-title">{row.title}</span>
      <span className="mac-session-age">{row.updatedAt ? shortAge(row.updatedAt) : ''}</span>
    </NavLink>
  )
}
