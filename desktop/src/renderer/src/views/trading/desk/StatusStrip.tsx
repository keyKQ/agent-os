import { LayoutPanelLeft, MessageSquare } from 'lucide-react'
import type { RawJob } from '@/views/cron/logic'
import { t } from '~/i18n'
import { badgeText } from '../logic'
import { missionStatus, statusWord, type StatusWord } from './desk-logic'
import { missionWord } from './MissionControls'

/**
 * A thin strip, not a title bar: missions on the left, one status word in
 * the middle carried by word and colour only, the approvals pin on the
 * right. The pin is null while the count is unknown — never a broken count.
 */
export function StatusStrip({
  missions,
  running,
  sessionPending,
  globalPending,
  streaming,
  deskMode,
  onToggleDesk,
  onOpenApprovals,
}: {
  missions: RawJob[]
  running: ReadonlySet<string>
  sessionPending: number
  /** null while loading or errored. */
  globalPending: number | null
  streaming: boolean
  deskMode: boolean
  onToggleDesk: () => void
  onOpenApprovals: () => void
}) {
  const word: StatusWord = statusWord({
    pendingApprovals: sessionPending,
    streaming,
    missionRunning: missions.some((m) => m.id && running.has(m.id)),
  })
  const shown = missions.slice(0, 2)
  return (
    <div className="trd-strip" data-testid="status-strip">
      <div className="trd-strip__left">
        {shown.map((job) => {
          const s = missionStatus(job, {
            running: Boolean(job.id && running.has(job.id)),
            pendingApprovals: sessionPending,
          })
          return (
            <span key={job.id ?? job.name} className="trd-strip__mission" data-state={s.state}>
              <b>{job.name}</b>
              <span>{missionWord(s.state, s.until)}</span>
            </span>
          )
        })}
        {missions.length > shown.length ? (
          <span className="trd-strip__more">+{missions.length - shown.length}</span>
        ) : null}
      </div>
      <div className="trd-strip__word" data-word={word} data-testid="status-word">
        {t(`trading.strip.${word}`)}
      </div>
      <div className="trd-strip__right">
        {globalPending !== null && globalPending > 0 ? (
          <button
            type="button"
            className="trd-strip__pin app-no-drag"
            onClick={onOpenApprovals}
            data-testid="strip-pin"
          >
            {t('trading.strip.awaiting')} {badgeText(globalPending)}
          </button>
        ) : null}
        <button
          type="button"
          className="trd-strip__toggle app-no-drag"
          onClick={onToggleDesk}
          aria-pressed={deskMode}
          title={deskMode ? t('trading.strip.chat') : t('trading.strip.desk')}
          data-testid="desk-toggle"
        >
          {deskMode ? (
            <MessageSquare className="size-3.5" strokeWidth={1.75} aria-hidden />
          ) : (
            <LayoutPanelLeft className="size-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {deskMode ? t('trading.strip.chat') : t('trading.strip.desk')}
        </button>
      </div>
    </div>
  )
}
