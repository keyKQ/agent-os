import {
  ArrowDownUp,
  ChevronDown,
  CircleCheck,
  ShieldAlert,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useNow } from '~/lib/use-now'
import { useBalances, useQuote, type QuoteParams } from '~/stores/trading'
import { ConfirmSwap } from './ConfirmSwap'
import {
  amountFromPct,
  compareAmounts,
  formatAmount,
  formatPct,
  formatUsd,
  impactTone,
  isPositiveAmount,
  parseAmount,
  quoteCountdown,
  sameAddress,
  sameToken,
  walletLabel,
} from './logic'
import { TokenLogo } from './parts'
import { nativeToken, TokenPicker } from './TokenPicker'
import {
  CHAINS,
  PROVIDER_BLOCKED_CODE,
  providerLabel,
  type Balance,
  type ChainId,
  type Order,
  type ProviderId,
  type Token,
  type Wallet,
} from './types'

/** What the provider flagged about this pair (a transfer fee, say): shown, never hidden. */
export function QuoteWarnings({ warnings }: { warnings: string[] | undefined }) {
  const rows = (warnings ?? []).map((w) => String(w).trim()).filter(Boolean)
  if (rows.length === 0) return null
  return (
    <ul className="trd-warnings" role="status" data-testid="quote-warnings">
      {rows.map((w) => (
        <li key={w}>
          <TriangleAlert className="size-3" strokeWidth={2} aria-hidden />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  )
}

/** The gateway's geo-block error, whatever wrapper the transport put around it. */
export function isProviderBlocked(err: unknown): boolean {
  if (!err) return false
  const code = (err as { code?: unknown }).code
  if (code === PROVIDER_BLOCKED_CODE) return true
  const text = err instanceof Error ? err.message : String(err)
  return text.includes(PROVIDER_BLOCKED_CODE)
}

export interface SwapPrefill {
  chainId: number
  tokenIn?: Token
  tokenOut?: Token
  wallet?: string
  /** Bumps so the same prefill can be applied twice. */
  seq: number
}

type Slippage = 'auto' | string

/**
 * The ticket. One wallet, one chain, two legs, a live price with its age
 * on the button. It never sends anything itself: Review opens the confirm
 * sheet, which is the only place a swap leaves from.
 */
export function SwapPanel({
  wallets,
  primary,
  selectedWallet,
  provider,
  providerReady,
  onSwitchProvider,
  unlocked,
  prefill,
  onSent,
}: {
  wallets: Wallet[]
  primary: string | null
  /** The rail's selection: an address, or 'all'. */
  selectedWallet: string
  provider: ProviderId
  /** Uniswap has its key, or Kyber is not known to be blocked. */
  providerReady: boolean
  /** Opens Settings › Trading, the one place a blocked provider is fixed. */
  onSwitchProvider: () => void
  unlocked: boolean
  prefill: SwapPrefill | null
  onSent: (orders: Order[]) => void
}) {
  const [chainId, setChainId] = useState<ChainId>(8453)
  const [tokenIn, setTokenIn] = useState<Token | null>(nativeToken(8453))
  const [tokenOut, setTokenOut] = useState<Token | null>(null)
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState<Slippage>('auto')
  const [picker, setPicker] = useState<'in' | 'out' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const now = useNow(1000)

  // The rail's choice follows into the ticket ("all" means the primary)
  // until the ticket's own menu overrides it; a new rail choice resets that.
  const [walletChoice, setWalletChoice] = useState<{ base: string; override: string | null }>({
    base: selectedWallet,
    override: null,
  })
  if (walletChoice.base !== selectedWallet) {
    setWalletChoice({ base: selectedWallet, override: null })
  }
  const followed =
    selectedWallet !== 'all' ? selectedWallet : (primary ?? wallets[0]?.address ?? '')
  const wallet = walletChoice.override ?? followed
  const setWallet = (address: string) =>
    setWalletChoice((c) => ({ ...c, override: address || null }))

  // A row's Swap button fills the ticket: applied once per prefill.
  const [appliedSeq, setAppliedSeq] = useState<number | null>(null)
  if (prefill && prefill.seq !== appliedSeq) {
    setAppliedSeq(prefill.seq)
    if (prefill.chainId === 8453 || prefill.chainId === 4663) setChainId(prefill.chainId)
    if (prefill.tokenIn) setTokenIn(prefill.tokenIn)
    else if (prefill.tokenOut) setTokenIn(nativeToken(prefill.chainId))
    if (prefill.tokenOut !== undefined) setTokenOut(prefill.tokenOut ?? null)
    if (prefill.wallet) setWalletChoice((c) => ({ ...c, override: prefill.wallet ?? null }))
    setAmount('')
  }

  function pickChain(next: ChainId) {
    if (next === chainId) return
    setChainId(next)
    setTokenIn(nativeToken(next))
    setTokenOut(null)
    setAmount('')
  }

  const parsed = parseAmount(amount)
  // The ticket reads the paying wallet's own balances, never the rail's mix.
  const { balances } = useBalances(wallet || undefined, Boolean(wallet))
  const available: Balance | null = useMemo(
    () => balances.find((b) => b.chainId === chainId && sameToken(b.token, tokenIn)) ?? null,
    [balances, chainId, tokenIn],
  )
  const insufficient =
    available !== null && tokenIn !== null && parsed !== null
      ? compareAmounts(parsed, available.amount, tokenIn.decimals) > 0
      : false
  const slippagePct = slippage === 'auto' ? undefined : Number(slippage)
  const slippageValid =
    slippage === 'auto' ||
    (Number.isFinite(slippagePct) && (slippagePct as number) > 0 && (slippagePct as number) <= 50)

  const ready =
    Boolean(wallet) &&
    tokenIn !== null &&
    tokenOut !== null &&
    !sameToken(tokenIn, tokenOut) &&
    isPositiveAmount(parsed) &&
    providerReady &&
    unlocked &&
    slippageValid

  const params: QuoteParams | null = ready
    ? {
        chainId,
        wallet,
        tokenIn: (tokenIn as Token).address,
        tokenOut: (tokenOut as Token).address,
        amountIn: parsed as string,
        ...(slippagePct !== undefined ? { slippagePct } : {}),
      }
    : null
  const quote = useQuote(params)
  const countdown = quoteCountdown(quote.fetchedAt, now)
  const quoteError = quote.error
    ? quote.error instanceof Error
      ? quote.error.message
      : String(quote.error)
    : null

  const ctaKey: string | null = !unlocked
    ? 'trading.swap.cta.locked'
    : !providerReady
      ? provider === 'uniswap'
        ? 'trading.swap.cta.noKey'
        : 'trading.provider.switch'
      : !wallet
        ? 'trading.swap.cta.noWallet'
        : !tokenIn || !tokenOut
          ? 'trading.swap.pick'
          : sameToken(tokenIn, tokenOut)
            ? 'trading.swap.cta.sameToken'
            : !isPositiveAmount(parsed)
              ? 'trading.swap.cta.noAmount'
              : insufficient
                ? 'trading.swap.cta.insufficient'
                : null
  const canReview = ctaKey === null && quote.data !== undefined && !quote.isError

  function flip() {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmount(quote.data && tokenOut ? quote.data.amountOut : '')
  }

  const selectedWalletObj = wallets.find((w) => sameAddress(w.address, wallet)) ?? null

  return (
    <aside className="trd-ticket" aria-label={t('trading.swap.title')}>
      <div className="trd-ticket__head">
        <span className="trd-ticket__title">{t('trading.swap.title')}</span>
        <div role="radiogroup" aria-label={t('trading.overview.chains')} className="mac-segmented">
          {CHAINS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={chainId === c.id}
              className="mac-segment app-no-drag"
              onClick={() => pickChain(c.id)}
            >
              {c.short}
            </button>
          ))}
        </div>
      </div>
      <div className="trd-ticket__body">
        <div className="trd-ticket__wallet">
          <span>{t('trading.swap.wallet')}</span>
          <select
            className="mac-select"
            aria-label={t('trading.swap.wallet')}
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {walletLabel(w)}
                {w.primary ? ' ★' : ''}
              </option>
            ))}
          </select>
        </div>

        <Leg
          label={t('trading.swap.from')}
          token={tokenIn}
          onPick={() => setPicker('in')}
          balance={available?.amount ?? null}
          onMax={available ? () => setAmount(available.amount) : undefined}
          onPct={
            available && tokenIn
              ? (pct) => setAmount(amountFromPct(available.amount, tokenIn.decimals, pct))
              : undefined
          }
          usd={
            quote.data?.valueUsd ??
            (available?.priceUsd !== null && available?.priceUsd !== undefined && parsed
              ? Number(parsed) * available.priceUsd
              : null)
          }
        >
          <input
            className="trd-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('trading.swap.amount.placeholder')}
            aria-label={t('trading.swap.amount')}
            aria-invalid={insufficient || (amount !== '' && parsed === null)}
            data-invalid={insufficient || (amount !== '' && parsed === null) ? 'true' : undefined}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Leg>

        <div className="trd-flip">
          <button
            type="button"
            aria-label={t('trading.swap.flip')}
            onClick={flip}
            disabled={!tokenOut}
          >
            <ArrowDownUp className="size-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>

        <Leg
          label={t('trading.swap.to')}
          token={tokenOut}
          onPick={() => setPicker('out')}
          balance={null}
          usd={null}
        >
          <output
            className="trd-amount trd-amount--out"
            data-pending={quote.isFetching && !quote.data ? 'true' : undefined}
            aria-label={t('trading.swap.to')}
            data-testid="quote-out"
          >
            {quote.data && ready
              ? formatAmount(quote.data.amountOut)
              : quote.isFetching
                ? '…'
                : '0'}
          </output>
        </Leg>

        {ready && quote.data ? (
          <div className="trd-facts" data-testid="quote-facts">
            <div className="trd-fact">
              <span>
                {t('trading.swap.rate')}{' '}
                <span className="text-dim" data-testid="quote-provider">
                  {t('trading.provider.via')} {providerLabel(quote.data.provider ?? provider)}
                </span>
              </span>
              <b>
                1 {tokenIn?.symbol} ≈ {formatAmount(quote.data.rate)} {tokenOut?.symbol}
              </b>
            </div>
            <div className="trd-fact">
              <span>{t('trading.swap.impact')}</span>
              <b data-tone={impactTone(quote.data.priceImpactPct)}>
                {formatPct(quote.data.priceImpactPct)}
              </b>
            </div>
            <div className="trd-fact">
              <span>{t('trading.swap.minOut')}</span>
              <b>
                {formatAmount(quote.data.minOut)} {tokenOut?.symbol}
              </b>
            </div>
            <div className="trd-fact">
              <span>{t('trading.swap.gas')}</span>
              <b>{formatUsd(quote.data.gasUsd)}</b>
            </div>
            <div className="trd-fact">
              <span>{t('trading.swap.slippage')}</span>
              <span className="trd-fact__slip">
                <select
                  className="mac-select"
                  style={{ width: 84, height: 20, fontSize: 11 }}
                  aria-label={t('trading.swap.slippage')}
                  value={slippage === 'auto' ? 'auto' : 'custom'}
                  onChange={(e) =>
                    setSlippage(
                      e.target.value === 'auto' ? 'auto' : String(quote.data?.slippagePct ?? 0.5),
                    )
                  }
                >
                  <option value="auto">{t('trading.swap.slippage.auto')}</option>
                  <option value="custom">{t('trading.swap.slippage.custom')}</option>
                </select>
                {slippage !== 'auto' ? (
                  <input
                    className="mac-input"
                    inputMode="decimal"
                    aria-label={t('trading.swap.slippage')}
                    data-invalid={!slippageValid ? 'true' : undefined}
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value)}
                  />
                ) : (
                  <b>{formatPct(quote.data.slippagePct)}</b>
                )}
              </span>
            </div>
          </div>
        ) : null}

        {ready && quote.data ? <QuoteWarnings warnings={quote.data.warnings} /> : null}

        {ready && quote.data ? (
          <div
            className="trd-guard"
            data-decision={quote.data.guard.decision}
            data-testid="quote-guard"
          >
            {quote.data.guard.decision === 'allow' ? (
              <CircleCheck className="size-3.5" strokeWidth={2} aria-hidden />
            ) : (
              <ShieldAlert className="size-3.5" strokeWidth={2} aria-hidden />
            )}
            <span>{t(`trading.swap.guard.${quote.data.guard.decision}`)}</span>
          </div>
        ) : null}

        {ready && quote.isError ? (
          <div className="trd-ticket__error" role="alert">
            {isProviderBlocked(quote.error) ? (
              <span className="flex flex-col items-start gap-2">
                {t('trading.provider.blocked')}
                <Button onClick={onSwitchProvider} data-testid="provider-blocked-fix">
                  {t('trading.provider.switch')}
                </Button>
              </span>
            ) : quoteError?.includes('no_route') || quoteError?.includes('NoRoute') ? (
              t('trading.swap.noRoute')
            ) : (
              quoteError
            )}
          </div>
        ) : null}

        <button
          type="button"
          className="trd-cta app-no-drag"
          disabled={!canReview}
          data-testid="swap-review"
          onClick={() => setConfirm(true)}
        >
          <Ring
            fraction={ready && quote.data ? countdown.fraction : 0}
            expired={countdown.expired}
          />
          {ctaKey ? t(ctaKey as 'trading.swap.pick') : t('trading.swap.cta')}
        </button>
        {ready ? (
          <div className="trd-ticket__fresh" aria-live="polite">
            {quote.isFetching ? (
              t('trading.swap.quoting')
            ) : countdown.expired ? (
              <>
                {t('trading.swap.quoteStale')}
                <button type="button" onClick={() => void quote.refetch()}>
                  {t('trading.swap.requote')}
                </button>
              </>
            ) : (
              <>
                {t('trading.swap.quoteFresh')} {countdown.seconds}s
              </>
            )}
          </div>
        ) : null}
      </div>

      {picker ? (
        <TokenPicker
          chainId={chainId}
          balances={balances}
          exclude={picker === 'in' ? tokenOut : tokenIn}
          onPick={(tk) => {
            // The picker searches every chain, so a choice can move the
            // ticket. The other leg belonged to the chain we just left, so it
            // cannot come along: the pay side falls back to that chain's gas
            // coin, the receive side clears.
            if (tk.chainId !== chainId && (tk.chainId === 8453 || tk.chainId === 4663)) {
              setChainId(tk.chainId)
              setAmount('')
              if (picker === 'in') {
                setTokenIn(tk)
                setTokenOut(null)
              } else {
                setTokenIn(nativeToken(tk.chainId))
                setTokenOut(tk)
              }
            } else if (picker === 'in') {
              setTokenIn(tk)
            } else {
              setTokenOut(tk)
            }
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}

      {confirm && quote.data && tokenIn && tokenOut && selectedWalletObj ? (
        <ConfirmSwap
          quote={quote.data}
          fetchedAt={quote.fetchedAt}
          wallet={selectedWalletObj}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          amount={parsed as string}
          slippagePct={slippagePct}
          refreshing={quote.isFetching}
          onRefresh={() => void quote.refetch()}
          onClose={() => setConfirm(false)}
          onSwitchProvider={onSwitchProvider}
          onSent={(orders) => {
            setConfirm(false)
            setAmount('')
            onSent(orders)
          }}
        />
      ) : null}
    </aside>
  )
}

function Leg({
  label,
  token,
  onPick,
  balance,
  onMax,
  onPct,
  usd,
  children,
}: {
  label: string
  token: Token | null
  onPick: () => void
  balance: string | null
  onMax?: () => void
  onPct?: (pct: number) => void
  usd: number | null
  children: React.ReactNode
}) {
  return (
    <div className="trd-leg">
      <div className="trd-leg__row">
        <span className="trd-leg__label">{label}</span>
        {balance !== null ? (
          <span className="trd-leg__balance">
            {t('trading.swap.balance')} {formatAmount(balance)}
            {onMax ? (
              <button type="button" onClick={onMax}>
                {t('trading.swap.max')}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="trd-leg__main">
        <button
          type="button"
          className="trd-tokenbtn app-no-drag"
          data-empty={token ? undefined : 'true'}
          onClick={onPick}
          data-testid="token-button"
        >
          {token ? (
            <>
              <TokenLogo token={token} size={20} />
              {token.symbol}
            </>
          ) : (
            <>
              <Zap className="size-3.5" strokeWidth={2} aria-hidden />
              {t('trading.swap.pick')}
            </>
          )}
          <ChevronDown className="size-3" strokeWidth={2} aria-hidden />
        </button>
        {children}
      </div>
      <div className="trd-leg__row">
        {onPct ? (
          <span className="trd-pcts" aria-label={t('trading.swap.amount')}>
            {[25, 50, 75, 100].map((p) => (
              <button key={p} type="button" onClick={() => onPct(p)}>
                {p}%
              </button>
            ))}
          </span>
        ) : (
          <span />
        )}
        <span className="trd-leg__usd">{usd !== null ? `≈ ${formatUsd(usd)}` : ''}</span>
      </div>
    </div>
  )
}

/** The countdown ring on the primary button: full when the price is fresh. */
export function Ring({ fraction, expired }: { fraction: number; expired: boolean }) {
  const r = 9
  const c = 2 * Math.PI * r
  return (
    <span className="trd-ring" data-expired={expired ? 'true' : undefined} aria-hidden>
      <svg viewBox="0 0 22 22" width="22" height="22">
        <circle className="trd-ring__track" cx="11" cy="11" r={r} />
        <circle
          className="trd-ring__arc"
          cx="11"
          cy="11"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
        />
      </svg>
      <Zap className="trd-ring__glyph size-3" strokeWidth={2.5} />
    </span>
  )
}
