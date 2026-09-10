import './settings.css'
import {
  Bell,
  Cpu,
  Info,
  Keyboard,
  Palette,
  Search,
  Server,
  SlidersHorizontal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { ModalShell } from '@/components/ModalShell'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useSettings } from '~/stores/settings'
import { SETTINGS_SECTIONS, useUi, type SettingsSection } from '~/stores/ui'
import { AboutPane } from './panes/AboutPane'
import { AdvancedPane } from './panes/AdvancedPane'
import { AppearancePane } from './panes/AppearancePane'
import { GatewayPane } from './panes/GatewayPane'
import { GeneralPane } from './panes/GeneralPane'
import { ModelsPane } from './panes/ModelsPane'
import { NotificationsPane } from './panes/NotificationsPane'
import { ShortcutsPane } from './panes/ShortcutsPane'
import { filterSections } from './logic'

const ICON: Record<SettingsSection, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  gateway: Server,
  models: Cpu,
  notifications: Bell,
  shortcuts: Keyboard,
  advanced: Wrench,
  about: Info,
}

const PANE: Record<SettingsSection, () => React.JSX.Element> = {
  general: GeneralPane,
  appearance: AppearancePane,
  gateway: GatewayPane,
  models: ModelsPane,
  notifications: NotificationsPane,
  shortcuts: ShortcutsPane,
  advanced: AdvancedPane,
  about: AboutPane,
}

/**
 * Settings as a sheet over the window (System Settings posture): a source
 * list of panes on the left, the selected pane on the right. Opened from the
 * toolbar gear, ⌘, or the app menu; Escape or the close button leaves. It
 * reads the `settingsOpen` flag from the UI store.
 */
export function SettingsPanel() {
  const open = useUi((s) => s.settingsOpen)
  const close = useUi((s) => s.closeSettings)
  const titleId = useId()
  if (!open) return null
  return (
    <ModalShell
      role="dialog"
      labelledBy={titleId}
      onClose={close}
      overlayClassName="prefs__overlay"
      className="prefs"
    >
      <SettingsBody titleId={titleId} onClose={close} />
    </ModalShell>
  )
}

function SettingsBody({ titleId, onClose }: { titleId: string; onClose: () => void }) {
  const section = useUi((s) => s.settingsSection)
  const setSection = useUi((s) => s.setSettingsSection)
  const load = useSettings((s) => s.load)
  const [query, setQuery] = useState('')

  // Re-read from disk on open: main may have mirrored OS state meanwhile.
  useEffect(() => void load(), [load])

  const sections = useMemo(
    () =>
      SETTINGS_SECTIONS.map((id) => ({
        id,
        title: t(`settings.section.${id}`),
        blurb: t(`settings.section.${id}.blurb`),
      })),
    [],
  )
  const visible = filterSections(sections, query)
  const Pane = PANE[section]

  function onNavKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const i = visible.findIndex((s) => s.id === section)
    if (i < 0 || visible.length === 0) return
    e.preventDefault()
    const next = visible[(i + (e.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length]
    if (next) {
      setSection(next.id)
      document.getElementById(`prefs-nav-${next.id}`)?.focus()
    }
  }

  return (
    <>
      <nav className="prefs-nav" aria-label={t('settings.sections')}>
        <div className="prefs-nav__title">{t('settings.title')}</div>
        <label className="mac-search app-no-drag">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            placeholder={t('settings.search')}
            aria-label={t('settings.search')}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="prefs-nav__list" role="list" onKeyDown={onNavKey}>
          {visible.length === 0 ? (
            <div className="prefs-nav__empty">{t('settings.search.empty')}</div>
          ) : (
            visible.map((s) => {
              const Icon = ICON[s.id]
              return (
                <button
                  key={s.id}
                  id={`prefs-nav-${s.id}`}
                  type="button"
                  role="listitem"
                  className="prefs-nav__item app-no-drag"
                  aria-current={s.id === section ? 'true' : undefined}
                  onClick={() => setSection(s.id)}
                >
                  <span className="prefs-tile" data-tint={s.id} aria-hidden>
                    <Icon className="size-3.5" strokeWidth={2} />
                  </span>
                  <span className="prefs-nav__label">
                    <b>{s.title}</b>
                    <small>{s.blurb}</small>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </nav>
      <div className="prefs-pane">
        <header className="prefs-pane__head">
          <h1 id={titleId}>{t(`settings.section.${section}`)}</h1>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings.close')}
            title={t('settings.close')}
            onClick={onClose}
          >
            <X className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          </Button>
        </header>
        <div className="prefs-pane__body" key={section}>
          <Pane />
        </div>
      </div>
    </>
  )
}
