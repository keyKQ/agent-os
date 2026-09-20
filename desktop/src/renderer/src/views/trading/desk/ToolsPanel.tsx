import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Search,
  SendHorizontal,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
import { t } from '~/i18n'
import { useAllowances, useNetwork } from '~/stores/trading'
import { Allowances } from '../Allowances'
import { pipState, pipTitle } from '../NetworkPips'
import { chainShort } from '../logic'
import { Spinner } from '../parts'

/**
 * The desk's tools, all of them, in one tab of the BOOK: a card each, with
 * the one figure that says whether it needs you (unlimited allowances, a
 * chain that is behind). Send and Inspect open their sheets; Allowances
 * opens in place; Network is read right off its card. Nothing here is a
 * popup — it is where a person looks when they do not know what the desk
 * can do.
 */
export function ToolsPanel({
  wallet,
  onSend,
  onInspect,
}: {
  wallet: string | undefined
  onSend: () => void
  onInspect: () => void
}) {
  const [view, setView] = useState<'cards' | 'allowances'>('cards')
  const allowances = useAllowances(wallet, undefined, true)
  const network = useNetwork(true)

  if (view === 'allowances') {
    return (
      <div className="trd-tools" data-testid="tools-panel">
        <button
          type="button"
          className="trd-tools__back app-no-drag"
          onClick={() => setView('cards')}
          data-testid="tools-back"
        >
          <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden />
          {t('trading.tools.heading')}
        </button>
        <Allowances wallet={wallet} />
      </div>
    )
  }

  const unlimited = allowances.unlimitedCount
  const chains = network.chains
  const unhealthy = chains.filter((c) => pipState(c) !== 'ok')

  return (
    <div className="trd-tools" data-testid="tools-panel">
      <p className="trd-tools__lead">{t('trading.tools.lead')}</p>

      <button
        type="button"
        className="trd-tool app-no-drag"
        onClick={onSend}
        data-testid="tool-send"
      >
        <SendHorizontal className="trd-tool__icon" strokeWidth={1.75} aria-hidden />
        <span className="trd-tool__text">
          <b>{t('trading.tools.send')}</b>
          <span>{t('trading.tools.send.blurb')}</span>
        </span>
        <ChevronRight className="trd-tool__go" strokeWidth={2} aria-hidden />
      </button>

      <button
        type="button"
        className="trd-tool app-no-drag"
        data-tone={unlimited > 0 ? 'warn' : undefined}
        onClick={() => setView('allowances')}
        data-testid="tool-allowances"
      >
        <ShieldCheck className="trd-tool__icon" strokeWidth={1.75} aria-hidden />
        <span className="trd-tool__text">
          <b>{t('trading.tools.allowances')}</b>
          <span>
            {allowances.isPending && !allowances.data
              ? t('trading.tools.reading')
              : unlimited > 0
                ? `${unlimited} ${unlimited === 1 ? t('trading.allowances.warn') : t('trading.allowances.warn.plural')}`
                : allowances.allowances.length
                  ? `${allowances.allowances.length} ${t('trading.tools.allowances.live')}`
                  : t('trading.tools.allowances.none')}
          </span>
        </span>
        {allowances.scanning ? (
          <Spinner className="size-3" />
        ) : (
          <ChevronRight className="trd-tool__go" strokeWidth={2} aria-hidden />
        )}
      </button>

      <button
        type="button"
        className="trd-tool app-no-drag"
        onClick={onInspect}
        data-testid="tool-inspect"
      >
        <Search className="trd-tool__icon" strokeWidth={1.75} aria-hidden />
        <span className="trd-tool__text">
          <b>{t('trading.tools.inspect')}</b>
          <span>{t('trading.tools.inspect.blurb')}</span>
        </span>
        <ChevronRight className="trd-tool__go" strokeWidth={2} aria-hidden />
      </button>

      <section
        className="trd-tool trd-tool--static"
        data-tone={unhealthy.length ? 'warn' : undefined}
        aria-label={t('trading.tools.network')}
        data-testid="tool-network"
      >
        <Activity className="trd-tool__icon" strokeWidth={1.75} aria-hidden />
        <span className="trd-tool__text">
          <b>{t('trading.tools.network')}</b>
          <span>
            {chains.length
              ? unhealthy.length
                ? `${unhealthy.map((c) => c.name).join(', ')} · ${t(`trading.network.${pipState(unhealthy[0]!)}`)}`
                : t('trading.network.allHealthy')
              : t('trading.network.unknown')}
          </span>
        </span>
        <button
          type="button"
          className="trd-tool__refresh app-no-drag"
          onClick={() => void network.refetch()}
          aria-label={t('trading.network.refresh')}
          title={t('trading.network.refresh')}
        >
          {network.isFetching ? <Spinner className="size-3" /> : null}
        </button>
        <ul className="trd-tool__chains">
          {chains.map((c) => (
            <li key={c.chainId} data-state={pipState(c)} title={pipTitle(c)}>
              <span className="trd-pip__dot" aria-hidden />
              <b>{chainShort(c.chainId)}</b>
              <span className="trd-mono">
                {c.blockNumber !== null ? `#${c.blockNumber}` : '—'}
                {c.blockAgeS !== null ? ` · ${c.blockAgeS}s` : ''}
                {c.baseFeeGwei !== null ? ` · ${gwei(c.baseFeeGwei)} gwei` : ''}
                {c.latencyMs !== null ? ` · ${c.latencyMs} ms` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function gwei(value: number): string {
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.001) return value.toFixed(4)
  return value.toPrecision(2)
}
