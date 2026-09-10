import { t, type MessageKey } from '~/i18n'
import { useSettings } from '~/stores/settings'
import { Group } from '../parts'

interface Shortcut {
  keys: readonly string[]
  label: MessageKey
}

const APP: readonly Shortcut[] = [
  { keys: ['⌘', 'N'], label: 'settings.shortcuts.newSession' },
  { keys: ['⌘', ','], label: 'settings.shortcuts.settings' },
  { keys: ['⌘', '⇧', 'S'], label: 'settings.shortcuts.toggleSidebar' },
  { keys: ['esc'], label: 'settings.shortcuts.closeSheet' },
]

const CHAT: readonly Shortcut[] = [
  { keys: ['⌘', '⇧', 'O'], label: 'settings.shortcuts.newChat' },
  { keys: ['esc'], label: 'settings.shortcuts.abort' },
  { keys: ['⌘', 'S'], label: 'settings.shortcuts.saveBrief' },
]

/** The keys the app answers to. Static on purpose: nothing here is rebindable. */
export function ShortcutsPane() {
  const enterToSend = useSettings((s) => s.settings.general.enterToSend)
  const composer: readonly Shortcut[] = [
    enterToSend
      ? { keys: ['↩'], label: 'settings.shortcuts.send' }
      : { keys: ['⌘', '↩'], label: 'settings.shortcuts.send' },
    enterToSend
      ? { keys: ['⇧', '↩'], label: 'settings.shortcuts.newline' }
      : { keys: ['↩'], label: 'settings.shortcuts.newline' },
    { keys: ['↑', '↓'], label: 'settings.shortcuts.history' },
    { keys: ['/'], label: 'settings.shortcuts.slash' },
  ]

  return (
    <>
      <KeyGroup title={t('settings.shortcuts.app')} rows={APP} />
      <KeyGroup title={t('settings.shortcuts.chat')} rows={CHAT} />
      <KeyGroup title={t('settings.shortcuts.composer')} rows={composer} />
    </>
  )
}

function KeyGroup({ title, rows }: { title: string; rows: readonly Shortcut[] }) {
  return (
    <Group title={title}>
      <div className="prefs-keys">
        {rows.map((row) => (
          <div key={row.label} className="prefs-keys__row">
            <span>{t(row.label)}</span>
            <span className="prefs-keys__combo" aria-label={row.keys.join(' ')}>
              {row.keys.map((k, i) => (
                <kbd key={`${k}-${i}`} className="kbd">
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Group>
  )
}
