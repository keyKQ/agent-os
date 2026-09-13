import {
  ArrowRight,
  ExternalLink,
  Hourglass,
  ListChecks,
  PackageOpen,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { shortAge } from '~/lib/relative-time'
import { useNow } from '~/lib/use-now'
import { useUnwrap } from '~/stores/trading'
import {
  approvalSecondsLeft,
  chainShort,
  errorText,
  formatAmount,
  formatClock,
  formatPct,
  formatUsd,
  initiatorKey,
  isAwaitingApproval,
  shortAddress,
} from './logic'
import { Empty, StatusPill } from './parts'
import { isWrappedEth, providerLabel, type Order } from './types'

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
  return (
    <div
      className="trd-order"
      data-status={order.status}
      data-testid="order-row"
      ref={(el) => {
        if (highlighted && el) el.scrollIntoView({ block: 'center' })
      }}
    >
      <div className="trd-order__head">
        <span className="trd-order__leg">
          {formatAmount(order.amountIn)} {order.tokenIn.symbol}
        </span>
        <ArrowRight className="trd-order__arrow size-3.5" strokeWidth={2} aria-hidden />
        <span className="trd-order__leg">
          {order.expectedOut ? `${formatAmount(order.expectedOut)} ` : ''}
          {order.tokenOut.symbol}
        </span>
        <span className="trd-by" data-by={by}>
          {t(`trading.history.by.${by}`)}
        </span>
      </div>
      <div className="trd-order__meta">
        <span>
          {chainShort(order.chainId)}
          {order.provider ? ` · ${t('trading.provider.via')} ${providerLabel(order.provider)}` : ''}
        </span>
        {showWallet ? <span className="trd-mono">{shortAddress(order.wallet)}</span> : null}
        <span>
          {t('trading.orders.value')} <b>{formatUsd(order.valueUsd)}</b>
        </span>
        {order.minOut ? (
          <span>
            {t('trading.orders.minimum')} <b>{formatAmount(order.minOut)}</b>
          </span>
        ) : null}
        {order.priceImpactPct !== null ? (
          <span>
            {t('trading.swap.impact')} <b>{formatPct(order.priceImpactPct)}</b>
          </span>
        ) : null}
        {order.gasUsd !== null ? (
          <span>
            {t('trading.swap.gas')} <b>{formatUsd(order.gasUsd)}</b>
          </span>
        ) : null}
        <span>{shortAge(order.updatedAt, now)}</span>
      </div>
      <div className="trd-order__side">
        <StatusPill status={order.status} />
        {waiting ? (
          <>
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
          </>
        ) : order.explorerUrl ? (
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
      {order.reason &&
      (order.status === 'failed' || order.status === 'rejected' || order.status === 'expired') ? (
        <div className="trd-order__reason">
          {t('trading.orders.reason')}: {order.reason}
        </div>
      ) : null}
    </div>
  )
}
