import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The vocabulary every pane is written in: a titled group of rows, a row
 * with a label column and a control column, a segmented control, and an
 * inline notice. Visuals live in settings.css and tokens.css (.mac-group).
 */

export function Group({
  title,
  children,
  after,
}: {
  title: string
  children: ReactNode
  /** Rendered under the group box: notices, save bars. */
  after?: ReactNode
}) {
  return (
    <section aria-label={title}>
      <h2 className="mac-group-title">{title}</h2>
      <div className="mac-group">{children}</div>
      {after}
    </section>
  )
}

export function Row({
  label,
  help,
  children,
  align,
  wide,
  htmlFor,
}: {
  label: string
  help?: ReactNode
  children?: ReactNode
  align?: 'start'
  /** Control column takes the remaining width (long text fields). */
  wide?: boolean
  htmlFor?: string
}) {
  const Label = htmlFor ? 'label' : 'span'
  return (
    <div className="prefs-row" data-align={align}>
      <div className="prefs-row__label">
        <Label htmlFor={htmlFor}>{label}</Label>
        {help ? <span className="mac-help">{help}</span> : null}
      </div>
      {children !== undefined ? (
        <div className="prefs-row__control" data-wide={wide ? 'true' : undefined}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="mac-segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className="mac-segment app-no-drag"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

const NOTICE_ICON = {
  warn: AlertTriangle,
  ok: CheckCircle2,
  danger: XCircle,
  info: Info,
} as const

export function Notice({
  tone = 'warn',
  children,
  action,
}: {
  tone?: keyof typeof NOTICE_ICON
  children: ReactNode
  action?: ReactNode
}) {
  const Icon = NOTICE_ICON[tone]
  return (
    <div className="prefs-notice" data-tone={tone} role="status">
      <Icon className="size-3.5" strokeWidth={2} aria-hidden />
      <span>{children}</span>
      {action}
    </div>
  )
}

/** Machine value in a row: a path, a URL, a version. */
export function Value({
  children,
  tone,
  title,
}: {
  children: ReactNode
  tone?: 'ok' | 'warn' | 'danger'
  title?: string
}) {
  return (
    <span className="prefs-value" data-tone={tone} title={title}>
      {children}
    </span>
  )
}
