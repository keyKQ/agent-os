import { useEffect, useRef, useState } from 'react'
import { t } from '~/i18n'
import type { Order, Wallet } from '../types'
import { ApprovalCard } from './ApprovalCard'

/**
 * Where the agent's asks dock: between the transcript and the composer, at
 * the point of cause. Height-bounded so a queue of asks can never push the
 * composer off-screen; the region scrolls inside. A card that settles stays
 * for a while as a one-line stamp so the outcome is read where the ask was.
 */
export function ApprovalsRegion({
  pending,
  settled,
  wallets,
  deciding,
  onApprove,
  onReject,
  focusOrderId,
}: {
  pending: Order[]
  settled: Order[]
  wallets: readonly Wallet[]
  deciding: string | null
  onApprove: (order: Order) => void
  onReject: (order: Order, reason: string) => void
  /** From a notification: scroll this order's card into view. */
  focusOrderId: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Reject gets focus once, on the first card that appears — never on every render.
  const [firstSeen, setFirstSeen] = useState<string | null>(null)
  const first = pending[0]?.orderId ?? null
  if (first && first !== firstSeen) setFirstSeen(first)

  useEffect(() => {
    if (!focusOrderId) return
    const el = ref.current?.querySelector<HTMLElement>(`[data-order="${focusOrderId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusOrderId, pending])

  if (pending.length === 0 && settled.length === 0) return null
  return (
    <div
      ref={ref}
      className="trd-asks"
      role="region"
      aria-label={t('trading.card.region')}
      data-testid="approvals-region"
    >
      {pending.map((order) => (
        <ApprovalCard
          key={order.orderId}
          order={order}
          wallets={wallets}
          deciding={deciding === order.orderId}
          onApprove={onApprove}
          onReject={onReject}
          focusOnMount={order.orderId === firstSeen || order.orderId === focusOrderId}
        />
      ))}
      {settled.map((order) => (
        <div key={order.orderId} className="trd-asks__stamp" data-testid="approval-stamp">
          <ApprovalCard
            order={order}
            wallets={wallets}
            deciding={false}
            onApprove={() => {}}
            onReject={() => {}}
            focusOnMount={false}
          />
        </div>
      ))}
    </div>
  )
}
