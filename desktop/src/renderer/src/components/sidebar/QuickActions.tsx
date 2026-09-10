import { CalendarClock, PenSquare, type LucideIcon } from 'lucide-react'
import { Link, NavLink } from 'react-router'
import { t, type MessageKey } from '~/i18n'

interface Action {
  to: string
  label: MessageKey
  icon: LucideIcon
  shortcut?: readonly string[]
  /** Actions navigate but are never shown as the selected place. */
  action?: boolean
}

export const QUICK_ACTIONS: readonly Action[] = [
  { to: '/sessions', label: 'sidebar.new', icon: PenSquare, shortcut: ['⌘', 'N'], action: true },
  { to: '/jobs', label: 'sidebar.jobs', icon: CalendarClock },
]

/** Fixed destinations above the session list. */
export function QuickActions() {
  return (
    <nav aria-label={t('shell.brand')} className="flex flex-col gap-px px-2">
      {QUICK_ACTIONS.map(({ to, label, icon: Icon, shortcut, action }) => {
        const body = (
          <>
            <Icon
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden
            />
            <span className="flex-1 truncate">{t(label)}</span>
            {shortcut ? (
              <span className="flex gap-0.5" aria-hidden>
                {shortcut.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            ) : null}
          </>
        )
        return action ? (
          <Link key={to} to={to} className="mac-row">
            {body}
          </Link>
        ) : (
          <NavLink key={to} to={to} className="mac-row">
            {body}
          </NavLink>
        )
      })}
    </nav>
  )
}
