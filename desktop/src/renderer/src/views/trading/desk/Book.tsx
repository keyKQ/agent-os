import {
  ArrowLeftRight,
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  History as HistoryIcon,
  ListChecks,
  Plus,
  Star,
  Wallet as WalletIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useNow } from '~/lib/use-now'
import { useTradingUi, type BookTab } from '~/stores/trading-ui'
import {
  useHistory,
  useOrderDecision,
  useOrders,
  usePortfolio,
  useWalletMutation,
} from '~/stores/trading'
import { History } from '../History'
import { Holdings } from '../Holdings'
import {
  allocationSegments,
  EMPTY_TOTALS,
  errorText,
  formatPct,
  formatUsd,
  isAwaitingApproval,
  pnlTone,
  sameAddress,
  walletLabel,
} from '../logic'
import { Orders } from '../Orders'
import { Money } from '../parts'
import { SwapPanel, type SwapPrefill } from '../SwapPanel'
import type { Holding, Order, ProviderId, Wallet } from '../types'
import { WalletSheet, type WalletSheetMode } from '../WalletSheet'
import { BOOK_MAX, BOOK_MIN } from './desk-logic'

const TABS: readonly { id: BookTab; icon: typeof BookOpen }[] = [
  { id: 'portfolio', icon: BookOpen },
  { id: 'swap', icon: ArrowLeftRight },
  { id: 'orders', icon: ListChecks },
  { id: 'history', icon: HistoryIcon },
]

/**
 * The BOOK: the desk folded into a rail beside the chat. Same components as
 * the full desk, one at a time behind a tab; drag its edge to size it,
 * collapse it to a spine when the conversation needs the room.
 */
