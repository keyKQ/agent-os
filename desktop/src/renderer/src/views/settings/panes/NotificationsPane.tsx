import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import { t } from '~/i18n'
import {
  notificationPermission,
  playChime,
  postNotification,
  requestNotificationPermission,
  type NotifyPermission,
} from '~/lib/notify'
import { useSettings } from '~/stores/settings'
import { Group, Notice, Row, Value } from '../parts'

export function NotificationsPane() {
  const prefs = useSettings((s) => s.settings.notifications)
  const update = useSettings((s) => s.update)
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission)

  async function ask() {
    setPermission(await requestNotificationPermission())
  }
  function sendTest() {
    postNotification(t('settings.notifications.test.title'), t('settings.notifications.test.body'))
  }

  const permissionTone =
    permission === 'granted' ? 'ok' : permission === 'denied' ? 'danger' : undefined

  return (
    <>
      <Group title={t('settings.notifications.replies')}>
        <Row
          label={t('settings.notifications.sound')}
          help={t('settings.notifications.sound.help')}
        >
          <Button
            onClick={playChime}
            aria-label={`${t('settings.notifications.preview')} ${t('settings.notifications.sound')}`}
          >
            {t('settings.notifications.preview')}
          </Button>
          <Switch
            checked={prefs.sound}
            aria-label={t('settings.notifications.sound')}
            onCheckedChange={(sound) => void update({ notifications: { sound } })}
          />
        </Row>
        <Row
          label={t('settings.notifications.replyDone')}
          help={t('settings.notifications.replyDone.help')}
        >
          <Switch
            checked={prefs.replyDone}
            aria-label={t('settings.notifications.replyDone')}
            onCheckedChange={(replyDone) => void update({ notifications: { replyDone } })}
          />
        </Row>
      </Group>

      <Group title={t('settings.notifications.approvals')}>
        <Row
          label={t('settings.notifications.approvalsToggle')}
          help={t('settings.notifications.approvalsToggle.help')}
        >
          <Switch
            checked={prefs.approvals}
            aria-label={t('settings.notifications.approvalsToggle')}
            onCheckedChange={(approvals) => void update({ notifications: { approvals } })}
          />
        </Row>
      </Group>

      <Group
        title={t('settings.notifications.permission')}
        after={
          permission === 'denied' ? (
            <Notice tone="danger">{t('settings.notifications.permission.denied')}</Notice>
          ) : null
        }
      >
        <Row label={t('settings.notifications.permission')}>
          <Value tone={permissionTone}>
            {t(`settings.notifications.permission.${permission}`)}
          </Value>
          {permission === 'default' ? (
            <Button variant="primary" onClick={() => void ask()}>
              {t('settings.notifications.permission.ask')}
            </Button>
          ) : null}
          <Button disabled={permission !== 'granted'} onClick={sendTest}>
            {t('settings.notifications.test')}
          </Button>
        </Row>
      </Group>
    </>
  )
}
