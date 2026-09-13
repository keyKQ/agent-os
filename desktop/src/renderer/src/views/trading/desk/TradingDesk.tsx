import './desk.css'
import { CandlestickChart, Lock, Wallet as WalletIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useGateway } from '~/stores/gateway'
import { useTradingUi } from '~/stores/trading-ui'
import {
  useLimits,
  usePendingApprovals,
  useTradingInvalidation,
  useTradingStatus,
  useWalletStatus,
  useWallets,
} from '~/stores/trading'
import { useUi } from '~/stores/ui'
import { sameAddress } from '../logic'
import { TradingView } from '../TradingView'
import type { ProviderId } from '../types'
import { WalletSheet, type WalletSheetMode } from '../WalletSheet'
import { Book } from './Book'
import { bookConcession } from './desk-logic'
import { useMissions } from './missions'
import { StatusStrip } from './StatusStrip'
import { TradingChat } from './TradingChat'
import { useTradingSession } from './useTradingSession'

/**
 * The Trading page: a thin status strip, the desk's chat in the centre and
 * the BOOK on the right — or, on the strip's toggle, the full-width desk.
 * The gates before that (gateway, vault, wallets) are one message and the
 * one action that gets you to the next state.
 */
export function TradingDesk() {
  const gatewayState = useGateway((s) => s.status.state)
  if (gatewayState !== 'running') {
    return (
      <div className="trd-state">
        <CandlestickChart className="trd-state__mark size-9" strokeWidth={1.25} aria-hidden />
        <h1>
          {gatewayState === 'starting'
            ? t('chat.waitingGateway')
            : t(`gateway.state.${gatewayState}`)}
        </h1>
        <p>{t('trading.offline.body')}</p>
      </div>
    )
  }
  return <Gate />
}

