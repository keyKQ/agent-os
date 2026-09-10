import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { ModalShell } from '@/components/ModalShell'
import { useConnection } from '@/stores/connection'
import type { AppInfo } from '@shared/app'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi, isDesktop } from '~/lib/desktop-api'
import { useGateway } from '~/stores/gateway'
import { useSettings } from '~/stores/settings'
import { syncThemeFromSettings } from '~/theme/theme-store'
import { diagnosticsReport } from '../logic'
import { Group, Row } from '../parts'

interface Snapshot {
  configPath?: string
}
interface StatusResult {
  version?: string
}

export function AdvancedPane() {
  const rpc = useRpc()
  const connected = useConnection((s) => s.state === 'connected')
  const settings = useSettings((s) => s.settings)
  const reset = useSettings((s) => s.reset)
  const gateway = useGateway((s) => s.status)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    void desktopApi()
      .app.info()
      .then((i) => {
        if (!cancelled) setInfo(i)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const snapshot = useQuery({
    queryKey: ['prefs', 'snapshot'],
    enabled: connected,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<Snapshot>('config.snapshot')
    },
  })
  const status = useQuery({
    queryKey: ['prefs', 'status'],
    enabled: connected,
    queryFn: () => rpc.call<StatusResult>('status'),
  })
  const configPath = snapshot.data?.configPath ?? null
  const desktop = isDesktop()

  async function copyDiagnostics() {
    const text = diagnosticsReport({
      info,
      gateway,
      settings,
      gatewayVersion: status.data?.version ?? null,
      configPath,
    })
    await navigator.clipboard?.writeText(text)
    toast.success(t('settings.copied'), { id: 'prefs-copy' })
  }

  async function doReset() {
    await reset()
    await syncThemeFromSettings(useSettings.getState().settings.theme)
    setConfirming(false)
    toast.success(t('settings.advanced.resetDone'), { id: 'prefs-reset' })
  }

  return (
    <>
      <Group title={t('settings.advanced.files')}>
        <Row
          label={t('settings.advanced.settingsFile')}
          help={<code className="prefs-path">{info?.paths.settings ?? '…'}</code>}
        >
          <Button
            disabled={!desktop || !info}
            onClick={() => info && void desktopApi().app.showItemInFolder(info.paths.settings)}
          >
            {t('settings.reveal')}
          </Button>
        </Row>
        <Row
          label={t('settings.advanced.logs')}
          help={<code className="prefs-path">{info?.paths.logs ?? '…'}</code>}
        >
          <Button
            disabled={!desktop || !info}
            onClick={() => info && void desktopApi().app.openPath(info.paths.logs)}
          >
            {t('settings.open')}
          </Button>
        </Row>
        <Row
          label={t('settings.advanced.gatewayConfig')}
          help={
            <>
              <code className="prefs-path">
                {configPath ?? t('settings.advanced.gatewayConfig.unknown')}
              </code>
              <span>{t('settings.advanced.gatewayConfig.help')}</span>
            </>
          }
        >
          <Button
            disabled={!desktop || !configPath}
            onClick={() => configPath && void desktopApi().app.showItemInFolder(configPath)}
          >
            {t('settings.reveal')}
          </Button>
          <Button
            disabled={!desktop || !configPath}
            onClick={() => configPath && void desktopApi().app.openPath(configPath)}
          >
            {t('settings.open')}
          </Button>
        </Row>
      </Group>

      <Group title={t('settings.advanced.diagnostics')}>
        <Row
          label={t('settings.advanced.copyDiagnostics')}
          help={t('settings.advanced.copyDiagnostics.help')}
        >
          <Button onClick={() => void copyDiagnostics()}>{t('settings.copy')}</Button>
        </Row>
      </Group>

      <Group title={t('settings.advanced.reset')}>
        <Row label={t('settings.advanced.resetAll')} help={t('settings.advanced.resetAll.help')}>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('settings.advanced.resetConfirm.confirm')}
          </Button>
        </Row>
      </Group>

      {confirming ? (
        <ResetConfirm onCancel={() => setConfirming(false)} onConfirm={() => void doReset()} />
      ) : null}
    </>
  )
}

function ResetConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId()
  const bodyId = useId()
  return (
    <ModalShell
      role="alertdialog"
      labelledBy={titleId}
      describedBy={bodyId}
      onClose={onCancel}
      overlayClassName="prefs-confirm__overlay"
      className="prefs-confirm"
    >
      <h2 id={titleId}>{t('settings.advanced.resetConfirm.title')}</h2>
      <p id={bodyId}>{t('settings.advanced.resetConfirm.body')}</p>
      <div className="prefs-confirm__actions">
        <Button onClick={onCancel}>{t('settings.advanced.resetConfirm.cancel')}</Button>
        <Button variant="danger" onClick={onConfirm}>
          {t('settings.advanced.resetConfirm.confirm')}
        </Button>
      </div>
    </ModalShell>
  )
}
