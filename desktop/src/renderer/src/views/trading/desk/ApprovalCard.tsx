import { ExternalLink, ShieldAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { formatAmount, initiatorKey, isAwaitingApproval, shortAddress, shortHash } from '../logic'
import { StatusPill } from '../parts'
import type { Order, Wallet } from '../types'
import {
  approvalFacts,
  askRisk,
  batchFacts,
  orderKind,
  recipientDisplay,
  sumAmounts,
  type Ask,
  type Fact,
} from './desk-logic'

const ARM_RESET_MS = 4000

const FACT_LABELS: Record<string, string> = {
  wallet: 'Wallet',
  chain: 'Chain',
  pay: 'Pay',
  receive: 'Receive (expected)',
  minimum: 'Receive (minimum)',
  rate: 'Rate',
  value: 'Value',
  impact: 'Price impact',
  gas: 'Gas',
  provider: 'Route via',
  order: 'Order',
  expires: 'Expires',
  to: 'To',
  send: 'Send',
  token: 'Token',
  spender: 'Spender',
  allowance: 'Allowance',
  recipients: 'Recipients',
  total: 'Total',
  batch: 'Batch',
}

function askOf(order: Order, legs: readonly Order[] | undefined): Ask {
  const orders = legs && legs.length ? [...legs] : [order]
  const batch = orders.length > 1 || Boolean(order.batchId && legs && legs.length > 1)
  let totalUsd: number | null = 0
  for (const o of orders) {
    if (o.valueUsd === null) {
      totalUsd = null
      break
    }
    totalUsd += o.valueUsd
  }
  return {
    key: order.batchId || order.orderId,
    kind: orderKind(order),
    lead: order,
    orders,
    batch,
    totalUsd,
    totalAmount: orders.length > 1 ? sumAmounts(orders) : order.amountIn,
  }
}

/**
 * The agent asked; you decide. Facts are bound values from the order, in
 * mono, nothing derived in the renderer: the expiry is printed whole because
 * the engine's sweep owns it. Reject gets focus first (least destructive);
 * a high-risk approve arms and asks for a second click within 4 s.
 *
 * A multisend is one card: `legs` carries every order of the batch, the
 * legs are listed one per line, and the one Approve covers them all — that
 * is what the engine does, so the card may not pretend otherwise.
 */
export function ApprovalCard({
  order,
  legs,
  wallets,
  deciding,
  onApprove,
  onReject,
  focusOnMount,
  onDismiss,
}: {
  order: Order
  /** Every leg of the batch this order belongs to (the order included). */
  legs?: readonly Order[]
  wallets: readonly Wallet[]
  deciding: boolean
  onApprove: (order: Order) => void
  onReject: (order: Order, reason: string) => void
  focusOnMount: boolean
  /** Settled cards only: close this one now instead of waiting it out. */
  onDismiss?: () => void
}) {
  const ask = askOf(order, legs)
  const risk = askRisk(ask)
  const kind = ask.kind
  const facts = ask.batch
    ? batchFacts(ask, wallets, FACT_LABELS)
    : approvalFacts(order, wallets, FACT_LABELS)
  const [armed, setArmed] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const rejectRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const focused = useRef(false)

  useEffect(() => {
    if (focusOnMount && !focused.current) {
      focused.current = true
      rejectRef.current?.focus({ preventScroll: true })
    }
  }, [focusOnMount])

  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), ARM_RESET_MS)
    return () => window.clearTimeout(id)
  }, [armed])

  useEffect(() => {
    if (rejecting) reasonRef.current?.focus({ preventScroll: true })
  }, [rejecting])

  function approve() {
    if (risk === 'high' && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onApprove(order)
  }

  function reject() {
    if (!rejecting) {
      setRejecting(true)
      return
    }
    onReject(order, reason)
  }

  const live = isAwaitingApproval(order)
  const titleKind = ask.batch ? 'multisend' : kind
  const title = live
    ? titleKind === 'swap'
      ? t('trading.card.title')
      : t(`trading.card.title.${titleKind}`)
    : titleKind === 'swap'
      ? t('trading.card.titleSettled')
      : t(`trading.card.titleSettled.${titleKind}`)
  // A settled batch: the status of the whole is the worst of its legs.
  const settledStatus = ask.batch
    ? (ask.orders.find((o) => o.status === 'failed')?.status ??
      ask.orders.find((o) => o.status !== 'confirmed')?.status ??
      order.status)
    : order.status

  return (
    <article
      className="trd-card"
      data-risk={risk}
      data-kind={kind}
      data-batch={ask.batch || undefined}
      data-testid="approval-card"
      data-order={order.orderId}
      aria-labelledby={`trd-card-${order.orderId}`}
    >
      <header className="trd-card__head">
        <h3 id={`trd-card-${order.orderId}`} className="trd-card__title">
          {title}
        </h3>
        <span className="trd-card__stamps">
          <span className="trd-stamp">{t(`trading.card.by.${initiatorKey(order.initiator)}`)}</span>
          {kind === 'send' && live ? (
            <span className="trd-stamp" data-tone="warn" data-testid="stamp-irreversible">
              {t('trading.card.irreversible')}
            </span>
          ) : null}
          {risk === 'high' ? (
            <span className="trd-stamp" data-tone="danger" data-testid="risk-high">
              <ShieldAlert className="size-3" strokeWidth={2} aria-hidden />
              {t('trading.card.high')}
            </span>
          ) : null}
          {!live ? <StatusPill status={settledStatus} /> : null}
          {onDismiss ? (
            <button
              type="button"
              className="trd-card__dismiss app-no-drag"
              onClick={onDismiss}
              aria-label={t('trading.card.dismiss')}
              title={t('trading.card.dismiss')}
              data-testid="card-dismiss"
            >
              <X className="size-3" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </span>
      </header>

      <Legs ask={ask} />

      <dl className="trd-card__facts">
        {facts.map((f: Fact) => (
          <div key={f.key} className="trd-card__fact" data-tone={f.tone}>
            <dt>{f.label}</dt>
            <dd className="trd-mono">{f.value}</dd>
          </div>
        ))}
      </dl>

      {ask.batch ? <Recipients ask={ask} live={live} /> : null}

      {order.note ? (
        <p className="trd-card__note" data-testid="card-note">
          {order.note}
        </p>
      ) : null}
      {order.reason && !live ? <p className="trd-card__note">{order.reason}</p> : null}

      {live ? (
        <div className="trd-card__actions">
          {rejecting ? (
            <input
              ref={reasonRef}
              className="mac-input trd-card__reason"
              placeholder={t('trading.card.reasonPlaceholder')}
              aria-label={t('trading.card.reasonPlaceholder')}
              value={reason}
              maxLength={240}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  // One decision per ask: a second Enter while it is in flight is nothing.
                  if (!deciding) onReject(order, reason)
                }
                if (e.key === 'Escape') setRejecting(false)
              }}
              data-testid="reject-reason"
            />
          ) : null}
          <span className="trd-card__spacer" />
          <Button
            ref={rejectRef}
            variant="secondary"
            disabled={deciding}
            onClick={reject}
            data-testid="card-reject"
          >
            {rejecting ? t('trading.card.rejectSend') : t('trading.approvals.reject')}
          </Button>
          <Button
            variant="primary"
            disabled={deciding}
            onClick={approve}
            data-armed={armed || undefined}
            data-testid="card-approve"
          >
            {armed ? t('trading.card.approveAgain') : t('trading.approvals.approve')}
          </Button>
        </div>
      ) : order.txHash && !ask.batch ? (
        <div className="trd-card__actions">
          <span className="trd-card__spacer" />
          <TxLink hash={order.txHash} url={order.explorerUrl} />
        </div>
      ) : null}
    </article>
  )
}

