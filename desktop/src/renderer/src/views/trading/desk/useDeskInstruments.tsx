import { KeyRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import type { RawJob } from '@/views/cron/logic'
import { Button } from '~/components/ui/button'
import { sessionPath } from '~/components/sidebar/SessionRow'
import { t } from '~/i18n'
import { useNow } from '~/lib/use-now'
import { useOrderDecision, useOrders } from '~/stores/trading'
import { useTradingUi } from '~/stores/trading-ui'
import { useUi } from '~/stores/ui'
import { Notice } from '~/views/settings/parts'
import { errorText, isAwaitingApproval, sameAddress } from '../logic'
import type { Limits, Order, ProviderId, Wallet } from '../types'
import { ApprovalsRegion } from './ApprovalsRegion'
import { ComposerSeats } from './ComposerSeats'
import {
  composerPlaceholder,
  missionStatus,
  ordersForSession,
  rejectionMessage,
  type MissionForm,
  type MissionKind,
} from './desk-logic'
import { MissionContract } from './MissionContract'
import { MissionControls, MissionStrip, missionWord } from './MissionControls'
import { useMissions } from './missions'

const ROTATE_MS = 6000
/** A settled ask stays in the region this long as a stamp. */
const STAMP_TTL_MS = 10 * 60_000

export interface DeskGate {
  needsKey: boolean
  providerBlocked: boolean
  provider: ProviderId
}

/** What the desk hands the chat when the open session is the desk's. */
export interface DeskProps {
  wallets: Wallet[]
  primary: string | null
  limits: Limits | null
  gate: DeskGate
  /** After the first send: files the session into the desk project. */
  onFirstSend: () => void
  /** Start over in a fresh desk chat. */
  onStartFresh: () => void
  onOpenBookTab: (tab: 'portfolio' | 'orders') => void
  onStreaming: (busy: boolean) => void
  onSessionPending: (count: number) => void
}

export interface DeskInstruments {
  /** Between the transcript and the composer: the agent's asks. */
  region: ReactNode
  /** Above the composer: gate notices, the mission strip and controls. */
  dockAbove: ReactNode
  seats: ReactNode
  placeholder: string | undefined
  /** An ask is pending: the desk goes still. */
  still: boolean
  modal: ReactNode
  /** The composer is idle and the thread is empty: the desk's invitation. */
  emptyHint: ReactNode
  onFocusChange: (focused: boolean) => void
}

/**
 * The desk's instruments around the shared chat: everything TradingChat used
 * to own, as slots the ChatView renders in place. Runs with `desk === null`
 * for an ordinary chat (queries disabled, nothing rendered) so the hook order
 * never changes when the mode does — that is what keeps the composer the
 * same node across the switch.
 */
export function useDeskInstruments(
  desk: DeskProps | null,
  ctx: {
    sessionKey: string
    /** Send text straight into the session (no composer round-trip). */
    sendText: (text: string) => void
    /** Submit through the composer's rules (queues while a turn runs). */
    submitText: (text: string) => void
    busy: boolean
    composerValue: string
    idle: boolean
    hasMessages: boolean
    focusOrderId: string | null
    setFocusOrderId: (id: string | null) => void
  },
): DeskInstruments {
  const rpc = useRpc()
  const navigate = useNavigate()
  const location = useLocation()
  const openSettings = useUi((s) => s.openSettings)
  const setBookTab = useTradingUi((s) => s.setBookTab)
  const enabled = desk !== null
  const { sessionKey, sendText, submitText, busy, composerValue, idle, hasMessages, focusOrderId } =
    ctx
  const { setFocusOrderId } = ctx

  useEffect(() => {
    if (desk) desk.onStreaming(busy)
  }, [busy, desk])

  // ── Approvals for this session ──────────────────────────────────────────
  const orders = useOrders(undefined, enabled, 100)
  const sessionOrders = useMemo(
    () => ordersForSession(orders.orders, sessionKey),
    [orders.orders, sessionKey],
  )
  const pendingOrders = useMemo(() => sessionOrders.filter(isAwaitingApproval), [sessionOrders])
  useEffect(() => {
    if (desk) desk.onSessionPending(pendingOrders.length)
  }, [pendingOrders.length, desk])
  const [mountedAt] = useState(() => Date.now())
  const now = useNow(30_000)
  const settled = useMemo(
    () =>
      sessionOrders.filter(
        (o) =>
          !isAwaitingApproval(o) &&
          o.initiator === 'agent' &&
          o.createdAt >= mountedAt &&
          now - o.updatedAt < STAMP_TTL_MS,
      ),
    [sessionOrders, now, mountedAt],
  )
  const decide = useOrderDecision()
  const onApprove = useCallback(
    (order: Order) =>
      decide.mutate(
        { orderId: order.orderId, approve: true },
        {
          onSuccess: () =>
            toast.success(t('trading.approvals.approved'), { id: `trd-order-${order.orderId}` }),
          onError: (err) =>
            toast.error(`${t('trading.approvals.failed')}: ${errorText(err)}`, {
              id: `trd-order-${order.orderId}`,
            }),
        },
      ),
    [decide],
  )
  const onReject = useCallback(
    (order: Order, reason: string) => {
      const clean = reason.trim()
      rpc
        .call('trading.orders.reject', { orderId: order.orderId, reason: clean || 'user' })
        .then(() => {
          toast.success(t('trading.approvals.rejected'), { id: `trd-order-${order.orderId}` })
          // The agent reads the reason where it asked.
          sendText(rejectionMessage(order, clean))
        })
        .catch((err: unknown) =>
          toast.error(`${t('trading.approvals.failed')}: ${errorText(err)}`, {
            id: `trd-order-${order.orderId}`,
          }),
        )
    },
    [rpc, sendText],
  )
  // A notification lands on its card; the URL is cleaned so a reload does not repeat it.
  const orderParam = enabled ? new URLSearchParams(location.search).get('order') : null
  const [seenOrderParam, setSeenOrderParam] = useState<string | null>(null)
  if (orderParam && orderParam !== seenOrderParam) {
    setSeenOrderParam(orderParam)
    setFocusOrderId(orderParam)
  }
  useEffect(() => {
    if (!orderParam || !desk) return
    if (!pendingOrders.some((o) => o.orderId === orderParam)) desk.onOpenBookTab('orders')
    void navigate(sessionPath(sessionKey), { replace: true })
  }, [orderParam, navigate, desk, pendingOrders, sessionKey])

  // ── Missions ────────────────────────────────────────────────────────────
  const missions = useMissions(sessionKey, enabled)
  const [contract, setContract] = useState<{ kind: MissionKind; job?: RawJob | null } | null>(null)
  const missionLine = useMemo(() => {
    const first = missions.missions[0]
    if (!first) return null
    const s = missionStatus(first, {
      running: Boolean(first.id && missions.running.has(first.id)),
      pendingApprovals: pendingOrders.length,
    })
    return `${first.name} · ${missionWord(s.state, s.until)}`
  }, [missions.missions, missions.running, pendingOrders.length])

  // ── Placeholder rotation ────────────────────────────────────────────────
  const [focused, setFocused] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled || focused || composerValue) return
    const id = window.setInterval(() => setTick((n) => n + 1), ROTATE_MS)
    return () => window.clearInterval(id)
  }, [enabled, focused, composerValue])

  if (!desk) {
    return {
      region: null,
      dockAbove: null,
      seats: null,
      placeholder: undefined,
      still: false,
      modal: null,
      emptyHint: null,
      onFocusChange: setFocused,
    }
  }

  const primaryWallet =
    desk.wallets.find((w) => sameAddress(w.address, desk.primary)) ?? desk.wallets[0] ?? null
  const placeholder = composerPlaceholder({
    missionWord: missionLine,
    busy,
    tick,
    steering: t('trading.composer.steering'),
  })

  return {
    still: pendingOrders.length > 0,
    placeholder,
    onFocusChange: setFocused,
    region: (
      <ApprovalsRegion
        pending={pendingOrders}
        settled={settled}
        wallets={desk.wallets}
        deciding={decide.isPending ? (decide.variables?.orderId ?? null) : null}
        onApprove={onApprove}
        onReject={onReject}
        focusOrderId={focusOrderId}
      />
    ),
    dockAbove: (
      <>
        {desk.gate.needsKey ? (
          <Notice
            tone="info"
            action={
              <Button onClick={() => openSettings('trading')} data-testid="chat-add-key">
                <KeyRound className="size-3.5" strokeWidth={1.75} aria-hidden />
                {t('trading.noKey.cta')}
              </Button>
            }
          >
            <b>{t('trading.noKey.title')}</b> {t('trading.noKey.chatBody')}
          </Notice>
        ) : desk.gate.providerBlocked ? (
          <Notice
            tone="warn"
            action={
              <Button onClick={() => openSettings('trading')} data-testid="chat-provider-fix">
                {t('trading.provider.switch')}
              </Button>
            }
          >
            {t('trading.provider.blocked')}
          </Notice>
        ) : null}
        <MissionStrip
          missions={missions.missions}
          running={missions.running}
          pendingApprovals={pendingOrders.length}
        />
        <MissionControls
          missions={missions.missions}
          running={missions.running}
          pendingApprovals={pendingOrders.length}
          busy={missions.busy}
          onStart={() => setContract({ kind: 'custom' })}
          onEdit={(job) => setContract({ kind: 'custom', job })}
          onRun={missions.runNow}
          onSetEnabled={missions.setEnabled}
          onRemove={missions.remove}
        />
      </>
    ),
    seats: (
      <ComposerSeats
        limits={desk.limits}
        provider={desk.gate.provider}
        wallet={primaryWallet}
        typing={composerValue.length > 0}
        onOpenSettings={() => openSettings('trading')}
        onOpenWallets={() => {
          setBookTab('portfolio')
          desk.onOpenBookTab('portfolio')
        }}
        onQuick={(kind) => setContract({ kind })}
      />
    ),
    modal: contract ? (
      <MissionContract
        kind={contract.kind}
        job={contract.job ?? null}
        wallets={desk.wallets}
        primary={desk.primary}
        limits={desk.limits}
        onClose={() => setContract(null)}
        onSend={(prompt) => submitText(prompt)}
        onCreate={(form: MissionForm, prompt) => missions.create(form, prompt)}
        onUpdate={(id, form, prompt) =>
          missions.update(id, {
            name: form.name.trim(),
            text: prompt,
            schedule:
              form.interval.kind === 'every'
                ? { kind: 'every', every_seconds: form.interval.seconds }
                : { kind: 'cron', expr: form.interval.expr.trim() },
          })
        }
      />
    ) : null,
    emptyHint:
      !hasMessages && idle ? (
        <div className="trd-chat__empty" data-testid="chat-empty">
          <p className="trd-chat__empty-title">{t('trading.chat.empty.title')}</p>
          <p>{t('trading.chat.empty.body')}</p>
        </div>
      ) : null,
  }
}
