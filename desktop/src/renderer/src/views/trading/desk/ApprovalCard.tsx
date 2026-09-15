import { ExternalLink, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { desktopApi } from '~/lib/desktop-api'
import { formatAmount, initiatorKey, isAwaitingApproval, shortHash } from '../logic'
import { StatusPill } from '../parts'
import type { Order, Wallet } from '../types'
import { approvalFacts, riskStamp, type Fact } from './desk-logic'

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
}

/**
 * The agent asked; you decide. Facts are bound values from the order, in
 * mono, nothing derived in the renderer: the expiry is printed whole because
 * the engine's sweep owns it. Reject gets focus first (least destructive);
 * a high-risk approve arms and asks for a second click within 4 s.
 */
export function ApprovalCard({
  order,
  wallets,
  deciding,
  onApprove,
  onReject,
  focusOnMount,
}: {
  order: Order
  wallets: readonly Wallet[]
  deciding: boolean
  onApprove: (order: Order) => void
  onReject: (order: Order, reason: string) => void
  focusOnMount: boolean
}) {
  const risk = riskStamp(order)
  const facts = approvalFacts(order, wallets, FACT_LABELS)
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

  return (
    <article
      className="trd-card"
      data-risk={risk}
      data-testid="approval-card"
      data-order={order.orderId}
      aria-labelledby={`trd-card-${order.orderId}`}
    >
      <header className="trd-card__head">
        <h3 id={`trd-card-${order.orderId}`} className="trd-card__title">
          {t('trading.card.title')}
        </h3>
        <span className="trd-card__stamps">
          <span className="trd-stamp">{t(`trading.card.by.${initiatorKey(order.initiator)}`)}</span>
          {risk === 'high' ? (
            <span className="trd-stamp" data-tone="danger" data-testid="risk-high">
              <ShieldAlert className="size-3" strokeWidth={2} aria-hidden />
              {t('trading.card.high')}
            </span>
          ) : null}
          {!live ? <StatusPill status={order.status} /> : null}
        </span>
      </header>

      <p className="trd-card__legs trd-num">
        <b>
          {formatAmount(order.amountIn)} {order.tokenIn.symbol}
        </b>
        <span aria-hidden>→</span>
        <b>
          {order.expectedOut ? `${formatAmount(order.expectedOut)} ` : ''}
          {order.tokenOut.symbol}
        </b>
      </p>

      <dl className="trd-card__facts">
        {facts.map((f: Fact) => (
          <div key={f.key} className="trd-card__fact" data-tone={f.tone}>
            <dt>{f.label}</dt>
            <dd className="trd-mono">{f.value}</dd>
          </div>
        ))}
      </dl>

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
      ) : order.txHash ? (
        <div className="trd-card__actions">
          <span className="trd-card__spacer" />
          <button
            type="button"
            className="trd-card__link"
            onClick={() =>
              order.explorerUrl && void desktopApi().app.openExternal(order.explorerUrl)
            }
          >
            {shortHash(order.txHash)}
            <ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ) : null}
    </article>
  )
}
