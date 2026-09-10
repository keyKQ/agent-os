import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { useConnection } from '@/stores/connection'
import { Switch } from '~/components/ui/switch'
import { t } from '~/i18n'
import {
  isThinkingLevel,
  modelOptions,
  routerTiers,
  THINKING_LEVELS,
  type CatalogModel,
} from '../logic'
import { Group, Notice, Row, Value } from '../parts'

interface GatewayConfig {
  llm?: { provider?: string; model?: string; thinking?: string | null }
  agentos_router?: { enabled?: boolean; tiers?: unknown }
}
interface StatusResult {
  provider?: string | null
  version?: string
}
interface SetResult {
  restartRequired?: boolean
}

const CONFIG_KEY = ['prefs', 'config'] as const
const MODELS_KEY = ['prefs', 'models'] as const
const STATUS_KEY = ['prefs', 'status'] as const

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The gateway's model posture, read over the same RPCs the web console uses
 * (`config.get`, `models.list`, `config.set`). The default model and thinking
 * level are the two knobs a person changes often; providers, keys and tier
 * tuning stay in the console, which has the room for them.
 */
export function ModelsPane() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  const connected = useConnection((s) => s.state === 'connected')

  const configQuery = useQuery({
    queryKey: CONFIG_KEY,
    enabled: connected,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<GatewayConfig>('config.get')
    },
  })
  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    enabled: connected,
    queryFn: () => rpc.call<StatusResult>('status'),
  })
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    enabled: connected,
    staleTime: 60_000,
    queryFn: () => rpc.call<CatalogModel[]>('models.list'),
  })

  const setValue = useMutation({
    mutationFn: ({ path, value }: { path: string; value: unknown }) =>
      rpc.call<SetResult>('config.set', { path, value }),
    onSuccess: (res) => {
      toast.success(
        res?.restartRequired ? t('settings.models.restartRequired') : t('settings.models.saved'),
        { id: 'prefs-models' },
      )
      void queryClient.invalidateQueries({ queryKey: CONFIG_KEY })
    },
    onError: (err) =>
      toast.error(`${t('settings.models.saveFailed')}: ${errorText(err)}`, {
        id: 'prefs-models-err',
      }),
  })

  if (!connected) {
    return <Notice tone="info">{t('settings.offline')}</Notice>
  }
  if (configQuery.isError) {
    return <Notice tone="danger">{t('settings.models.loadFailed')}</Notice>
  }
  const cfg = configQuery.data
  if (!cfg) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle className="prefs-spin size-3.5" strokeWidth={1.75} aria-hidden />
        {t('settings.loading')}
      </div>
    )
  }

  const provider = statusQuery.data?.provider || cfg.llm?.provider || ''
  const model = cfg.llm?.model || ''
  const thinking = isThinkingLevel(cfg.llm?.thinking) ? cfg.llm.thinking : ''
  const options = modelOptions(modelsQuery.data ?? [], provider, model)
  const routerOn = cfg.agentos_router?.enabled !== false
  const tiers = routerTiers(cfg.agentos_router?.tiers)
  const busy = setValue.isPending

  return (
    <>
      <Group title={t('settings.models.active')}>
        <Row label={t('settings.models.provider')}>
          <Value>{provider || '—'}</Value>
        </Row>
        <Row label={t('settings.models.model')} help={t('settings.models.model.help')}>
          <select
            className="mac-select"
            aria-label={t('settings.models.model')}
            value={model}
            disabled={busy || modelsQuery.isPending}
            onChange={(e) => setValue.mutate({ path: 'llm.model', value: e.target.value })}
          >
            {options.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.custom ? `${opt.label}  (${t('settings.models.model.custom')})` : opt.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('settings.models.thinking')} help={t('settings.models.thinking.help')}>
          <select
            className="mac-select"
            data-compact="true"
            aria-label={t('settings.models.thinking')}
            value={thinking}
            disabled={busy}
            onChange={(e) =>
              setValue.mutate({ path: 'llm.thinking', value: e.target.value || null })
            }
          >
            <option value="">{t('settings.models.thinking.auto')}</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`settings.models.thinking.${level}`)}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title={t('settings.models.router')}>
        <Row
          label={t('settings.models.router.enabled')}
          help={t('settings.models.router.enabled.help')}
        >
          <Switch
            checked={routerOn}
            disabled={busy}
            aria-label={t('settings.models.router.enabled')}
            onCheckedChange={(enabled) =>
              setValue.mutate({ path: 'agentos_router.enabled', value: enabled })
            }
          />
        </Row>
        <Row label={t('settings.models.router.tiers')} align="start" wide>
          {tiers.length === 0 ? (
            <Value>{t('settings.models.router.tiers.none')}</Value>
          ) : (
            <div className="prefs-tiers">
              {tiers.map((row) => (
                <div key={row.tier} className="prefs-tier">
                  <b>{row.tier}</b>
                  <Value>{row.model}</Value>
                </div>
              ))}
            </div>
          )}
        </Row>
      </Group>

      <p className="prefs-pane__foot">{t('settings.models.moreInConsole')}</p>
    </>
  )
}
