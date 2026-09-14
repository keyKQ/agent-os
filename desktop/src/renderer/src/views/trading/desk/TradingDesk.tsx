import './desk.css'
import { CandlestickChart, Lock, Wallet as WalletIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '~/components/ui/button'
import { sessionPath } from '~/components/sidebar/SessionRow'
import { t } from '~/i18n'
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
import type { ProviderId } from '../types'
import { WalletSheet, type WalletSheetMode } from '../WalletSheet'
import { Book } from './Book'
import { bookConcession } from './desk-logic'
import { useMissions } from './missions'
import type { DeskMode } from './mode-logic'
import { StatusStrip } from './StatusStrip'
import type { DeskProps } from './useDeskInstruments'
import { useTradingSession } from './useTradingSession'

/**
 * Everything Trading mode adds around the chat, as one hook so the session
 * route can keep ONE tree in both modes — the ChatView (and its composer)
 * stays the same node across the switch; only what surrounds it changes.
 * With `active === false` every query is off and every slot is null.
 *
 * The gates before the desk — trading off, vault to set up or unlock, no
 * wallet — are one banner over the chat with the one action that gets you
 * on; the chat itself stays usable underneath.
 */
export function useDeskFrame(input: {
  sessionKey: string
  active: boolean
  entering: boolean
  onSwitchMode: (next: DeskMode) => void
  onSessionPending: (count: number) => void
}): {
  strip: ReactNode
  banner: ReactNode
  desk: DeskProps | null
  book: ReactNode
  /** The full-width desk replaces chat + BOOK (the strip's Desk toggle, `?desk=1`). */
  fullDesk: boolean
  sheet: ReactNode
  frameRef: React.RefObject<HTMLDivElement | null>
  collapsed: boolean
} {
  const { sessionKey, active, entering, onSwitchMode, onSessionPending } = input
  useTradingInvalidation()
  const status = useTradingStatus()
  const vault = useWalletStatus()
  const openSettings = useUi((s) => s.openSettings)
  const location = useLocation()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<WalletSheetMode | null>(null)

  const disabled = Boolean(status.data && !status.data.enabled)
  const v = vault.data
  const vaultReady = Boolean(v && v.initialized && v.unlocked)
  const locked = Boolean(v && v.initialized && !v.unlocked)
  const ready = active && !disabled && vaultReady
  const provider: ProviderId = status.data?.provider ?? 'uniswap'
  const providerStatus = status.data?.providers?.find((p) => p.id === provider)
  const providerReady =
    provider === 'uniswap'
      ? Boolean(status.data?.apiKeyConfigured)
      : providerStatus?.blocked !== true
  const providerBlocked = providerStatus?.blocked === true
  const needsKey = provider === 'uniswap' && !status.data?.apiKeyConfigured
  const chains = useMemo(
    () => (status.data?.chains ?? []).map((c) => c.chainId),
    [status.data?.chains],
  )
  const engineLimits = status.data?.limits ?? null

  const { wallets, primary, isPending: walletsPending } = useWallets(ready)
  const fullDesk = useTradingUi((s) => s.deskMode)
  const setDeskMode = useTradingUi((s) => s.setDeskMode)
  const bookWidth = useTradingUi((s) => s.bookWidth)
  const bookOpen = useTradingUi((s) => s.bookOpen)
  const setBookWidth = useTradingUi((s) => s.setBookWidth)
  const toggleBook = useTradingUi((s) => s.toggleBook)
  const setBookOpen = useTradingUi((s) => s.setBookOpen)
  const setBookTab = useTradingUi((s) => s.setBookTab)

  // `?desk=1` opens the full desk; the strip toggle flips it and cleans the URL.
  const deskParam = active ? new URLSearchParams(location.search).get('desk') : null
  useEffect(() => {
    if (deskParam === '1') {
      setDeskMode(true)
      void navigate(sessionPath(sessionKey), { replace: true })
    }
  }, [deskParam, setDeskMode, navigate, sessionKey])

  const primaryWallet = wallets.find((w) => sameAddress(w.address, primary)) ?? wallets[0] ?? null
  const limits = useLimits(ready ? (primaryWallet?.address ?? null) : null)
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
  const session = useTradingSession(sessionCtx, active)
  const missions = useMissions(sessionKey, ready)
  const globalPending = usePendingApprovals()
  const [streaming, setStreaming] = useState(false)
  const [sessionPending, setSessionPending] = useState(0)
  const reportPending = useCallback(
    (n: number) => {
      setSessionPending(n)
      onSessionPending(n)
    },
    [onSessionPending],
  )

  // Concession chain: the frame measures itself; the chat never yields its floor.
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(0)
  useEffect(() => {
    const node = frameRef.current
    if (!node || !active) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setFrameWidth(w)
    })
    ro.observe(node)
    setFrameWidth(node.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [active, fullDesk])
  const concession = bookConcession(frameWidth || 9999, bookWidth, bookOpen)

  const openBookTab = useCallback(
    (tab: 'portfolio' | 'orders') => {
      setBookTab(tab)
      setBookOpen(true)
    },
    [setBookTab, setBookOpen],
  )

  if (!active) {
    return {
      strip: <StatusStrip mode="chat" onSwitchMode={onSwitchMode} />,
      banner: null,
      desk: null,
      book: null,
      fullDesk: false,
      sheet: null,
      frameRef,
      collapsed: false,
    }
  }

  let banner: ReactNode = null
  if (disabled) {
    banner = (
      <GateBanner
        icon={<CandlestickChart className="size-4" strokeWidth={1.75} aria-hidden />}
        title={t('trading.disabled.title')}
        body={t('trading.disabled.body')}
        action={
          <Button variant="primary" onClick={() => openSettings('trading')}>
            {t('trading.openSettings')}
          </Button>
        }
      />
    )
  } else if (!status.isPending && !vault.isPending && !vaultReady) {
    banner = (
      <GateBanner
        icon={<Lock className="size-4" strokeWidth={1.75} aria-hidden />}
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
    )
  } else if (ready && !walletsPending && wallets.length === 0) {
    banner = (
      <GateBanner
        icon={<WalletIcon className="size-4" strokeWidth={1.75} aria-hidden />}
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
    )
  }
  const bookReady = ready && wallets.length > 0

  const desk: DeskProps = {
    entering,
    wallets,
    primary,
    limits: limits.data ?? null,
    gate: { needsKey, providerBlocked, provider },
    onFirstSend: session.ensureFiled,
    onStartFresh: session.startFresh,
    onOpenBookTab: openBookTab,
    onStreaming: setStreaming,
    onSessionPending: reportPending,
  }

  return {
    strip: (
      <StatusStrip
        mode="trading"
        onSwitchMode={onSwitchMode}
        missions={missions.missions}
        running={missions.running}
        sessionPending={sessionPending}
        globalPending={globalPending > 0 ? globalPending : null}
        streaming={streaming}
        deskMode={fullDesk}
        onToggleDesk={() => setDeskMode(!fullDesk)}
        onOpenApprovals={() => {
          if (fullDesk) return
          openBookTab('orders')
        }}
      />
    ),
    banner,
    desk,
    book: bookReady ? (
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
        entering={entering}
      />
    ) : null,
    fullDesk,
    sheet: sheet ? <WalletSheet mode={sheet} onClose={() => setSheet(null)} /> : null,
    frameRef,
    collapsed: concession.collapsed,
  }
}

function GateBanner({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode
  title: string
  body: string
  action: ReactNode
}) {
  return (
    <div className="trd-gate" role="status" data-testid="desk-gate">
      <span className="trd-gate__mark">{icon}</span>
      <div className="trd-gate__text">
        <b>{title}</b>
        <span>{body}</span>
      </div>
      <div className="trd-gate__actions">{action}</div>
    </div>
  )
}
