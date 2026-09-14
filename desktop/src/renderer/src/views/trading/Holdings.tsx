import {
  ArrowDown,
  ArrowUp,
  ChartCandlestick,
  Coins,
  ArrowLeftRight,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { cn } from '~/lib/utils'
import {
  DUST_USD,
  formatAmount,
  formatAmountCompact,
  formatPct,
  formatPrice,
  formatUsd,
  formatUsdCell,
  pnlTone,
  sameToken,
  sortHoldings,
  type HoldingSort,
  splitDust,
} from './logic'
import { UnwrapNote } from './Orders'
import { AssetCell, Empty, Skeleton, Tick } from './parts'
import { isWrappedEth, type Holding } from './types'

/**
 * The ledger's table. Dense mono figures, a hairline per row, the
 * allocation rule under each value, and on hover the two things you do
 * with a holding: look at its chart, or swap it.
 */
export function Holdings({
  holdings,
  loading,
  selected,
  onSelect,
  onSwap,
  showChain,
}: {
  holdings: Holding[]
  loading: boolean
  selected: Holding | null
  onSelect: (holding: Holding | null) => void
  onSwap: (holding: Holding) => void
  showChain: boolean
}) {
  const [sort, setSort] = useState<{ key: HoldingSort; dir: 'asc' | 'desc' }>({
    key: 'value',
    dir: 'desc',
  })
  const [showDust, setShowDust] = useState(false)
  const { kept, dust } = splitDust(holdings)
  const rows = sortHoldings(showDust ? holdings : kept, sort.key, sort.dir)

  function toggle(key: HoldingSort) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' },
    )
  }

  if (!loading && holdings.length === 0) {
    return (
      <Empty
        icon={<Coins className="size-8" strokeWidth={1.25} aria-hidden />}
        title={t('trading.holdings.empty')}
        body={t('trading.holdings.empty.body')}
      />
    )
  }

  return (
    <div className="trd-tablewrap">
      <table className="trd-table" aria-label={t('trading.holdings.title')}>
        <thead>
          <tr>
            <Th
              label={t('trading.holdings.col.asset')}
              sortKey="symbol"
              sort={sort}
              onSort={toggle}
              className="trd-col--asset"
            />
            <th className="trd-col--amount">{t('trading.holdings.col.amount')}</th>
            <th className="trd-col--price">{t('trading.holdings.col.price')}</th>
            <Th
              label={t('trading.holdings.col.change')}
              sortKey="change"
              sort={sort}
              onSort={toggle}
              className="trd-col--change"
            />
            <Th
              label={t('trading.holdings.col.value')}
              sortKey="value"
              sort={sort}
              onSort={toggle}
              className="trd-col--value"
            />
            <th className="trd-col--cost">{t('trading.holdings.col.cost')}</th>
            <Th
              label={t('trading.holdings.col.pnl')}
              sortKey="pnl"
              sort={sort}
              onSort={toggle}
              className="trd-col--pnl"
            />
            <th className="trd-col--actions" aria-label={t('trading.holdings.swap')} />
          </tr>
        </thead>
        <tbody>
          {loading && holdings.length === 0
            ? [0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td>
                    <Skeleton width={120} />
                  </td>
                  <td className="trd-col--amount">
                    <Skeleton width={64} />
                  </td>
                  <td className="trd-col--price">
                    <Skeleton width={56} />
                  </td>
                  <td className="trd-col--change">
                    <Skeleton width={40} />
                  </td>
                  <td className="trd-col--value">
                    <Skeleton width={72} />
                  </td>
                  <td className="trd-col--cost">
                    <Skeleton width={56} />
                  </td>
                  <td className="trd-col--pnl">
                    <Skeleton width={72} />
                  </td>
                  <td />
                </tr>
              ))
            : rows.map((h) => {
                const key = `${h.chainId}:${h.token.address.toLowerCase()}:${h.wallet ?? ''}`
                const isSelected =
                  selected !== null &&
                  sameToken(selected.token, h.token) &&
                  selected.wallet === h.wallet
                return (
                  <tr
                    key={key}
                    aria-selected={isSelected}
                    data-testid="holding-row"
                    onClick={() => onSelect(isSelected ? null : h)}
                  >
                    <td className="trd-col--asset">
                      <AssetCell token={h.token} showChain={showChain} />
                    </td>
                    <td className="trd-col--amount" title={formatAmount(h.amount, 18)}>
                      <Tick value={h.amount}>{formatAmountCompact(h.amount)}</Tick>
                    </td>
                    <td
                      className={cn('trd-col--price', h.priceUsd === null && 'trd-cell--muted')}
                      title={h.priceUsd === null ? undefined : formatUsd(h.priceUsd)}
                    >
                      <Tick value={h.priceUsd}>
                        {h.priceUsd === null
                          ? t('trading.holdings.noPrice')
                          : formatPrice(h.priceUsd)}
                      </Tick>
                    </td>
                    <td className="trd-col--change" data-tone={pnlTone(h.change24hPct)}>
                      {formatPct(h.change24hPct, { signed: true })}
                    </td>
                    <td className="trd-col--value" title={formatUsd(h.valueUsd)}>
                      <span
                        className="trd-value"
                        style={{ ['--alloc' as string]: h.allocationPct }}
                      >
                        <Tick value={h.valueUsd}>{formatUsdCell(h.valueUsd)}</Tick>
                      </span>
                    </td>
                    <td className="trd-col--cost trd-cell--muted" title={formatUsd(h.avgCostUsd)}>
                      {formatUsdCell(h.avgCostUsd)}
                    </td>
                    <td
                      className="trd-col--pnl"
                      data-tone={pnlTone(h.unrealizedUsd)}
                      title={formatUsd(h.unrealizedUsd, { signed: true })}
                    >
                      {formatUsdCell(h.unrealizedUsd, { signed: true })}
                      {h.unrealizedPct !== null ? (
                        <span className="ml-1 text-[10px] opacity-80">
                          {formatPct(h.unrealizedPct, { signed: true })}
                        </span>
                      ) : null}
                    </td>
                    <td className="trd-col--actions">
                      <span className="trd-row__actions">
                        {isWrappedEth(h.token) && h.wallet ? (
                          <UnwrapNote chainId={h.chainId} wallet={h.wallet} compact />
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t('trading.holdings.chart')} ${h.token.symbol}`}
                          title={t('trading.holdings.chart')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelect(isSelected ? null : h)
                          }}
                        >
                          <ChartCandlestick
                            className="size-3.5 text-muted-foreground"
                            strokeWidth={1.75}
                            aria-hidden
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t('trading.holdings.swap')} ${h.token.symbol}`}
                          title={t('trading.holdings.swap')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSwap(h)
                          }}
                        >
                          <ArrowLeftRight
                            className="size-3.5 text-muted-foreground"
                            strokeWidth={1.75}
                            aria-hidden
                          />
                        </Button>
                      </span>
                    </td>
                  </tr>
                )
              })}
        </tbody>
      </table>
      {dust.length ? (
        <div className="trd-dustbar">
          <span className="trd-dustbar__text">
            {dust.length}{' '}
            {dust.length === 1 ? t('trading.holdings.dust.one') : t('trading.holdings.dust.many')}{' '}
            {formatUsd(DUST_USD)} {t('trading.holdings.dust.hidden')}
          </span>
          <button
            type="button"
            className="trd-dust app-no-drag"
            onClick={() => setShowDust((v) => !v)}
            aria-pressed={showDust}
            data-testid="dust-toggle"
          >
            {showDust ? (
              <EyeOff className="size-3" strokeWidth={2} aria-hidden />
            ) : (
              <Eye className="size-3" strokeWidth={2} aria-hidden />
            )}
            {showDust ? t('trading.holdings.dust.hide') : t('trading.holdings.dust.show')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Th({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey: HoldingSort
  sort: { key: HoldingSort; dir: 'asc' | 'desc' }
  onSort: (key: HoldingSort) => void
  className?: string
}) {
  const active = sort.key === sortKey
  const Arrow = sort.dir === 'desc' ? ArrowDown : ArrowUp
  return (
    <th
      className={className}
      aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : undefined}
    >
      <button type="button" aria-pressed={active} onClick={() => onSort(sortKey)}>
        {label}
        {active ? <Arrow className="size-2.5" strokeWidth={2.5} aria-hidden /> : null}
      </button>
    </th>
  )
}