export function Book({
  wallets,
  primary,
  provider,
  providerReady,
  unlocked,
  collapsed,
  width,
  onResize,
  onToggle,
  onSwitchProvider,
  highlightOrder,
  entering = false,
}: {
  wallets: Wallet[]
  primary: string | null
  provider: ProviderId
  providerReady: boolean
  unlocked: boolean
  collapsed: boolean
  width: number
  onResize: (width: number) => void
  onToggle: () => void
  onSwitchProvider: () => void
  highlightOrder: string | null
  /** The desk is powering on: the hero value counts up once. */
  entering?: boolean
}) {
  const tab = useTradingUi((s) => s.bookTab)
  const setTab = useTradingUi((s) => s.setBookTab)
  const [walletSel, setWalletSel] = useState<string | 'all'>('all')
  const [picked, setPicked] = useState<Holding | null>(null)
  const [prefill, setPrefill] = useState<SwapPrefill | null>(null)
  const [sheet, setSheet] = useState<WalletSheetMode | null>(null)
  const now = useNow(30_000)
  const decide = useOrderDecision()
  const walletWrite = useWalletMutation()

  const selected: string | 'all' =
    walletSel !== 'all' && !wallets.some((w) => sameAddress(w.address, walletSel))
      ? 'all'
      : walletSel
  const walletAddress = selected === 'all' ? undefined : selected
  const portfolio = usePortfolio(walletAddress, !collapsed)
  const orders = useOrders(undefined, !collapsed && tab === 'orders')
  const history = useHistory(walletAddress, undefined, !collapsed && tab === 'history')
  const totals = portfolio.data?.totals ?? EMPTY_TOTALS
  const holdings = portfolio.data?.holdings ?? []
  const counted = useCountUp(totals.valueUsd, entering && !portfolio.isPending)
  const pendingCount = orders.orders.filter(isAwaitingApproval).length
  const byWallet = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of portfolio.data?.wallets ?? [])
      m.set(row.wallet.address.toLowerCase(), row.totals.valueUsd)
    return m
  }, [portfolio.data])

  // Drag the left edge; the width is measured from the rendered edge so a
  // concession-clamped panel does not jump on the first pixel.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startX: e.clientX, startW: width }
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.dataset.dragging = 'true'
    },
    [width],
  )
  const onDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.min(BOOK_MAX, Math.max(BOOK_MIN, d.startW + (d.startX - e.clientX)))
      onResize(next)
    },
    [onResize],
  )
  const onDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    delete document.body.dataset.dragging
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }, [])

  function onDecide(order: Order, approve: boolean) {
    decide.mutate(
      { orderId: order.orderId, approve },
      {
        onSuccess: () =>
          toast.success(
            approve ? t('trading.approvals.approved') : t('trading.approvals.rejected'),
            { id: `trd-order-${order.orderId}` },
          ),
        onError: (err) =>
          toast.error(`${t('trading.approvals.failed')}: ${errorText(err)}`, {
            id: `trd-order-${order.orderId}`,
          }),
      },
    )
  }

  if (collapsed) {
    return (
      <aside className="trd-book trd-book--spine" aria-label={t('trading.book.title')}>
        <button
          type="button"
          className="trd-book__spinebtn app-no-drag"
          onClick={onToggle}
          aria-label={t('trading.book.open')}
          title={t('trading.book.open')}
          data-testid="book-open"
        >
          <ChevronsLeft className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="trd-book__spinebtn app-no-drag"
            onClick={() => setTab(id)}
            aria-label={t(`trading.book.tab.${id}`)}
            title={t(`trading.book.tab.${id}`)}
          >
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
            {id === 'orders' && pendingCount > 0 ? (
              <span className="trd-book__dot" aria-hidden />
            ) : null}
          </button>
        ))}
        <span className="trd-book__spinelabel">{t('trading.book.title')}</span>
      </aside>
    )
  }

  return (
    <aside
      className="trd-book"
      style={{ width }}
      aria-label={t('trading.book.title')}
      data-testid="book"
    >
      <div
        className="trd-book__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('trading.book.resize')}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onDoubleClick={() => onResize(360)}
      />
      <header className="trd-book__head">
        <div className="trd-book__tabs" role="tablist" aria-label={t('trading.book.title')}>
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="trd-book__tab app-no-drag"
              onClick={() => setTab(id)}
              data-testid={`book-tab-${id}`}
            >
              <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
              <span>{t(`trading.book.tab.${id}`)}</span>
              {id === 'orders' && pendingCount > 0 ? (
                <span className="trd-book__count">{pendingCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('trading.book.collapse')}
          title={t('trading.book.collapse')}
          onClick={onToggle}
          data-testid="book-collapse"
        >
          <ChevronsRight className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </Button>
      </header>

      <div className="trd-book__body" data-tab={tab}>
        {tab === 'portfolio' ? (
          <div className="trd-book__portfolio">
            <section className="trd-book__hero" data-tone={pnlTone(totals.change24hUsd)}>
              <span className="trd-book__label">{t('trading.overview.value')}</span>
              <b className="trd-book__value" data-testid="book-value">
                {portfolio.isPending ? (
                  <span className="trd-skel" style={{ width: 120, height: 24 }} />
                ) : counted !== null ? (
                  <span className="trd-num" data-testid="book-value-counting">
                    {formatUsd(counted)}
                  </span>
                ) : (
                  <Money value={totals.valueUsd} />
                )}
              </b>
              {totals.change24hUsd !== null ? (
                <span className="trd-num trd-book__delta" data-tone={pnlTone(totals.change24hUsd)}>
                  {formatUsd(totals.change24hUsd, { signed: true })}{' '}
                  {formatPct(totals.change24hPct, { signed: true })} {t('trading.overview.today')}
                </span>
              ) : null}
              <div className="trd-book__stats">
                <Stat label={t('trading.overview.unrealized')} value={totals.unrealizedUsd} toned />
                <Stat label={t('trading.overview.realized')} value={totals.realizedUsd} toned />
                <Stat label={t('trading.overview.cost')} value={totals.costUsd} />
                <Stat label={t('trading.overview.gas')} value={totals.gasUsd} />
              </div>
              <div className="trd-book__alloc" aria-hidden>
                {allocationSegments(holdings).map((s) => (
                  <span
                    key={s.symbol}
                    style={{ width: `${s.pct}%` }}
                    title={`${s.symbol} ${s.pct.toFixed(1)}%`}
                  />
                ))}
              </div>
            </section>

            <div className="trd-book__wallets" role="listbox" aria-label={t('trading.rail.title')}>
              {wallets.length > 1 ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === 'all'}
                  className="trd-book__wallet app-no-drag"
                  onClick={() => setWalletSel('all')}
                >
                  <WalletIcon className="size-3" strokeWidth={2} aria-hidden />
                  <span>{t('trading.rail.all')}</span>
                </button>
              ) : null}
              {wallets.map((w) => (
                <button
                  key={w.address}
                  type="button"
                  role="option"
                  aria-selected={selected !== 'all' && sameAddress(selected, w.address)}
                  className="trd-book__wallet app-no-drag"
                  onClick={() => setWalletSel(w.address)}
                  title={w.address}
                >
                  {w.primary ? <Star className="size-3" strokeWidth={2} aria-hidden /> : null}
                  <span>{walletLabel(w)}</span>
                  <span className="trd-num trd-book__walletvalue">
                    {formatUsd(byWallet.get(w.address.toLowerCase()) ?? null, { compact: true })}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="trd-book__wallet trd-book__wallet--add app-no-drag"
                onClick={() => setSheet({ kind: 'create' })}
                title={t('trading.rail.add')}
                aria-label={t('trading.rail.add')}
                data-testid="book-add-wallet"
              >
                <Plus className="size-3" strokeWidth={2} aria-hidden />
              </button>
            </div>

            <Holdings
              holdings={holdings}
              loading={portfolio.isPending}
              selected={picked}
              onSelect={setPicked}
              showChain
              onSwap={(h) => {
                setPrefill({
                  chainId: h.chainId,
                  tokenIn: h.token,
                  wallet: h.wallet ?? walletAddress,
                  seq: Date.now(),
                })
                setTab('swap')
              }}
            />
          </div>
        ) : tab === 'swap' ? (
          <SwapPanel
            wallets={wallets}
            primary={primary}
            selectedWallet={selected}
            provider={provider}
            providerReady={providerReady}
            onSwitchProvider={onSwitchProvider}
            unlocked={unlocked}
            prefill={prefill}
            onSent={() => setTab('orders')}
          />
        ) : tab === 'orders' ? (
          <Orders
            orders={orders.orders}
            approvalsOnly={false}
            deciding={decide.isPending ? (decide.variables?.orderId ?? null) : null}
            onDecide={onDecide}
            showWallet={wallets.length > 1}
            highlight={highlightOrder}
          />
        ) : (
          <History
            entries={history.entries}
            loading={history.isPending}
            now={now}
            showWallet={selected === 'all' && wallets.length > 1}
          />
        )}
      </div>
      {sheet ? (
        <WalletSheet
          mode={sheet}
          onClose={() => {
            setSheet(null)
            walletWrite.reset()
          }}
        />
      ) : null}
    </aside>
  )
}

function Stat({ label, value, toned }: { label: string; value: number; toned?: boolean }) {
  return (
    <div className="trd-book__stat">
      <span className="trd-book__label">{label}</span>
      <Money value={value} signed={toned} toned={toned} />
    </div>
  )
}

/* Entrance: the hero value counts from 0 to its figure over the window the
   choreography reserves for it (see --enter-count-* in desk.css), then hands
   back to the live, ticking value. Returns null when not counting. */
const COUNT_DELAY_MS = 380
const COUNT_MS = 320

function useCountUp(target: number, active: boolean): number | null {
  const [shown, setShown] = useState<number | null>(null)
  const done = useRef(false)
  useEffect(() => {
    if (!active) return
    done.current = false
    const start = performance.now() + COUNT_DELAY_MS
    let raf = requestAnimationFrame(function tick(now: number) {
      const p = Math.min(1, Math.max(0, (now - start) / COUNT_MS))
      const eased = 1 - Math.pow(1 - p, 3)
      if (p < 1) {
        setShown(target * eased)
        raf = requestAnimationFrame(tick)
      } else {
        done.current = true
        setShown(null)
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      done.current = false
    }
  }, [active, target])
  if (!active || done.current) return null
  return shown ?? 0
}
