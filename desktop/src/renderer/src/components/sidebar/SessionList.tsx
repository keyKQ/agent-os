import { SlidersHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { NavLink } from 'react-router'
import { filterSessions } from '@/views/sessions/logic'
import { t } from '~/i18n'
import { dateGroup, groupKey, shortAge, type DateGroup } from '~/lib/relative-time'
import { useLive } from '~/stores/live'
import { toSessionRow, useSessions, type SessionRow } from '~/stores/sessions'
import { useUi } from '~/stores/ui'

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

/** Route path for a session; keys carry colons, so they are encoded once. */
export function sessionPath(key: string): string {
  return `/sessions/${encodeURIComponent(key)}`
}

/** Gateway sessions grouped by day/week/month with a short age. */
export function SessionList() {
  const query = useUi((s) => s.sessionQuery)
  const { rows, loading, error } = useSessions()

  const groups = useMemo(() => {
    const visible = query.trim()
      ? filterSessions(
          rows.map((r) => r.raw),
          query,
        ).map(toSessionRow)
      : rows
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
  }, [rows, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <div className="mac-section flex items-center justify-between">
        <span>{t('sidebar.sessions')}</span>
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

function SessionRowLink({ row }: { row: SessionRow }) {
  const liveLocally = useLive((s) => s.ids.has(row.key))
  return (
    <NavLink to={sessionPath(row.key)} className="mac-session" title={row.title}>
      <span className="mac-session-dot" data-live={row.live || liveLocally} aria-hidden />
      <span className="mac-session-title">{row.title}</span>
      <span className="mac-session-age">{row.updatedAt ? shortAge(row.updatedAt) : ''}</span>
    </NavLink>
  )
}