function TxLink({ hash, url }: { hash: string; url: string | null }) {
  return (
    <button
      type="button"
      className="trd-card__link app-no-drag"
      onClick={() => url && void desktopApi().app.openExternal(url)}
    >
      {shortHash(hash)}
      <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
    </button>
  )
}

/** The headline: what moves, to where. */
function Legs({ ask }: { ask: Ask }) {
  const lead = ask.lead
  if (ask.kind === 'revoke') {
    return (
      <p className="trd-card__legs trd-num" data-testid="card-legs">
        <b>{lead.tokenIn.symbol || shortAddress(lead.tokenIn.address)}</b>
        <span aria-hidden>⛨</span>
        <b>{recipientDisplay(lead) || shortAddress(lead.recipient ?? '')}</b>
      </p>
    )
  }
  if (ask.kind === 'send') {
    return (
      <p className="trd-card__legs trd-num" data-testid="card-legs">
        <b>
          {formatAmount(ask.totalAmount)} {lead.tokenIn.symbol}
        </b>
        <span aria-hidden>→</span>
        <b>
          {ask.batch
            ? `${ask.orders.length} ${t('trading.send.count')}`
            : lead.recipientLabel || shortAddress(lead.recipient ?? '')}
        </b>
      </p>
    )
  }
  return (
    <p className="trd-card__legs trd-num" data-testid="card-legs">
      <b>
        {formatAmount(lead.amountIn)} {lead.tokenIn.symbol}
      </b>
      <span aria-hidden>→</span>
      <b>
        {lead.expectedOut ? `${formatAmount(lead.expectedOut)} ` : ''}
        {lead.tokenOut.symbol}
      </b>
    </p>
  )
}

/**
 * Every leg of a multisend, address in full: the one thing a person must
 * read before approving is where the money goes, and a shortened address
 * is exactly where a lookalike hides.
 */
function Recipients({ ask, live }: { ask: Ask; live: boolean }) {
  return (
    <details
      className="trd-card__legs-list"
      open={ask.orders.length <= 8}
      data-testid="card-legs-list"
    >
      <summary>{t('trading.card.recipients')}</summary>
      <ol>
        {ask.orders.map((leg) => (
          <li key={leg.orderId} data-status={leg.status}>
            <span className="trd-mono trd-card__addr">{leg.recipient ?? ''}</span>
            <b className="trd-num">
              {formatAmount(leg.amountIn)} {leg.tokenIn.symbol}
            </b>
            {!live ? (
              leg.txHash ? (
                <TxLink hash={leg.txHash} url={leg.explorerUrl} />
              ) : leg.status === 'failed' ? (
                <span className="trd-card__legfail" title={leg.reason ?? ''}>
                  {t('trading.card.leg.failed')}
                </span>
              ) : null
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  )
}
