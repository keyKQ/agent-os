import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { configuredProvider, type ProviderSpec, type SetupConfig } from '@/views/setup/logic'
import type { SettingsSnapshot } from '@/views/settings/snapshot'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useGateway } from '~/stores/gateway'
import {
  isThinkingLevel,
  modelOptions,
  providerConfigurePayload,
  providerDirty,
  providerDraft,
  providerNeedsKey,
  THINKING_LEVELS,
  type CatalogModel,
  type ProviderDraft,
} from '../logic'
import { Card, Head, Notice, Pill, Row, Value } from '../parts'
import { useConfigSnapshot, withRevision } from '../use-snapshot'

interface ConfigureResult {
  restartRequired?: boolean
  warnings?: string[]
}
interface SetResult {
  restartRequired?: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Provider and default model, written through the same guided RPCs the web
 * console's setup uses (`onboarding.provider.configure`, `config.set`), with
 * the snapshot revision on every write.
 */
export function ModelsPane() {
  const { connected, query, snapshot, reload } = useConfigSnapshot()

  return (
    <>
      <Head title={t('settings.section.models')} blurb={t('settings.section.models.blurb')} />
      {!connected ? (
        <Notice tone="info">{t('settings.offline')}</Notice>
      ) : query.isError ? (
        <Notice tone="danger">{t('settings.loadFailed')}</Notice>
      ) : !snapshot ? (
        <Loading />
      ) : (
        <ModelsBody snapshot={snapshot} reload={reload} />
      )}
    </>
  )
}

function Loading() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <LoaderCircle className="stg-spin size-3.5" strokeWidth={1.75} aria-hidden />
      {t('settings.loading')}
    </div>
  )
}

function ModelsBody({
  snapshot,
  reload,
}: {
  snapshot: SettingsSnapshot
  reload: () => Promise<void>
}) {
  const rpc = useRpc()
  const config: SetupConfig = snapshot.config ?? {}
  const providers = (snapshot.catalog?.providers ?? []).filter((p) => p.runtimeSupported)
  const configured = configuredProvider(snapshot.status ?? {}, config)
  const restartGateway = useGateway((s) => s.restart)

  const save = useMutation({
    mutationFn: (draft: ProviderDraft) =>
      rpc.call<ConfigureResult>(
        'onboarding.provider.configure',
        withRevision(snapshot, providerConfigurePayload(draft)),
      ),
    onSuccess: async (res) => {
      for (const w of res?.warnings ?? []) toast.warning(w)
      toast.success(
        res?.restartRequired ? t('settings.restartRequired') : t('settings.models.saved'),
        { id: 'stg-provider' },
      )
      await reload()
    },
    onError: (err) =>
      toast.error(`${t('settings.saveFailed')}: ${errorText(err)}`, { id: 'stg-provider-err' }),
  })

  const setThinking = useMutation({
    mutationFn: (value: string | null) =>
      rpc.call<SetResult>('config.set', withRevision(snapshot, { path: 'llm.thinking', value })),
    onSuccess: async (res) => {
      toast.success(res?.restartRequired ? t('settings.restartRequired') : t('settings.saved'), {
        id: 'stg-thinking',
      })
      await reload()
    },
    onError: (err) =>
      toast.error(`${t('settings.saveFailed')}: ${errorText(err)}`, { id: 'stg-thinking-err' }),
  })

  const thinking = isThinkingLevel(config.llm?.thinking) ? config.llm.thinking : ''

  return (
    <>
      {snapshot.writeBlocked ? (
        <Notice tone="danger">{t('settings.writeBlocked')}</Notice>
      ) : snapshot.pendingRestart ? (
        <Notice
          action={
            <Button onClick={() => void restartGateway()}>{t('settings.restartGateway')}</Button>
          }
        >
          {t('settings.pendingRestart')}
        </Notice>
      ) : null}

      {/* Keyed on the saved provider + revision so a save re-seeds the form. */}
      <ProviderCard
        key={`${configured}:${snapshot.revision ?? ''}`}
        config={config}
        providers={providers}
        configured={configured}
        keyDetail={snapshot.status?.sectionDetails?.llm?.detail}
        saving={save.isPending}
        disabled={Boolean(snapshot.writeBlocked)}
        onSave={(draft) => save.mutate(draft)}
      />

      <Card title={t('settings.models.thinking')} blurb={t('settings.models.thinking.help')}>
        <Row label={t('settings.models.thinking')}>
          <select
            className="mac-select"
            data-compact="true"
            aria-label={t('settings.models.thinking')}
            value={thinking}
            disabled={setThinking.isPending || Boolean(snapshot.writeBlocked)}
            onChange={(e) => setThinking.mutate(e.target.value || null)}
          >
            <option value="">{t('settings.models.thinking.auto')}</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`settings.models.thinking.${level}`)}
              </option>
            ))}
          </select>
        </Row>
      </Card>
    </>
  )
}

