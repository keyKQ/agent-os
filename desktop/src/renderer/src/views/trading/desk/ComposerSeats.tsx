import {
  ArrowLeftRight,
  ChevronDown,
  Lock,
  Rocket,
  Settings2,
  Wallet as WalletIcon,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { MenuItem, MenuSep, PopMenu } from '~/components/menu/PopMenu'
import { t, type MessageKey } from '~/i18n'
import { formatUsd, walletLabel } from '../logic'
import {
  PROVIDERS,
  providerLabel,
  type Limits,
  type ProviderId,
  type ProviderStatus,
  type Wallet,
} from '../types'
import type { MissionKind } from './desk-logic'

/**
 * A one-shot swap is not a mission — it creates no job and turns up in no
 * mission list — so it stays a plain quick action. DCA, dip and rebalance
 * left this row when the mission catalogue took them over: two ways to start
 * the same thing, one of them with fewer defaults, is not a shortcut.
 */
const QUICK: readonly { kind: MissionKind; icon: LucideIcon; key: MessageKey }[] = [
  { kind: 'swap', icon: Zap, key: 'trading.quick.swap' },
]

/**
 * The row above the capsule. The permission seat is display-only on
 * purpose: the chat names the authority it has and can never widen it —
 * that happens in Settings. Quick actions fade while typing so the capsule
 * never reflows under the caret.
 */
export function ComposerSeats({
  limits,
  provider,
  providers,
  switching,
  wallet,
  typing,
  onOpenSettings,
  onOpenWallets,
  onSwitchProvider,
  onStartMission,
  onQuick,
}: {
  limits: Limits | null
  provider: ProviderId
  /** Per-provider facts from trading.status; the menu explains each choice. */
  providers?: readonly ProviderStatus[]
  switching?: boolean
  wallet: Wallet | null
  typing: boolean
  onOpenSettings: () => void
  onOpenWallets: () => void
  /** Switching the swap route is allowed from the desk; limits are not. */
  onSwitchProvider?: (id: ProviderId) => void
  /** Opens the mission contract; rendered as the first chip so it lines up with the capsule. */
  onStartMission?: () => void
  onQuick: (kind: MissionKind) => void
}) {
  return (
    <div className="trd-seats" data-typing={typing || undefined} data-testid="composer-seats">
      <button
        type="button"
        className="trd-seat app-no-drag"
        onClick={onOpenSettings}
        title={t('trading.seat.permission.title')}
        aria-label={t('trading.seat.permission.title')}
        data-testid="permission-seat"
      >
        <Lock className="size-3" strokeWidth={2} aria-hidden />
        <span className="trd-seat__text">
          {limits
            ? `${t('trading.seat.asksAbove')} ${formatUsd(limits.thresholdUsd)} · ${formatUsd(
                limits.dailyCapUsd,
              )}${t('trading.seat.perDay')}`
            : t('trading.seat.permission.unknown')}
        </span>
      </button>
      <ProviderSeat
        provider={provider}
        providers={providers ?? []}
        switching={Boolean(switching)}
        onSwitch={onSwitchProvider}
        onOpenSettings={onOpenSettings}
      />
      <button
        type="button"
        className="trd-seat app-no-drag"
        onClick={onOpenWallets}
        title={t('trading.seat.wallet.title')}
        data-testid="wallet-seat"
      >
        <WalletIcon className="size-3" strokeWidth={2} aria-hidden />
        <span className="trd-seat__text">
          {wallet ? walletLabel(wallet) : t('trading.seat.noWallet')}
        </span>
      </button>
      <span className="trd-seats__spacer" />
      <div className="trd-quick" role="group" aria-label={t('trading.quick.title')}>
        {onStartMission ? (
          <button
            type="button"
            className="trd-quick__chip trd-quick__chip--mission app-no-drag"
            onClick={onStartMission}
            data-testid="mission-start"
            tabIndex={typing ? -1 : 0}
          >
            <Rocket className="size-3" strokeWidth={2} aria-hidden />
            {t('trading.mission.start')}
          </button>
        ) : null}
        {QUICK.map(({ kind, icon: Icon, key }) => (
          <button
            key={kind}
            type="button"
            className="trd-quick__chip app-no-drag"
            onClick={() => onQuick(kind)}
            data-testid={`quick-${kind}`}
            tabIndex={typing ? -1 : 0}
          >
            <Icon className="size-3" strokeWidth={2} aria-hidden />
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Which aggregator routes the swaps, changeable right here (it is not a limit). */
function ProviderSeat({
  provider,
  providers,
  switching,
  onSwitch,
  onOpenSettings,
}: {
  provider: ProviderId
  providers: readonly ProviderStatus[]
  switching: boolean
  onSwitch?: (id: ProviderId) => void
  onOpenSettings: () => void
}) {
  // The anchor rect is captured on click, so no ref is read during render.
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const facts = (id: ProviderId): string => {
    const row = providers.find((p) => p.id === id)
    if (!row) return ''
    if (row.blocked) return t('trading.seat.provider.blocked')
    if (row.needsKey) {
      return row.keyConfigured
        ? t('trading.seat.provider.keyOk')
        : t('trading.seat.provider.needsKey')
    }
    return t('trading.seat.provider.noKey')
  }
  return (
    <div className="trd-seat__anchor">
      <button
        ref={triggerRef}
        type="button"
        className="trd-seat app-no-drag"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor((a) => (a ? null : rect))
        }}
        title={t('trading.seat.provider.title')}
        aria-label={t('trading.seat.provider.title')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={switching}
        data-testid="provider-seat"
      >
        <ArrowLeftRight className="size-3" strokeWidth={2} aria-hidden />
        <span className="trd-seat__text">{providerLabel(provider)}</span>
        <ChevronDown className="size-3 opacity-70" strokeWidth={2} aria-hidden />
      </button>
      {anchor ? (
        // Anchored so it flips above the seat: the composer sits at the window's foot.
        <PopMenu
          place={{ anchor, align: 'start' }}
          triggerRef={triggerRef}
          onClose={() => setAnchor(null)}
          label={t('trading.seat.provider.title')}
        >
          {PROVIDERS.map((p) => (
            <MenuItem
              key={p.id}
              role="menuitemradio"
              checked={p.id === provider}
              label={p.label}
              aside={facts(p.id)}
              onSelect={() => {
                setAnchor(null)
                if (p.id !== provider) onSwitch?.(p.id)
              }}
            />
          ))}
          <MenuSep />
          <MenuItem
            icon={Settings2}
            label={t('trading.seat.provider.settings')}
            onSelect={() => {
              setAnchor(null)
              onOpenSettings()
            }}
          />
        </PopMenu>
      ) : null}
    </div>
  )
}
