import { SlidersHorizontal } from 'lucide-react'
import { useMemo, useState, type DragEvent } from 'react'
import { filterSessions } from '@/views/sessions/logic'
import { t } from '~/i18n'
import { dateGroup, groupKey, type DateGroup } from '~/lib/relative-time'
import { useMoveSession, useProjects } from '~/stores/projects'
import { toSessionRow, useSessions, type SessionRow } from '~/stores/sessions'
import { useUi } from '~/stores/ui'
import { fileSessions, SESSION_DRAG_TYPE } from '~/views/projects/logic'
import { ProjectFolders } from './ProjectFolders'
import { SessionRowLink } from './SessionRow'

export { sessionPath } from './SessionRow'

function groupLabel(g: DateGroup): string {
  switch (g.kind) {
    case 'today':
      return t('group.today')
    case 'yesterday':
      return t('group.yesterday')
    case 'week':
      return t('group.week')
    case 'month':
      return g.label
  }
}

/**
 * Project folders, then the loose sessions grouped by day/week/month. A
 * session filed in a project lives under its folder, not in the date list;
 * while a search is active every match shows flat so nothing hides in a
 * closed folder. Dragging a session onto the "Sessions" header unfiles it.
 */
export function SessionList() {
  const query = useUi((s) => s.sessionQuery)
  const { rows, loading, error } = useSessions()
  const projectsState = useProjects()
  const { move } = useMoveSession()
  const [over, setOver] = useState(false)
  const searching = Boolean(query.trim())

  const filed = useMemo(() => fileSessions(rows, projectsState.projects), [rows, projectsState])

  const groups = useMemo(() => {
    const visible = searching
      ? filterSessions(
          rows.map((r) => r.raw),
          query,
        ).map(toSessionRow)
      : filed.unfiled
    const out = new Map<string, { group: DateGroup; items: SessionRow[] }>()
    for (const row of visible) {
      // Rows without a timestamp sort to the top group rather than a fake date.
      const g: DateGroup = row.updatedAt ? dateGroup(row.updatedAt) : { kind: 'today' }
      const key = groupKey(g)
      const entry = out.get(key) ?? { group: g, items: [] }
      entry.items.push(row)
      out.set(key, entry)
    }
    return [...out.values()]
  }, [rows, filed, query, searching])

  function onDragOver(e: DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!over) setOver(true)
  }
  function onDrop(e: DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
    e.preventDefault()
    setOver(false)
    const key = e.dataTransfer.getData(SESSION_DRAG_TYPE)
    if (!key) return
    if (filed.unfiled.some((r) => r.key === key)) return
    move(key, null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      {searching ? null : (
        <ProjectFolders
          projects={projectsState.projects}
          filed={filed}
          loading={projectsState.loading}
        />
      )}
      <div
        className="mac-section proj-unfiled flex items-center justify-between"
        data-drop={over}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span>{over ? t('projects.unfiled.drop') : t('sidebar.sessions')}</span>
        <button
          type="button"
          className="text-dim hover:text-foreground"
          aria-label={t('sidebar.filter')}
          title={t('sidebar.filter')}
        >
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {loading ? (
        <p className="px-2.5 py-1 text-[11.5px] text-dim">{t('sidebar.sessions.loading')}</p>
      ) : null}
      {error ? <p className="px-2.5 py-1 text-[11.5px] text-danger">{error}</p> : null}
      {!loading && !error && groups.length === 0 ? (
        <p className="px-2.5 py-1 text-[11.5px] text-dim">{t('sidebar.sessions.empty')}</p>
      ) : null}
      {groups.map(({ group, items }, i) => (
        <div key={groupKey(group)}>
          {i === 0 && group.kind !== 'month' ? null : (
            <div className="mac-divider">{groupLabel(group)}</div>
          )}
          {items.map((row) => (
            <SessionRowLink key={row.key} row={row} />
          ))}
        </div>
      ))}
    </div>
  )
}
