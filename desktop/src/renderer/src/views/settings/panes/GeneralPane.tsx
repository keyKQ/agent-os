import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import { t } from '~/i18n'
import { desktopApi, isDesktop } from '~/lib/desktop-api'
import { useSettings } from '~/stores/settings'
import { SIDEBAR_DEFAULT, useUi } from '~/stores/ui'
import { Group, Row, Segmented } from '../parts'

export function GeneralPane() {
  const general = useSettings((s) => s.settings.general)
  const update = useSettings((s) => s.update)
  const sidebarWidth = useUi((s) => s.sidebarWidth)
  const resetSidebarWidth = useUi((s) => s.resetSidebarWidth)

  // The login item is OS state: show what macOS reports, not just the file.
  const [loginItemActual, setLoginItemActual] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void desktopApi()
      .app.loginItem()
      .then((v) => {
        if (!cancelled) setLoginItemActual(v)
      })
    return () => {
      cancelled = true
    }
  }, [general.openAtLogin])
  const loginMismatch =
    isDesktop() && loginItemActual !== null && loginItemActual !== general.openAtLogin

  return (
    <>
      <Group title={t('settings.general.launch')}>
        <Row
          label={t('settings.general.openAtLogin')}
          help={
            loginMismatch
              ? t('settings.general.openAtLogin.unavailable')
              : t('settings.general.openAtLogin.help')
          }
        >
          <Switch
            checked={general.openAtLogin}
            aria-label={t('settings.general.openAtLogin')}
            onCheckedChange={(openAtLogin) => void update({ general: { openAtLogin } })}
          />
        </Row>
        <Row label={t('settings.general.launchView')} help={t('settings.general.launchView.help')}>
          <Segmented
            label={t('settings.general.launchView')}
            value={general.launchView}
            options={[
              { value: 'home', label: t('settings.general.launchView.home') },
              { value: 'last', label: t('settings.general.launchView.last') },
            ]}
            onChange={(launchView) => void update({ general: { launchView } })}
          />
        </Row>
        <Row
          label={t('settings.general.stopGatewayOnQuit')}
          help={t('settings.general.stopGatewayOnQuit.help')}
        >
          <Switch
            checked={general.stopGatewayOnQuit}
            aria-label={t('settings.general.stopGatewayOnQuit')}
            onCheckedChange={(stopGatewayOnQuit) => void update({ general: { stopGatewayOnQuit } })}
          />
        </Row>
      </Group>

      <Group title={t('settings.general.composer')}>
        <Row
          label={t('settings.general.enterToSend')}
          help={
            general.enterToSend
              ? t('settings.general.enterToSend.help.enter')
              : t('settings.general.enterToSend.help.mod')
          }
        >
          <Segmented
            label={t('settings.general.enterToSend')}
            value={general.enterToSend ? 'enter' : 'mod'}
            options={[
              { value: 'enter', label: t('settings.general.enterToSend.enter') },
              { value: 'mod', label: t('settings.general.enterToSend.mod') },
            ]}
            onChange={(v) => void update({ general: { enterToSend: v === 'enter' } })}
          />
        </Row>
      </Group>

      <Group title={t('settings.general.sidebar')}>
        <Row
          label={t('settings.general.sidebarWidth')}
          help={t('settings.general.sidebarWidth.help')}
        >
          <span className="prefs-value">{sidebarWidth} px</span>
          <Button
            disabled={sidebarWidth === SIDEBAR_DEFAULT}
            onClick={resetSidebarWidth}
            aria-label={`${t('settings.general.sidebarReset')} ${t('settings.general.sidebarWidth')}`}
          >
            {t('settings.general.sidebarReset')}
          </Button>
        </Row>
      </Group>
    </>
  )
}
