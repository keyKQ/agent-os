import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import { t } from '~/i18n'
import { desktopApi, isDesktop } from '~/lib/desktop-api'
import {
  notificationPermission,
  playChime,
  postNotification,
  requestNotificationPermission,
  type NotifyPermission,
} from '~/lib/notify'
import { useSettings } from '~/stores/settings'
import { SIDEBAR_DEFAULT, useUi } from '~/stores/ui'
import { Card, Head, Notice, Row, Segmented, Value } from '../parts'

export function BehaviourPane() {
  const general = useSettings((s) => s.settings.general)
  const prefs = useSettings((s) => s.settings.notifications)
  const update = useSettings((s) => s.update)
  const sidebarWidth = useUi((s) => s.sidebarWidth)
  const resetSidebarWidth = useUi((s) => s.resetSidebarWidth)
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission)

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

  async function ask() {
    setPermission(await requestNotificationPermission())
  }
  const permissionTone =
    permission === 'granted' ? 'ok' : permission === 'denied' ? 'danger' : undefined

  return (
    <>
      <Head title={t('settings.section.behaviour')} blurb={t('settings.section.behaviour.blurb')} />

      <Card title={t('settings.behaviour.launch')}>
        <Row
          label={t('settings.behaviour.openAtLogin')}
          help={
            loginMismatch
              ? t('settings.behaviour.openAtLogin.unavailable')
              : t('settings.behaviour.openAtLogin.help')
          }
        >
          <Switch
            checked={general.openAtLogin}
            aria-label={t('settings.behaviour.openAtLogin')}
            onCheckedChange={(openAtLogin) => void update({ general: { openAtLogin } })}
          />
        </Row>
        <Row
          label={t('settings.behaviour.launchView')}
          help={t('settings.behaviour.launchView.help')}
        >
          <Segmented
            label={t('settings.behaviour.launchView')}
            value={general.launchView}
            options={[
              { value: 'home', label: t('settings.behaviour.launchView.home') },
              { value: 'last', label: t('settings.behaviour.launchView.last') },
            ]}
            onChange={(launchView) => void update({ general: { launchView } })}
          />
        </Row>
        <Row
          label={t('settings.behaviour.stopGatewayOnQuit')}
          help={t('settings.behaviour.stopGatewayOnQuit.help')}
        >
          <Switch
            checked={general.stopGatewayOnQuit}
            aria-label={t('settings.behaviour.stopGatewayOnQuit')}
            onCheckedChange={(stopGatewayOnQuit) => void update({ general: { stopGatewayOnQuit } })}
          />
        </Row>
      </Card>

      <Card title={t('settings.behaviour.composer')}>
        <Row
          label={t('settings.behaviour.enterToSend')}
          help={
            general.enterToSend
              ? t('settings.behaviour.enterToSend.help.enter')
              : t('settings.behaviour.enterToSend.help.mod')
          }
        >
          <Segmented
            label={t('settings.behaviour.enterToSend')}
            value={general.enterToSend ? 'enter' : 'mod'}
            options={[
              { value: 'enter', label: t('settings.behaviour.enterToSend.enter') },
              { value: 'mod', label: t('settings.behaviour.enterToSend.mod') },
            ]}
            onChange={(v) => void update({ general: { enterToSend: v === 'enter' } })}
          />
        </Row>
        <Row
          label={t('settings.behaviour.sidebarWidth')}
          help={t('settings.behaviour.sidebarWidth.help')}
        >
          <Value>{sidebarWidth} px</Value>
          <Button
            disabled={sidebarWidth === SIDEBAR_DEFAULT}
            onClick={resetSidebarWidth}
            aria-label={`${t('settings.behaviour.sidebarReset')} ${t('settings.behaviour.sidebarWidth')}`}
          >
            {t('settings.behaviour.sidebarReset')}
          </Button>
        </Row>
      </Card>

      <Card
        title={t('settings.behaviour.attention')}
        action={
          permission === 'default' ? (
            <Button onClick={() => void ask()}>{t('settings.behaviour.permission.ask')}</Button>
          ) : (
            <Button
              disabled={permission !== 'granted'}
              onClick={() =>
                postNotification(
                  t('settings.notifications.test.title'),
                  t('settings.notifications.test.body'),
                )
              }
            >
              {t('settings.behaviour.test')}
            </Button>
          )
        }
      >
        <Row label={t('settings.behaviour.sound')} help={t('settings.behaviour.sound.help')}>
          <Button
            onClick={playChime}
            aria-label={`${t('settings.behaviour.sound.preview')} ${t('settings.behaviour.sound')}`}
          >
            {t('settings.behaviour.sound.preview')}
          </Button>
          <Switch
            checked={prefs.sound}
            aria-label={t('settings.behaviour.sound')}
            onCheckedChange={(sound) => void update({ notifications: { sound } })}
          />
        </Row>
        <Row
          label={t('settings.behaviour.replyDone')}
          help={t('settings.behaviour.replyDone.help')}
        >
          <Switch
            checked={prefs.replyDone}
            aria-label={t('settings.behaviour.replyDone')}
            onCheckedChange={(replyDone) => void update({ notifications: { replyDone } })}
          />
        </Row>
        <Row
          label={t('settings.behaviour.approvals')}
          help={t('settings.behaviour.approvals.help')}
        >
          <Switch
            checked={prefs.approvals}
            aria-label={t('settings.behaviour.approvals')}
            onCheckedChange={(approvals) => void update({ notifications: { approvals } })}
          />
        </Row>
        <Row label={t('settings.behaviour.permission')}>
          <Value tone={permissionTone}>{t(`settings.behaviour.permission.${permission}`)}</Value>
        </Row>
      </Card>
      {permission === 'denied' ? (
        <Notice tone="danger">{t('settings.behaviour.permission.denied')}</Notice>
      ) : null}
    </>
  )
}
