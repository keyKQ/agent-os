/**
 * The trading RPC contract (wallet.* / trading.*), as the gateway returns it.
 * Amounts are decimal strings in human units unless the key ends in `Raw`;
 * money is USD as a number or null when no price is known. Nothing here is
 * computed: every derived figure lives in logic.ts.
 */

export type ChainId = 8453 | 4663

export interface Token {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  logoUrl: string | null
  native: boolean
  verified: boolean
}

export interface SearchToken extends Token {
  priceUsd: number | null
  liquidityUsd: number | null
}

export interface Wallet {
  address: string
  label: string
  primary: boolean
  createdAt: number
  chains: number[]
}

export interface Balance {
  chainId: number
  token: Token
  raw: string
  amount: string
  priceUsd: number | null
  valueUsd: number | null
  change24hPct: number | null
}

export type OrderStatus =
  | 'quoted'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'submitted'
  | 'confirmed'
  | 'failed'

export type Initiator = 'manual' | 'agent' | 'external'

export interface Order {
  orderId: string
  createdAt: number
  updatedAt: number
  chainId: number
  wallet: string
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  amountInRaw: string
  expectedOut: string | null
  minOut: string | null
  valueUsd: number | null
  priceImpactPct: number | null
  gasUsd: number | null
  status: OrderStatus
  reason: string | null
  initiator: Initiator
  sessionKey: string | null
  note: string | null
  txHash: string | null
  explorerUrl: string | null
  expiresAt: number | null
  /** A swap to native ETH on an L2 that delivered WETH instead names it here. */
  deliveredToken?: Token | null
  provider?: ProviderId
}

export type EntryKind = 'swap' | 'deposit' | 'withdraw' | 'approval' | 'gas' | 'unwrap'

/** A wrapped-ETH holding an L2 handed back: one click turns it into ETH. */
export function isWrappedEth(token: Pick<Token, 'symbol' | 'native'>): boolean {
  return !token.native && token.symbol.toUpperCase() === 'WETH'
}

export interface Entry {
  id: string
  ts: number
  chainId: number
  wallet: string
  kind: EntryKind
  txHash: string | null
  explorerUrl: string | null
  tokenIn: Token | null
  amountIn: string | null
  tokenOut: Token | null
  amountOut: string | null
  valueUsd: number | null
  gasUsd: number | null
  initiator: Initiator
  orderId: string | null
  note: string | null
}

export interface Holding {
  chainId: number
  wallet: string | null
  token: Token
  amount: string
  raw: string
  priceUsd: number | null
  valueUsd: number | null
  costUsd: number | null
  avgCostUsd: number | null
  unrealizedUsd: number | null
  unrealizedPct: number | null
  realizedUsd: number
  change24hPct: number | null
  allocationPct: number
}

export interface Totals {
  valueUsd: number
  costUsd: number
  unrealizedUsd: number
  realizedUsd: number
  gasUsd: number
  change24hUsd: number | null
  change24hPct: number | null
}

export interface Portfolio {
  totals: Totals
  holdings: Holding[]
  wallets: { wallet: Wallet; totals: Totals }[]
  updatedAt: number
  syncing: boolean
}

export type GuardDecision = 'allow' | 'needs_approval' | 'blocked_daily_cap'

export interface Quote {
  quoteId: string
  routing: string
  chainId: number
  wallet: string
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  amountOut: string
  minOut: string
  priceImpactPct: number | null
  gasUsd: number | null
  valueUsd: number | null
  rate: string
  slippagePct: number
  expiresAt: number
  provider?: ProviderId
  /** Kyber token checks (fee-on-transfer and the like), for the confirm sheet. */
  warnings?: string[]
  guard: {
    decision: GuardDecision
    spentTodayUsd: number
    dailyCapUsd: number
    thresholdUsd: number
  }
}

export type UnlockMode = 'auto' | 'manual'

export interface WalletStatus {
  initialized: boolean
  unlocked: boolean
  unlockMode: UnlockMode
  walletCount: number
  primary: string | null
  vaultPath: string
}

export interface ChainStatus {
  chainId: number
  key: string
  name: string
  native: string
  explorer: string
  rpcUrl: string
  healthy: boolean | null
}

/** Who routes and builds the swap. Uniswap needs a key; Kyber needs none but is geo-restricted. */
export type ProviderId = 'uniswap' | 'kyber'

export const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: 'uniswap', label: 'Uniswap' },
  { id: 'kyber', label: 'KyberSwap' },
]

export function providerLabel(id: string | null | undefined): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? (id ? String(id) : '')
}

export interface ProviderStatus {
  id: ProviderId
  label: string
  needsKey: boolean
  keyConfigured: boolean
  blocked: boolean | null
  healthy: boolean | null
}

export interface TradingStatus {
  enabled: boolean
  apiKeyConfigured: boolean
  chains: ChainStatus[]
  limits: { approvalThresholdUsd: number; dailyCapUsd: number; approvalTtlSeconds: number }
  unlockMode: UnlockMode
  unlocked: boolean
  syncing: boolean
  lastSyncAt: number | null
  /** Older engines omit these; the app then assumes Uniswap. */
  provider?: ProviderId
  providers?: ProviderStatus[]
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
  /** Kyber only: the region is refused at the edge (HTTP 403). */
  blocked?: boolean
}

/** The RPC error code a geo-blocked provider raises on quote and swap. */
export const PROVIDER_BLOCKED_CODE = 'trading.provider_blocked'

export interface ChartPoint {
  t: number
  o?: number
  h?: number
  l?: number
  c: number
}

export interface Chart {
  source: 'geckoterminal' | 'snapshots'
  points: ChartPoint[]
}

export interface Limits {
  dailyCapUsd: number
  spentTodayUsd: number
  thresholdUsd: number
  approvalTtlSeconds: number
}

/** The zero address the API uses for the chain's native coin. */
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000'

export const CHAINS: readonly {
  id: ChainId
  key: string
  name: string
  short: string
  /** Two letters for a chip when the ledger is narrow. */
  abbr: string
}[] = [
  { id: 8453, key: 'base', name: 'Base', short: 'Base', abbr: 'BA' },
  { id: 4663, key: 'robinhood', name: 'Robinhood Chain', short: 'Robinhood', abbr: 'RH' },
]