function ProviderCard({
  config,
  providers,
  configured,
  keyDetail,
  saving,
  disabled,
  onSave,
}: {
  config: SetupConfig
  providers: ProviderSpec[]
  configured: string
  keyDetail?: string
  saving: boolean
  disabled: boolean
  onSave: (draft: ProviderDraft) => void
}) {
  const rpc = useRpc()
  const ids = { provider: useId(), key: useId(), env: useId(), url: useId(), proxy: useId() }
  const specFor = (id: string) => providers.find((p) => p.providerId === id)
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    providerDraft(config, specFor(configured)),
  )
  const [showKey, setShowKey] = useState(false)
  const spec = specFor(draft.providerId)
  const saved = providerDraft(config, specFor(configured))
  const dirty = providerDirty(saved, draft)
  const switching = draft.providerId !== configured
  const needsKey = providerNeedsKey(draft, spec, config)
  const own = config.llm?.provider === draft.providerId
  const hasStoredKey = own && Boolean(config.llm?.api_key)
  const hasEnvKey = own && Boolean(config.llm?.api_key_env) && !config.llm?.api_key

  const models = useQuery({
    queryKey: ['settings', 'models', draft.providerId],
    enabled: Boolean(draft.providerId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => rpc.call<CatalogModel[]>('models.list', { provider: draft.providerId }),
  })
  const options = modelOptions(models.data ?? [], draft.providerId, draft.model)

  function pickProvider(id: string) {
    setDraft(providerDraft(config, specFor(id)))
    setShowKey(false)
  }

  const keyHelp = needsKey
    ? t('settings.models.key.missing')
    : hasEnvKey
      ? `${t('settings.models.key.env')} ${keyDetail ?? ''}`.trim()
      : hasStoredKey
        ? t('settings.models.key.saved')
        : undefined

  return (
    <Card
      title={t('settings.models.provider')}
      blurb={t('settings.models.provider.blurb')}
      action={
        spec ? (
          spec.routerSupported ? (
            <Pill tone="ok">{t('settings.models.provider.routerOk')}</Pill>
          ) : (
            <Pill>{t('settings.models.provider.directOnly')}</Pill>
          )
        ) : null
      }
      footNote={switching ? t('settings.models.switchNote') : undefined}
      foot={
        <>
          <Button
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(saved)
              setShowKey(false)
            }}
          >
            {t('settings.revert')}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || saving || needsKey || disabled || !draft.providerId}
            onClick={() => onSave(draft)}
          >
            {t('settings.save')}
          </Button>
        </>
      }
    >
      <Row label={t('settings.models.provider.pick')} htmlFor={ids.provider}>
        <select
          id={ids.provider}
          className="mac-select"
          value={draft.providerId}
          disabled={disabled}
          onChange={(e) => pickProvider(e.target.value)}
        >
          {!draft.providerId ? <option value="">—</option> : null}
          {providers.map((p) => (
            <option key={p.providerId} value={p.providerId}>
              {p.label ?? p.providerId}
            </option>
          ))}
        </select>
      </Row>

      {spec?.requiresApiKey ? (
        <Row
          label={t('settings.models.key')}
          htmlFor={ids.key}
          help={
            keyHelp ? (
              <span className={needsKey ? 'stg-error' : undefined}>{keyHelp}</span>
            ) : undefined
          }
          align="start"
        >
          <span className="stg-input-wrap">
            <input
              id={ids.key}
              className="mac-input"
              data-mono="true"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                hasStoredKey || hasEnvKey
                  ? t('settings.models.key.placeholder.saved')
                  : t('settings.models.key.placeholder.new')
              }
              value={draft.apiKey}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={showKey ? t('settings.models.key.hide') : t('settings.models.key.show')}
              aria-pressed={showKey}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? (
                <EyeOff className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />
              ) : (
                <Eye className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />
              )}
            </Button>
          </span>
        </Row>
      ) : null}

      <Row
        label={t('settings.models.model')}
        help={
          <>
            <span>{t('settings.models.model.help')}</span>
            {models.data ? (
              <span>
                {models.data.length} {t('settings.models.catalog')}
              </span>
            ) : null}
          </>
        }
        align="start"
      >
        <select
          className="mac-select"
          aria-label={t('settings.models.model')}
          value={draft.model}
          disabled={disabled || models.isPending}
          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
        >
          <option value="">{t('settings.models.model.none')}</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.custom ? `${opt.label}  (${t('settings.models.model.custom')})` : opt.label}
            </option>
          ))}
        </select>
      </Row>

      <details className="stg-details">
        <summary className="stg-row stg-details__summary">
          <span className="stg-row__label">
            <span>{t('settings.models.connection')}</span>
            <span className="stg-row__help">
              <Value>{draft.baseUrl || spec?.defaultBaseUrl || '—'}</Value>
            </span>
          </span>
        </summary>
        <Row label={t('settings.models.baseUrl')} htmlFor={ids.url} stack>
          <input
            id={ids.url}
            className="mac-input"
            data-mono="true"
            autoComplete="off"
            spellCheck={false}
            placeholder={spec?.defaultBaseUrl || ''}
            value={draft.baseUrl}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
          />
        </Row>
        {spec?.requiresApiKey ? (
          <Row
            label={t('settings.models.keyEnv')}
            help={t('settings.models.keyEnv.help')}
            htmlFor={ids.env}
          >
            <input
              id={ids.env}
              className="mac-input"
              data-mono="true"
              autoComplete="off"
              spellCheck={false}
              placeholder={spec.envKey || ''}
              value={draft.apiKeyEnv}
              disabled={disabled || Boolean(draft.apiKey.trim())}
              onChange={(e) => setDraft((d) => ({ ...d, apiKeyEnv: e.target.value }))}
            />
          </Row>
        ) : null}
        <Row
          label={t('settings.models.proxy')}
          help={t('settings.models.proxy.help')}
          htmlFor={ids.proxy}
        >
          <input
            id={ids.proxy}
            className="mac-input"
            data-mono="true"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:7890"
            value={draft.proxy}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, proxy: e.target.value }))}
          />
        </Row>
      </details>
    </Card>
  )
}
