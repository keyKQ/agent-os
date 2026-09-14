import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ExternalLink,
  Flame,
  History as HistoryIcon,
  PackageOpen,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import {
  chainShort,
  formatAmount,
  formatAmountCompact,
  formatUsd,
  groupEntriesByDay,
  initiatorKey,
  shortAddress,
  formatUsdCell,
} from './logic'
import { Empty, Skeleton } from './parts'
import type { Entry, EntryKind } from './types'

const GLYPH: Record<EntryKind, LucideIcon> = {
  swap: ArrowLeftRight,
  deposit: ArrowDownLeft,
  withdraw: ArrowUpRight,
  approval: ShieldCheck,
  gas: Flame,
  unwrap: PackageOpen,
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

function dayLabel(day: string, now: number): string {
  const d = new Date(`${day}T00:00:00`)
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (same(d, today)) return t('trading.history.today')
  if (same(d, yesterday)) return t('trading.history.yesterday')
  return dayFmt.format(d)
}

/**
 * The ledger as a list: grouped by day, one glyph per kind, the two legs of
 * a swap stacked, who started it, and a door to the explorer.
 */
export function History({
  entries,
  loading,
  now,
  showWallet,
}: {
  entries: Entry[]
  loading: boolean
  now: number
  showWallet: boolean
}) {
  if (loading && entries.length === 0) {
    return (
      <div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="trd-entry">
            <span className="trd-entry__glyph" />
            <span className="trd-entry__what">
              <Skeleton width={110} />
            </span>
            <span className="trd-entry__legs">
              <Skeleton width={90} />
            </span>
            <span className="trd-entry__value">
              <Skeleton width={60} />
            </span>
            <span className="trd-entry__who">
              <Skeleton width={40} />
            </span>
            <span className="trd-entry__link" />
          </div>
        ))}
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <Empty
        icon={<HistoryIcon className="size-8" strokeWidth={1.25} aria-hidden />}
        title={t('trading.history.empty')}
        body={t('trading.history.empty.body')}
      />
    )
  }
  return (
    <div aria-label={t('trading.tab.history')}>
      {groupEntriesByDay(entries).map((group) => (
        <div key={group.day}>
          <div className="trd-day">{dayLabel(group.day, now)}</div>
          {group.entries.map((e) => (
            <EntryRow key={e.id} entry={e} showWallet={showWallet} />
          ))}
        </div>
      ))}
    </div>
  )
}

function EntryRow({ entry, showWallet }: { entry: Entry; showWallet: boolean }) {
  const Glyph = GLYPH[entry.kind]
  const by = initiatorKey(entry.initiator)
  const sub = [
    chainShort(entry.chainId),
    showWallet ? shortAddress(entry.wallet) : null,
    entry.note,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="trd-entry" data-testid="history-entry" data-kind={entry.kind}>
      <span className="trd-entry__glyph" data-kind={entry.kind} aria-hidden>
        <Glyph className="size-3.5" strokeWidth={1.75} />
      </span>
      <span className="trd-entry__what">
        <span className="trd-entry__kind">{t(`trading.history.kind.${entry.kind}`)}</span>
        <span className="trd-entry__sub">{sub}</span>
      </span>
      <span className="trd-entry__legs">
        {entry.tokenIn && entry.amountIn ? (
          <span className="trd-entry__out" title={formatAmount(entry.amountIn, 18)}>
            −{formatAmountCompact(entry.amountIn)} {entry.tokenIn.symbol}
          </span>
        ) : null}
        {entry.tokenOut && entry.amountOut ? (
          <span className="trd-entry__in" title={formatAmount(entry.amountOut, 18)}>
            +{formatAmountCompact(entry.amountOut)} {entry.tokenOut.symbol}
          </span>
        ) : null}
      </span>
      <span className="trd-entry__value" title={formatUsd(entry.valueUsd)}>
        {formatUsdCell(entry.valueUsd)}
        {entry.gasUsd !== null && entry.gasUsd > 0 ? (
          <small title={formatUsd(entry.gasUsd)}>
            {formatUsdCell(entry.gasUsd)} {t('trading.history.gas')}
          </small>
        ) : null}
      </span>
      <span className="trd-entry__who">
        <span className="trd-by" data-by={by}>
          {t(`trading.history.by.${by}`)}
        </span>
        <span className="trd-entry__time block">{timeFmt.format(new Date(entry.ts))}</span>
      </span>
      <span className="trd-entry__link">
        {entry.explorerUrl ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('trading.history.explorer')}
            title={t('trading.history.explorer')}
            onClick={() => void desktopApi().app.openExternal(entry.explorerUrl as string)}
          >
            <ExternalLink
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden
            />
          </Button>
        ) : null}
      </span>
    </div>
  )
}
