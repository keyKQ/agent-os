import './settings.css'
import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useSettings } from '~/stores/settings'
import { useUi } from '~/stores/ui'
import { AboutPane } from './panes/AboutPane'
import { AdvancedPane } from './panes/AdvancedPane'
import { AppearancePane } from './panes/AppearancePane'
import { BehaviourPane } from './panes/BehaviourPane'
import { GatewayPane } from './panes/GatewayPane'
import { ModelsPane } from './panes/ModelsPane'
import { RouterPane } from './panes/RouterPane'
import { ShortcutsPane } from './panes/ShortcutsPane'
import {
  DEFAULT_SECTION,
  isSettingsSection,
  SETTINGS_GROUPS,
  settingsPath,
  type SettingsSection,
} from './sections'

const PANE: Record<SettingsSection, () => React.JSX.Element> = {
  models: ModelsPane,
  router: RouterPane,
  gateway: GatewayPane,
  appearance: AppearancePane,
  behaviour: BehaviourPane,
  shortcuts: ShortcutsPane,
  advanced: AdvancedPane,
  about: AboutPane,
}

/**
 * Settings as a page in the content column (`/settings/:section?`): a rail
 * of sections on the left, the chosen one on the right. "Done" returns to
 * wherever the user came from (AppShell records it when settings opens).
 */
export function SettingsPage() {
  const { section: param } = useParams()
  const navigate = useNavigate()
  const section: SettingsSection = isSettingsSection(param) ? param : DEFAULT_SECTION
  const load = useSettings((s) => s.load)
  const returnTo = useUi((s) => s.settingsReturnTo)

  // Re-read from disk on entry: main may have mirrored OS state meanwhile.
  useEffect(() => void load(), [load])

  const Pane = PANE[section]

  function onRailKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = SETTINGS_GROUPS.flatMap((g) => g.sections)
    const i = all.indexOf(section)
    if (i < 0) return
    e.preventDefault()
    const next = all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]
    if (next) {
      void navigate(settingsPath(next), { replace: true })
      document.getElementById(`stg-rail-${next}`)?.focus()
    }
  }

  return (
    <div className="stg">
      <div className="stg-bar">
        <span className="stg-bar__title">{t('settings.title')}</span>
        <Button variant="primary" onClick={() => void navigate(returnTo || '/sessions')}>
          {t('settings.done')}
        </Button>
      </div>
      <div className="stg-body">
        <nav className="stg-rail" aria-label={t('settings.sections')} onKeyDown={onRailKey}>
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.id} className="stg-rail__group">
              <div className="stg-rail__label">{t(`settings.group.${group.id}`)}</div>
              {group.sections.map((id) => (
                <button
                  key={id}
                  id={`stg-rail-${id}`}
                  type="button"
                  className="stg-rail__item app-no-drag"
                  aria-current={id === section ? 'page' : undefined}
                  onClick={() => void navigate(settingsPath(id), { replace: true })}
                >
                  {t(`settings.section.${id}`)}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="stg-main">
          <div className="stg-section" key={section}>
            <Pane />
          </div>
        </div>
      </div>
    </div>
  )
}
