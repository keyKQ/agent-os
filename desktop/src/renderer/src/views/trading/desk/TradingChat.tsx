import { KeyRound, RotateCcw, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useRpc } from '@/app/providers'
import { PendingQueue } from '@/views/chat/PendingQueue'
import { SlashMenu, type SlashMenuHandle } from '@/views/chat/SlashMenu'
import { hasPendingAttachmentWork, type PendingAttachment } from '@/views/chat/logic'
import { resetSession as requestSessionReset } from '@/views/chat/resetSession'
import { useApprovalPending } from '@/views/chat/useApprovalPending'
import { usePendingQueue, type PendingComposerBridge } from '@/views/chat/usePendingQueue'
import { useSlashCommands } from '@/views/chat/useSlashCommands'
import { useTranscript } from '@/views/chat/useTranscript'
import type { RawJob } from '@/views/cron/logic'
import '@/i18n/en/chat'
import { Composer, type ComposerHandle } from '~/components/composer/Composer'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useNow } from '~/lib/use-now'
import { useLive } from '~/stores/live'
import { useSettings } from '~/stores/settings'
import { useTradingUi } from '~/stores/trading-ui'
import { useOrderDecision, useOrders } from '~/stores/trading'
import { useUi } from '~/stores/ui'
import { Notice } from '~/views/settings/parts'
import { errorText, isAwaitingApproval, sameAddress } from '../logic'
import type { Limits, Order, ProviderId, Wallet } from '../types'
import { ApprovalsRegion } from './ApprovalsRegion'
import { ComposerSeats } from './ComposerSeats'
import {
  composerPlaceholder,
  ordersForSession,
  rejectionMessage,
  type MissionForm,
  type MissionKind,
} from './desk-logic'
import { MissionContract } from './MissionContract'
import { MissionControls, MissionStrip, missionWord } from './MissionControls'
import { missionStatus } from './desk-logic'
import { useMissions } from './missions'
import { useTradeLedger } from './useTradeLedger'

const ROTATE_MS = 6000
/** A settled ask stays in the region this long as a stamp. */
const STAMP_TTL_MS = 10 * 60_000

export interface ChatGate {
  needsKey: boolean
  providerBlocked: boolean
  provider: ProviderId
}

/**
 * The centre of the desk: the conversation with the agent that trades.
 * The transcript, composer, slash menu and pending queue are the shared
 * console implementation; around them sit the desk's own instruments —
 * seats, mission strip and controls, the approvals region, ledger rows.
 */