function Gate() {
  useTradingInvalidation()
  const status = useTradingStatus()
  const vault = useWalletStatus()
  const openSettings = useUi((s) => s.openSettings)
  const [sheet, setSheet] = useState<WalletSheetMode | null>(null)

  if (status.isPending || vault.isPending) return null
  if (status.data && !status.data.enabled) {
    return (
      <State
        icon={
          <CandlestickChart className="trd-state__mark size-9" strokeWidth={1.25} aria-hidden />
        }
        title={t('trading.disabled.title')}
        body={t('trading.disabled.body')}
        action={
          <Button variant="primary" onClick={() => openSettings('trading')}>
            {t('trading.openSettings')}
          </Button>
        }
      />
    )
  }
  const v = vault.data
  if (!v || !v.initialized || !v.unlocked) {
    const locked = Boolean(v && v.initialized)
    return (
      <>
        <State
          icon={<Lock className="trd-state__mark size-9" strokeWidth={1.25} aria-hidden />}
          title={locked ? t('trading.locked.title') : t('trading.setup.title')}
          body={locked ? t('trading.locked.body') : t('trading.setup.body')}
          action={
            <Button
              variant="primary"
              onClick={() => setSheet({ kind: locked ? 'unlock' : 'setup' })}
              data-testid={locked ? 'vault-unlock' : 'vault-setup'}
            >
              {locked ? t('trading.locked.cta') : t('trading.setup.cta')}
            </Button>
          }
        />
        {sheet ? <WalletSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
      </>
    )
  }
  const provider: ProviderId = status.data?.provider ?? 'uniswap'
  const providerStatus = status.data?.providers?.find((p) => p.id === provider)
  return (
    <Frame
      provider={provider}
      providerReady={
        provider === 'uniswap'
          ? Boolean(status.data?.apiKeyConfigured)
          : providerStatus?.blocked !== true
      }
      providerBlocked={providerStatus?.blocked === true}
      needsKey={provider === 'uniswap' && !status.data?.apiKeyConfigured}
      chains={(status.data?.chains ?? []).map((c) => c.chainId)}
      limits={status.data?.limits ?? null}
    />
  )
}

function State({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action: React.ReactNode
}) {
  return (
    <div className="trd-state">
      {icon}
      <h1>{title}</h1>
      <p>{body}</p>
      <div className="trd-state__actions">{action}</div>
    </div>
  )
}

function Frame({
  provider,
  providerReady,
  providerBlocked,
  needsKey,
  chains,
  limits: engineLimits,
}: {
  provider: ProviderId
  providerReady: boolean
  providerBlocked: boolean
  needsKey: boolean
  chains: number[]
  limits: { approvalThresholdUsd: number; dailyCapUsd: number; approvalTtlSeconds: number } | null
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const openSettings = useUi((s) => s.openSettings)
  const vault = useWalletStatus()
  const { wallets, primary, isPending: walletsPending } = useWallets()
  const [sheet, setSheet] = useState<WalletSheetMode | null>(null)
  const deskMode = useTradingUi((s) => s.deskMode)
  const setDeskMode = useTradingUi((s) => s.setDeskMode)
  const bookWidth = useTradingUi((s) => s.bookWidth)
  const bookOpen = useTradingUi((s) => s.bookOpen)
  const setBookWidth = useTradingUi((s) => s.setBookWidth)
  const toggleBook = useTradingUi((s) => s.toggleBook)
  const setBookOpen = useTradingUi((s) => s.setBookOpen)
  const setBookTab = useTradingUi((s) => s.setBookTab)

  // `?desk=1` opens the full desk; the strip toggle flips it and cleans the URL.
  const deskParam = new URLSearchParams(location.search).get('desk')
  useEffect(() => {
    if (deskParam === '1') {
      setDeskMode(true)
      void navigate('/trading', { replace: true })
    }
  }, [deskParam, setDeskMode, navigate])

  const primaryWallet = wallets.find((w) => sameAddress(w.address, primary)) ?? wallets[0] ?? null
  const limits = useLimits(primaryWallet?.address ?? null)
  const sessionCtx = useMemo(
    () => ({
      wallets,
      chains,
      limits: engineLimits
        ? { thresholdUsd: engineLimits.approvalThresholdUsd, dailyCapUsd: engineLimits.dailyCapUsd }
        : null,
    }),
    [wallets, chains, engineLimits],
  )
  const session = useTradingSession(sessionCtx)
  const missions = useMissions(session.sessionKey)
  const globalPending = usePendingApprovals()
  const [streaming, setStreaming] = useState(false)
  const [sessionPending, setSessionPending] = useState(0)

  // Concession chain: the frame measures itself; the chat never yields its floor.
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(0)
  useEffect(() => {
    const node = frameRef.current
    if (!node) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setFrameWidth(w)
    })
    ro.observe(node)
    setFrameWidth(node.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [deskMode])
  const concession = bookConcession(frameWidth || 9999, bookWidth, bookOpen)

  const openBookTab = useCallback(
    (tab: 'portfolio' | 'orders') => {
      setBookTab(tab)
      setBookOpen(true)
    },
    [setBookTab, setBookOpen],
  )

  if (!walletsPending && wallets.length === 0) {
    return (
      <>
        <State
          icon={<WalletIcon className="trd-state__mark size-9" strokeWidth={1.25} aria-hidden />}
          title={t('trading.noWallets.title')}
          body={t('trading.noWallets.body')}
          action={
            <>
              <Button onClick={() => setSheet({ kind: 'import' })}>
                {t('trading.noWallets.import')}
              </Button>
              <Button
                variant="primary"
                onClick={() => setSheet({ kind: 'create' })}
                data-testid="wallet-create"
              >
                {t('trading.noWallets.create')}
              </Button>
            </>
          }
        />
        {sheet ? <WalletSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
      </>
    )
  }

  return (
    <div className="trd-page" data-testid="trading-page">
      <StatusStrip
        missions={missions.missions}
        running={missions.running}
        sessionPending={sessionPending}
        globalPending={globalPending > 0 ? globalPending : null}
        streaming={streaming}
        deskMode={deskMode}
        onToggleDesk={() => setDeskMode(!deskMode)}
        onOpenApprovals={() => {
          if (deskMode) return
          openBookTab('orders')
        }}
      />
      {deskMode ? (
        <div className="trd-page__desk">
          <TradingView />
        </div>
      ) : (
        <div
          className="trd-frame"
          ref={frameRef}
          data-collapsed={concession.collapsed || undefined}
        >
          <TradingChat
            sessionKey={session.sessionKey}
            onFirstSend={session.ensureFiled}
            onStartFresh={session.startFresh}
            wallets={wallets}
            primary={primary}
            limits={limits.data ?? null}
            gate={{ needsKey, providerBlocked, provider }}
            onStreaming={setStreaming}
            onSessionPending={setSessionPending}
            onOpenBookTab={openBookTab}
          />
          <Book
            wallets={wallets}
            primary={primary}
            provider={provider}
            providerReady={providerReady}
            unlocked={Boolean(vault.data?.unlocked)}
            collapsed={concession.collapsed}
            width={concession.book}
            onResize={setBookWidth}
            onToggle={toggleBook}
            onSwitchProvider={() => openSettings('trading')}
            highlightOrder={null}
          />
        </div>
      )}
    </div>
  )
}
