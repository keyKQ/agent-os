import { LayoutPanelLeft, PanelRight, Settings, Volume2, VolumeX } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useSettings } from '~/stores/settings'
import { useUi } from '~/stores/ui'
import { ThemeToggle } from '~/theme/ThemeToggle'

/**
 * Content-column toolbar. Left side stays empty on purpose (the wordmark or
 * the session title below carries identity); right side holds window-level
 * controls, the way Mail and Notes do.
 */
export function Toolbar() {
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const openSettings = useUi((s) => s.openSettings)
  const sound = useSettings((s) => s.settings.notifications.sound)
  const update = useSettings((s) => s.update)
  const soundLabel = sound ? t('toolbar.sound.on') : t('toolbar.sound.off')

  return (
    <header
      className="app-drag flex shrink-0 items-center justify-between px-3"
      style={{
        height: 'var(--toolbar-height)',
        zIndex: 'var(--z-toolbar)',
        paddingLeft: sidebarOpen ? undefined : 82,
      }}
    >
      <div className="app-no-drag">
        {!sidebarOpen ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('sidebar.collapse')}
            onClick={toggleSidebar}
          >
            <LayoutPanelLeft
              className="size-4 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
      <div className="app-no-drag flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('sidebar.collapse')}
          title={t('sidebar.collapse')}
          onClick={toggleSidebar}
        >
          <LayoutPanelLeft
            className="size-4 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={soundLabel}
          title={soundLabel}
          aria-pressed={sound}
          onClick={() => void update({ notifications: { sound: !sound } })}
        >
          {sound ? (
            <Volume2 className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          ) : (
            <VolumeX className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          )}
        </Button>
        <ThemeToggle />
        <Button
          variant={settingsOpen ? 'secondary' : 'ghost'}
          size="icon"
          aria-label={t('toolbar.settings')}
          title={`${t('toolbar.settings')} (⌘,)`}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => openSettings()}
        >
          <Settings className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('toolbar.inspector')}
          title={t('toolbar.inspector')}
        >
          <PanelRight className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </Button>
      </div>
    </header>
  )
}
