import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRpc } from '@/app/providers'
import { useConnection } from '@/stores/connection'
import type { AppInfo } from '@shared/app'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { formatUptime } from '../logic'
import { Card, Head, Notice, Row, Value } from '../parts'

const REPO = 'https://github.com/use-agent-os/agent-os'
const LINKS = [
  { label: 'settings.about.github', url: REPO },
  { label: 'settings.about.releases', url: `${REPO}/releases` },
  { label: 'settings.about.issues', url: `${REPO}/issues/new` },
] as const

interface StatusResult {
  version?: string
  uptime_ms?: number
  provider?: string | null
  active_sessions?: number
}
interface UpdateResult {
  current?: string
  latest?: string | null
  status?: 'up-to-date' | 'outdated' | 'offline'
}

export function AboutPane() {
  const rpc = useRpc()
  const connected = useConnection((s) => s.state === 'connected')
  const [info, setInfo] = useState<AppInfo | null>(null)

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

  const status = useQuery({
    queryKey: ['settings', 'status'],
    enabled: connected,
    refetchInterval: 30_000,
    queryFn: () => rpc.call<StatusResult>('status'),
  })
  const updates = useMutation({
    mutationFn: () => rpc.call<UpdateResult>('updates.check'),
  })

  const open = (url: string) => void desktopApi().app.openExternal(url)

  return (
    <>
      <Head title={t('settings.section.about')} />
      <div className="stg-hero">
        <div className="stg-hero__mark" aria-hidden>
          <span className="font-display text-2xl font-[640] tracking-tight">A</span>
        </div>
        <div>
          <div className="stg-hero__name">{t('settings.about.app')}</div>
          <div className="stg-hero__meta">
            {t('settings.about.version')} {info?.version ?? '…'}
            {info && !info.packaged ? ` · ${t('settings.about.dev')}` : ''}
            {' · '}
            {t('settings.about.license')}
          </div>
        </div>
      </div>

      <Card
        title={t('settings.about.gateway')}
        action={
          <Button disabled={!connected || updates.isPending} onClick={() => updates.mutate()}>
            {updates.isPending ? (
              <>
                <LoaderCircle className="stg-spin size-3.5" strokeWidth={1.75} aria-hidden />
                {t('settings.about.checking')}
              </>
            ) : (
              t('settings.about.check')
            )}
          </Button>
        }
      >
        <Row label={t('settings.about.gatewayVersion')}>
          <Value>{connected ? (status.data?.version ?? '…') : '—'}</Value>
        </Row>
        <Row label={t('settings.about.uptime')}>
          <Value>{connected && status.data ? formatUptime(status.data.uptime_ms ?? 0) : '—'}</Value>
        </Row>
        <Row label={t('settings.about.sessions')}>
          <Value>{connected && status.data ? String(status.data.active_sessions ?? 0) : '—'}</Value>
        </Row>
      </Card>

      {updates.data ? (
        updates.data.status === 'outdated' ? (
          <Notice
            action={
              <Button onClick={() => open(`${REPO}/releases`)}>
                {t('settings.about.releases')}
              </Button>
            }
          >
            {t('settings.about.outdated')} <b>{updates.data.latest}</b>.{' '}
            {t('settings.about.howToUpdate')}
          </Notice>
        ) : updates.data.status === 'up-to-date' ? (
          <Notice tone="ok">{t('settings.about.upToDate')}</Notice>
        ) : (
          <Notice tone="info">{t('settings.about.offline')}</Notice>
        )
      ) : updates.isError ? (
        <Notice tone="info">{t('settings.about.offline')}</Notice>
      ) : null}

      <Card title={t('settings.about.runtime')}>
        <Row label={t('settings.about.electron')}>
          <Value>{info?.electron || '—'}</Value>
        </Row>
        <Row label={t('settings.about.chrome')}>
          <Value>{info?.chrome || '—'}</Value>
        </Row>
      </Card>

      <Card title={t('settings.about.links')}>
        {LINKS.map((link) => (
          <Row key={link.url} label={t(link.label)}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(link.label)}
              title={link.url}
              onClick={() => open(link.url)}
            >
              <ExternalLink
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden
              />
            </Button>
          </Row>
        ))}
      </Card>
    </>
  )
}