export function TradingChat({
  sessionKey,
  onFirstSend,
  onStartFresh,
  wallets,
  primary,
  limits,
  gate,
  onStreaming,
  onSessionPending,
  onOpenBookTab,
}: {
  sessionKey: string
  onFirstSend: () => void
  onStartFresh: () => void
  wallets: Wallet[]
  primary: string | null
  limits: Limits | null
  gate: ChatGate
  onStreaming: (busy: boolean) => void
  onSessionPending: (count: number) => void
  onOpenBookTab: (tab: 'portfolio' | 'orders') => void
}) {
  const rpc = useRpc()
  const navigate = useNavigate()
  const location = useLocation()
  const openSettings = useUi((s) => s.openSettings)
  const enterToSend = useSettings((s) => s.settings.general.enterToSend)

  // ── Transcript + composer (shared hooks) ────────────────────────────────
  const [composerValue, setComposerValue] = useState('')
  const [focused, setFocused] = useState(false)
  const slashHandleRef = useRef<SlashMenuHandle>(null)
  const slashListboxId = useId()
  const [slashActiveDescendant, setSlashActiveDescendant] = useState<string>()
  const composerHandleRef = useRef<ComposerHandle>(null)
  const regenerateMessageRef = useRef<(text: string) => void>(() => {})
  const editMessage = useCallback((text: string) => {
    composerHandleRef.current?.setValue(text)
    composerHandleRef.current?.focus()
    setComposerValue(text)
  }, [])
  const regenerateMessage = useCallback((text: string) => regenerateMessageRef.current(text), [])
  const [toolModal, setToolModal] = useState<string | null>(null)
  const openToolResultModal = useCallback((_title: string, html: string) => {
    const template = document.createElement('template')
    template.innerHTML = html
    setToolModal(template.content.textContent || '')
  }, [])

  const [focusOrderId, setFocusOrderId] = useState<string | null>(null)
  const onFocusApproval = useCallback((id: string | null) => {
    if (id) setFocusOrderId(id)
  }, [])
  const { seams, bind: bindLedger } = useTradeLedger(onFocusApproval)

  const {
    containerRef,
    routerFxDockRef,
    send,
    abort,
    busy,
    routerFxEnabled,
    setRouterFxEnabled,
    history,
    runState,
    isCompactInFlightForCurrentSession,
    setStreamIdlePausedForApproval,
    setPendingDelegates,
  } = useTranscript({
    sessionKey,
    seams,
    openModal: openToolResultModal,
    onEditMessage: editMessage,
    onRegenerateMessage: regenerateMessage,
  })
  // The ledger decorates the same element the transcript renders into.
  useEffect(() => {
    bindLedger(containerRef.current)
  })

  useEffect(() => {
    if (routerFxEnabled) setRouterFxEnabled(false)
  }, [routerFxEnabled, setRouterFxEnabled])
  useEffect(() => onStreaming(busy), [busy, onStreaming])
  const setLive = useLive((s) => s.setLive)
  useEffect(() => {
    setLive(sessionKey, busy)
    return () => setLive(sessionKey, false)
  }, [sessionKey, busy, setLive])

  const pendingIntentRef = useRef<string | null>(null)
  const sendDrainedHeadRef = useRef<
    (text: string, atts: PendingAttachment[], intent: string | null) => void
  >(() => {})
  const bridge: PendingComposerBridge = {
    getComposerText: () => composerHandleRef.current?.getValue() ?? '',
    setComposerText: (text) => {
      composerHandleRef.current?.setValue(text)
      setComposerValue(text)
    },
    getAttachments: () => [],
    setAttachments: () => {},
    getIntent: () => pendingIntentRef.current,
    setIntent: (intent) => {
      pendingIntentRef.current = intent
    },
    sendDrainedHead: (text, atts, intent) => sendDrainedHeadRef.current(text, atts, intent),
    isStreaming: () => busy,
    isCompactInFlight: () => isCompactInFlightForCurrentSession(),
  }
  const pending = usePendingQueue(bridge)
  useApprovalPending(sessionKey, setStreamIdlePausedForApproval)
  useEffect(() => {
    setPendingDelegates({
      schedulePendingDrainAfterTerminal: pending.scheduleDrainAfterTerminal,
      popAllPendingIntoComposer: pending.popAllIntoComposer,
      pendingQueueLength: () => pending.length,
    })
  }, [
    setPendingDelegates,
    pending.scheduleDrainAfterTerminal,
    pending.popAllIntoComposer,
    pending.length,
  ])

  const abortAndRecover = useCallback(() => {
    abort('desktop_trading_stop')
    const recovered = pending.popAllIntoComposer()
    toast.warning(recovered ? 'Stopped — pending recovered to input' : 'Stopped', {
      duration: 1800,
    })
  }, [abort, pending])

  const { commands, execute: executeSlash } = useSlashCommands({
    sessionKey,
    onSessionAction: () => {},
  })

  const sentOnce = useRef(false)
  const sendText = useCallback(
    (text: string) => {
      send(text, [], pendingIntentRef.current)
      pendingIntentRef.current = null
      if (!sentOnce.current) {
        sentOnce.current = true
        onFirstSend()
      }
    },
    [send, onFirstSend],
  )

  const onComposerSend = useCallback(
    async (rawText: string) => {
      let text = rawText
      let literal = false
      if (text.startsWith('//')) {
        literal = true
        text = text.slice(1)
      }
      const isSlash = !literal && text.startsWith('/')
      if (busy || isCompactInFlightForCurrentSession()) {
        if (isSlash) {
          toast.warning('Wait for the current response before running a command.', {
            duration: 2500,
          })
          return
        }
        if (!text.trim()) return
        if (pending.enqueue({ text, attachments: [], intent: pendingIntentRef.current }))
          setComposerValue('')
        return
      }
      if (isSlash) {
        setComposerValue('')
        if (await executeSlash(text)) return
      }
      setComposerValue('')
      sendText(text)
    },
    [busy, isCompactInFlightForCurrentSession, pending, executeSlash, sendText],
  )
  useEffect(() => {
    regenerateMessageRef.current = (text) => void onComposerSend(text)
  }, [onComposerSend])
  useEffect(() => {
    sendDrainedHeadRef.current = (text, atts, intent) => send(text, atts, intent)
  }, [send])

  const onSlashKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
      slashHandleRef.current?.handleKeyDown(e) ?? false,
    [],
  )
  const onMenuExecute = useCallback(
    (text: string) => {
      composerHandleRef.current?.clear()
      setComposerValue('')
      void onComposerSend(text)
    },
    [onComposerSend],
  )
  const onEnqueueCurrent = useCallback(() => {
    const text = composerHandleRef.current?.getValue() ?? ''
    if (!text) return
    if (pending.enqueue({ text, attachments: [], intent: pendingIntentRef.current }))
      setComposerValue('')
  }, [pending])

  // Bulk history inserts must not replay the enter animation (see ChatView);
  // the same observer knows whether the thread holds any message at all.
  const [hasMessages, setHasMessages] = useState(false)
  useEffect(() => {
    const th = containerRef.current
    if (!th) return
    const observer = new MutationObserver((records) => {
      const added: HTMLElement[] = []
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement && node.classList.contains('msg')) added.push(node)
        })
      }
      if (added.length > 1) for (const el of added) el.dataset.enter = 'none'
      setHasMessages(th.querySelector('.msg') !== null)
    })
    observer.observe(th, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [containerRef, sessionKey])

  // ── Approvals for this session ──────────────────────────────────────────
  const orders = useOrders(undefined, true, 100)
  const sessionOrders = useMemo(
    () => ordersForSession(orders.orders, sessionKey),
    [orders.orders, sessionKey],
  )
  const pendingOrders = useMemo(() => sessionOrders.filter(isAwaitingApproval), [sessionOrders])
  useEffect(() => onSessionPending(pendingOrders.length), [pendingOrders.length, onSessionPending])
  // Stamps: agent asks raised while this desk was open that settled recently.
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
  const orderParam = new URLSearchParams(location.search).get('order')
  const [seenOrderParam, setSeenOrderParam] = useState<string | null>(null)
  if (orderParam && orderParam !== seenOrderParam) {
    setSeenOrderParam(orderParam)
    setFocusOrderId(orderParam)
  }
  useEffect(() => {
    if (!orderParam) return
    if (!pendingOrders.some((o) => o.orderId === orderParam)) onOpenBookTab('orders')
    void navigate('/trading', { replace: true })
  }, [orderParam, navigate, onOpenBookTab, pendingOrders])

  // ── Missions ────────────────────────────────────────────────────────────
  const missions = useMissions(sessionKey)
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
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (focused || composerValue) return
    const id = window.setInterval(() => setTick((n) => n + 1), ROTATE_MS)
    return () => window.clearInterval(id)
  }, [focused, composerValue])
  const placeholder = composerPlaceholder({
    missionWord: missionLine,
    busy,
    tick,
    steering: t('trading.composer.steering'),
  })

  const primaryWallet = wallets.find((w) => sameAddress(w.address, primary)) ?? wallets[0] ?? null
  const still = pendingOrders.length > 0
  const setBookTab = useTradingUi((s) => s.setBookTab)

  return (
    <section
      className="trd-chat"
      data-still={still || undefined}
      aria-label={t('trading.chat.title')}
    >
      <header className="trd-chat__head">
        <h1 className="trd-chat__title">{t('trading.chat.title')}</h1>
        {runState.status !== 'idle' ? (
          <span className="trd-chat__run" data-status={runState.status}>
            {runState.label}
          </span>
        ) : null}
        <span className="trd-chat__spacer" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('trading.chat.fresh')}
          title={t('trading.chat.fresh')}
          onClick={onStartFresh}
          data-testid="chat-fresh"
        >
          <SquarePen className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('chat.reset')}
          title={t('chat.reset')}
          onClick={() => void requestSessionReset(rpc, sessionKey)}
        >
          <RotateCcw className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </Button>
      </header>

      <div className="trd-chat__stage">
        <div
          className="chat-thread trd-chat__thread"
          ref={containerRef}
          data-history-ready="false"
        />
        <div className="chat-history-loading" role="status" aria-live="polite">
          <span className="chat-history-loading__dot" aria-hidden="true" />
          <span>{t('trading.chat.opening')}</span>
        </div>
        <EmptyHint visible={!hasMessages && runState.status === 'idle'} />
      </div>

      <ApprovalsRegion
        pending={pendingOrders}
        settled={settled}
        wallets={wallets}
        deciding={decide.isPending ? (decide.variables?.orderId ?? null) : null}
        onApprove={onApprove}
        onReject={onReject}
        focusOrderId={focusOrderId}
      />

      <div className="trd-chat__dock">
        {gate.needsKey ? (
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
        ) : gate.providerBlocked ? (
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
        <PendingQueue
          queue={pending.queue}
          onRemove={pending.remove}
          onClearAll={pending.clearAll}
        />
        <Composer
          enterToSend={enterToSend}
          onSend={onComposerSend}
          onValueChange={setComposerValue}
          onSlashKeyDown={onSlashKeyDown}
          composerRef={composerHandleRef}
          slashListboxId={slashListboxId}
          slashActiveDescendant={slashActiveDescendant}
          slashMenu={
            <SlashMenu
              value={composerValue}
              commands={commands}
              onExecute={onMenuExecute}
              handleRef={slashHandleRef}
              listboxId={slashListboxId}
              onActiveDescendantChange={setSlashActiveDescendant}
            />
          }
          onAbort={abortAndRecover}
          busy={busy}
          history={history}
          pendingCount={pending.length}
          onRecoverPending={pending.popAllIntoComposer}
          onPopPendingTail={pending.popTail}
          onEnqueueCurrent={onEnqueueCurrent}
          pendingCompaction={isCompactInFlightForCurrentSession()}
          hasPendingAttachments={false}
          hasPendingWork={hasPendingAttachmentWork([])}
          routerFxDock={<div className="chat-routerfx-dock" ref={routerFxDockRef} />}
          placeholder={placeholder}
          onFocusChange={setFocused}
          autoFocus={false}
          seats={
            <ComposerSeats
              limits={limits}
              provider={gate.provider}
              wallet={primaryWallet}
              typing={composerValue.length > 0}
              onOpenSettings={() => openSettings('trading')}
              onOpenWallets={() => {
                setBookTab('portfolio')
                onOpenBookTab('portfolio')
              }}
              onQuick={(kind) => setContract({ kind })}
            />
          }
        />
      </div>

      {contract ? (
        <MissionContract
          kind={contract.kind}
          job={contract.job ?? null}
          wallets={wallets}
          primary={primary}
          limits={limits}
          onClose={() => setContract(null)}
          onSend={(prompt) => void onComposerSend(prompt)}
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
      ) : null}

      {toolModal !== null ? (
        <div className="trd-toolmodal" role="dialog" aria-label={t('trading.chat.toolOutput')}>
          <div className="trd-toolmodal__panel">
            <pre className="chat-tool-result-full">{toolModal}</pre>
            <Button onClick={() => setToolModal(null)}>{t('trading.sheet.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function EmptyHint({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div className="trd-chat__empty" data-testid="chat-empty">
      <p className="trd-chat__empty-title">{t('trading.chat.empty.title')}</p>
      <p>{t('trading.chat.empty.body')}</p>
    </div>
  )
}
