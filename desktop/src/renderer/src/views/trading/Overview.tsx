import { RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { shortAge } from '~/lib/relative-time'
import { allocationSegments, formatPct, formatUsd, pnlTone } from './logic'
import { Money, Spinner } from './parts'
import { providerLabel, type Holding, type ProviderId, type Totals } from './types'

/**
 * The hero: the value in the display face, today's move beside it, four
 * figures under it, and the allocation rule. Everything here is a total of
 * what the table below lists; nothing is computed twice.
 */
export function Overview({
  totals,
  holdings,
  syncing,
  lastSyncAt,
  now,
  onSync,
  loading,
  provider,
}: {
  totals: Totals
  holdings: Holding[]
  syncing: boolean
  lastSyncAt: number | null
  now: number
  onSync: () => void
  loading: boolean
  /** Who routes swaps right now, as a pill beside the sync state. */
  provider?: ProviderId
}) {
  const tone = pnlTone(totals.change24hUsd)
  const segments = allocationSegments(holdings)
  const Arrow = tone === 'down' ? TrendingDown : TrendingUp

  return (
    <section className="trd-hero" data-tone={tone} aria-label={t('trading.overview.value')}>
      <div className="trd-hero__top">
        <div>
          <div className="trd-hero__label">{t('trading.overview.value')}</div>
          <div className="trd-hero__value">
            <b data-testid="portfolio-value">
              {loading ? (
                <span className="trd-skel" style={{ width: 160, height: 28 }} />
              ) : (
                <Money value={totals.valueUsd} />
              )}
            </b>
            {!loading && totals.change24hUsd !== null ? (
              <span className="trd-hero__delta trd-num" data-tone={tone}>
                {tone !== 'flat' ? (
                  <Arrow className="size-3.5" strokeWidth={2} aria-hidden />
                ) : null}
                {formatUsd(totals.change24hUsd, { signed: true })}
                <span>{formatPct(totals.change24hPct, { signed: true })}</span>
                <small>{t('trading.overview.today')}</small>
              </span>
            ) : null}
          </div>
        </div>
        <div className="trd-hero__tools">
          {provider ? (
            <span className="trd-status" data-tone="live" data-testid="provider-pill">
              {providerLabel(provider)}
            </span>
          ) : null}
          <span className="trd-hero__sync" data-live={syncing ? 'true' : undefined}>
            {syncing ? (
              <>
                <Spinner className="size-3" />
                {t('trading.syncing')}
              </>
            ) : (
              <>
                {t('trading.lastSync')}{' '}
                {lastSyncAt ? shortAge(lastSyncAt, now) : t('trading.never')}
              </>
            )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('trading.sync')}
            title={t('trading.sync')}
            disabled={syncing}
            onClick={onSync}
          >
            <RefreshCw className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="trd-hero__stats">
        <Stat
          label={t('trading.overview.unrealized')}
          value={totals.unrealizedUsd}
          signed
          toned
          pct={totals.costUsd > 0 ? (totals.unrealizedUsd / totals.costUsd) * 100 : null}
        />
        <Stat label={t('trading.overview.realized')} value={totals.realizedUsd} signed toned />
        <Stat label={t('trading.overview.cost')} value={totals.costUsd} />
        <Stat label={t('trading.overview.gas')} value={totals.gasUsd} />
      </div>

      {segments.length > 0 ? (
        <div className="trd-alloc" aria-label={t('trading.overview.allocation')}>
          <div className="trd-alloc__bar" aria-hidden>
            {segments.map((s) => (
              <span
                key={s.symbol}
                data-other={s.symbol === 'other' ? 'true' : undefined}
                style={{ flexBasis: `${s.pct}%` }}
                title={`${s.symbol} ${formatPct(s.pct)}`}
              />
            ))}
          </div>
          <div className="trd-alloc__legend">
            {segments.map((s) => (
              <span key={s.symbol}>
                {s.symbol === 'other' ? t('trading.overview.other') : s.symbol}{' '}
                <b>{formatPct(s.pct)}</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function Stat({
  label,
  value,
  signed,
  toned,
  pct,
}: {
  label: string
  value: number
  signed?: boolean
  toned?: boolean
  pct?: number | null
}) {
  return (
    <div className="trd-stat">
      <span className="trd-stat__label">{label}</span>
      <span className="trd-stat__value">
        <Money value={value} signed={signed} toned={toned} />
        {pct !== undefined && pct !== null && Number.isFinite(pct) ? (
          <small className="trd-num" data-tone={pnlTone(pct)}>
            {formatPct(pct, { signed: true })}
          </small>
        ) : null}
      </span>
    </div>
  )
}
