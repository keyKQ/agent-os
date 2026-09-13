import { Lock, Repeat, Scale, TrendingDown, Wallet as WalletIcon, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { t, type MessageKey } from '~/i18n'
import { formatUsd, walletLabel } from '../logic'
import { providerLabel, type Limits, type ProviderId, type Wallet } from '../types'
import type { MissionKind } from './desk-logic'

const QUICK: readonly { kind: MissionKind; icon: LucideIcon; key: MessageKey }[] = [
  { kind: 'swap', icon: Zap, key: 'trading.quick.swap' },
  { kind: 'dca', icon: Repeat, key: 'trading.quick.dca' },
  { kind: 'dip', icon: TrendingDown, key: 'trading.quick.dip' },
  { kind: 'rebalance', icon: Scale, key: 'trading.quick.rebalance' },
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
  wallet,
  typing,
  onOpenSettings,
  onOpenWallets,
  onQuick,
}: {
  limits: Limits | null
  provider: ProviderId
  wallet: Wallet | null
  typing: boolean
  onOpenSettings: () => void
  onOpenWallets: () => void
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
              )}${t('trading.seat.perDay')} · ${providerLabel(provider)}`
            : providerLabel(provider)}
        </span>
      </button>
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
