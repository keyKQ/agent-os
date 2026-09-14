import { ChainBadge } from './ChainMark'
import {
  ArrowRight,
  Ban,
  Check,
  CircleDashed,
  ExternalLink,
  Hourglass,
  ListChecks,
  PackageOpen,
  SendHorizontal,
  ShieldAlert,
  ShieldCheck,
  TimerOff,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { shortAge } from '~/lib/relative-time'
import { useNow } from '~/lib/use-now'
import { useUnwrap } from '~/stores/trading'
import {
  approvalSecondsLeft,
  errorText,
  formatAmount,
  formatClock,
  formatPct,
  formatUsd,
  formatUsdCell,
  impactTone,
  initiatorKey,
  isAwaitingApproval,
  orderTone,
  shortAddress,
} from './logic'
import { Empty } from './parts'
import { isWrappedEth, providerLabel, type Order, type OrderStatus } from './types'

/** One mark per state, so a column of rows is scannable before it is read. */
const GLYPH: Record<OrderStatus, LucideIcon> = {
  quoted: CircleDashed,
  awaiting_approval: ShieldAlert,
  approved: ShieldCheck,
  submitted: SendHorizontal,
  confirmed: Check,
  failed: X,
  rejected: Ban,
  expired: TimerOff,
}

/** "Received WETH" with the one click that turns it back into ETH. */
export function UnwrapNote({
  chainId,
  wallet,
  amount,
  compact,
}: {
  chainId: number
  wallet: string
  amount?: string
  compact?: boolean
}) {
  const unwrap = useUnwrap()
  return (
    <span className="inline-flex items-center gap-2">
      {!compact ? <span>{t('trading.unwrap.note')}</span> : null}
      <Button
        disabled={unwrap.isPending}
        data-testid="unwrap"
        aria-label={compact ? t('trading.unwrap.cta') : undefined}
        title={t('trading.unwrap.cta')}
        size={compact ? 'icon' : 'md'}
        variant={compact ? 'ghost' : 'secondary'}
        onClick={(e) => {
          e.stopPropagation()
          unwrap.mutate(
            { chainId, wallet, ...(amount ? { amount } : {}) },
            {
              onSuccess: () => toast.success(t('trading.unwrap.sent'), { id: 'trd-unwrap' }),
              onError: (err) =>
                toast.error(`${t('trading.unwrap.failed')}: ${errorText(err)}`, {
                  id: 'trd-unwrap',
                }),
            },
          )
        }}
      >
        <PackageOpen
          className={compact ? 'size-3.5 text-muted-foreground' : 'size-3.5'}
          strokeWidth={1.75}
          aria-hidden
        />
        {!compact ? t('trading.unwrap.cta') : null}
      </Button>
    </span>
  )
}

/**
 * Orders, and the approvals view which is the same rows filtered to what
 * the agent is waiting on: each with its timer, Approve and Reject.
 */
export function Orders({
  orders,
  approvalsOnly,
  deciding,
  onDecide,
  showWallet,
  highlight,
}: {
  orders: Order[]
  approvalsOnly: boolean
  deciding: string | null
  onDecide: (order: Order, approve: boolean) => void
  showWallet: boolean
  /** An order id to scroll to (from a notification). */
  highlight: string | null
}) {
  // Approval timers count down by the second; nothing else on the page does.
  const now = useNow(1000)
  const rows = approvalsOnly ? orders.filter(isAwaitingApproval) : orders
  if (rows.length === 0) {
    return approvalsOnly ? (
      <Empty
        icon={<ShieldAlert className="size-8" strokeWidth={1.25} aria-hidden />}
        title={t('trading.approvals.empty')}
        body={t('trading.approvals.empty.body')}
      />
    ) : (
      <Empty
        icon={<ListChecks className="size-8" strokeWidth={1.25} aria-hidden />}
        title={t('trading.orders.empty')}
        body={t('trading.orders.empty.body')}
      />
    )
  }
  return (
    <div aria-label={approvalsOnly ? t('trading.tab.approvals') : t('trading.tab.orders')}>
      {rows.map((o) => (
        <OrderRow
          key={o.orderId}
          order={o}
          now={now}
          deciding={deciding === o.orderId}
          onDecide={onDecide}
          showWallet={showWallet}
          highlighted={highlight === o.orderId}
        />
      ))}
    </div>
  )
}

/** A label and its figure on the quiet caption line: "min 0.000148". */
function Fact({
  label,
  title,
  tone,
  children,
}: {
  label: string
  title: string
  tone?: 'warn' | 'danger'
  children: ReactNode
}) {
  return (
    <span className="trd-order__fact" title={title}>
      <span>{label}</span>
      <b data-tone={tone}>{children}</b>
    </span>
  )
}

function OrderRow({
  order,
  now,
  deciding,
  onDecide,
  showWallet,
  highlighted,
}: {
  order: Order
  now: number
  deciding: boolean
  onDecide: (order: Order, approve: boolean) => void
  showWallet: boolean
  highlighted: boolean
}) {
  const waiting = isAwaitingApproval(order)
  const left = waiting ? approvalSecondsLeft(order, now) : null
  const by = initiatorKey(order.initiator)
  const tone = orderTone(order.status)
  const Glyph = GLYPH[order.status]
  const impact = order.priceImpactPct === null ? null : impactTone(order.priceImpactPct)
  const failed =
    order.status === 'failed' || order.status === 'rejected' || order.status === 'expired'
  return (
    <div
      className="trd-order"
      data-status={order.status}
      data-tone={tone}
      data-testid="order-row"
      ref={(el) => {
        if (highlighted && el) el.scrollIntoView({ block: 'center' })
      }}
    >
      <span className="trd-order__mark" data-tone={tone} aria-hidden>
        <Glyph className="size-3.5" strokeWidth={2} />
      </span>

      <div className="trd-order__head">
        <span className="trd-order__leg">
          {formatAmount(order.amountIn)} <i>{order.tokenIn.symbol}</i>
        </span>
        <ArrowRight className="trd-order__arrow size-3" strokeWidth={2} aria-hidden />
        <span className="trd-order__leg">
          {order.expectedOut ? `${formatAmount(order.expectedOut)} ` : ''}
          <i>{order.tokenOut.symbol}</i>
        </span>
      </div>

      <div className="trd-order__value" title={formatUsd(order.valueUsd)}>
        {formatUsdCell(order.valueUsd)}
      </div>

      <div className="trd-order__who">
        <span className="trd-by" data-by={by}>
          {t(`trading.history.by.${by}`)}
        </span>
        <span className="trd-order__time">{shortAge(order.updatedAt, now)}</span>
      </div>

      <div className="trd-order__link">
        {order.explorerUrl ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('trading.history.explorer')}
            title={t('trading.history.explorer')}
            onClick={() => void desktopApi().app.openExternal(order.explorerUrl as string)}
          >
            <ExternalLink
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>

      <div className="trd-order__meta">
        <span className="trd-order__state" data-tone={tone}>
          {t(`trading.orders.status.${order.status}`)}
        </span>
        <span className="trd-order__fact">
          <ChainBadge chainId={order.chainId} />
          {order.provider ? (
            <span>{`${t('trading.provider.via')} ${providerLabel(order.provider)}`}</span>
          ) : null}
        </span>
        {showWallet ? (
          <span className="trd-order__fact">
            <b className="trd-mono">{shortAddress(order.wallet)}</b>
          </span>
        ) : null}
        {order.minOut ? (
          <Fact label={t('trading.orders.fact.min')} title={t('trading.orders.minimum')}>
            {formatAmount(order.minOut)}
          </Fact>
        ) : null}
        {order.priceImpactPct !== null ? (
          <Fact
            label={t('trading.orders.fact.impact')}
            title={t('trading.swap.impact')}
            tone={impact === 'ok' ? undefined : (impact ?? undefined)}
          >
            {formatPct(order.priceImpactPct)}
          </Fact>
        ) : null}
        {order.gasUsd !== null ? (
          <Fact label={t('trading.orders.fact.fee')} title={t('trading.swap.gas')}>
            {formatUsd(order.gasUsd)}
          </Fact>
        ) : null}
      </div>

      {waiting ? (
        <div className="trd-order__act">
          {left !== null ? (
            <span className="trd-order__timer" data-urgent={left <= 60 ? 'true' : undefined}>
              <Hourglass className="size-3" strokeWidth={2} aria-hidden />
              {t('trading.approvals.expiresIn')} {formatClock(left)}
            </span>
          ) : null}
          <div className="trd-order__actions">
            <Button
              disabled={deciding}
              onClick={() => onDecide(order, false)}
              data-testid="order-reject"
            >
              {t('trading.approvals.reject')}
            </Button>
            <Button
              variant="primary"
              disabled={deciding}
              onClick={() => onDecide(order, true)}
              data-testid="order-approve"
            >
              {t('trading.approvals.approve')}
            </Button>
          </div>
        </div>
      ) : null}

      {order.note ? (
        <div className="trd-order__note">
          {t('trading.orders.note')}: {order.note}
        </div>
      ) : null}

      {order.deliveredToken &&
      order.status === 'confirmed' &&
      isWrappedEth(order.deliveredToken) &&
      !isWrappedEth(order.tokenOut) ? (
        <div className="trd-order__note" data-testid="order-delivered">
          <UnwrapNote chainId={order.chainId} wallet={order.wallet} />
        </div>
      ) : null}

      {order.reason && failed ? (
        <div className="trd-order__reason" title={order.reason}>
          <TriangleAlert className="size-3 shrink-0" strokeWidth={2} aria-hidden />
          <span>
            {t('trading.orders.reason')}: {order.reason}
          </span>
        </div>
      ) : null}
    </div>
  )
}
