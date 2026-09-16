import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useRpc } from '@/app/providers'
import { useConnection } from '@/stores/connection'
import { QUOTE_REFRESH_MS } from '~/views/trading/logic'
import { CHAINS } from '~/views/trading/types'
import type {
  Balance,
  ChainRead,
  Chart,
  ChartRange,
  Entry,
  Limits,
  Order,
  OrderStatus,
  Portfolio,
  ProbeResult,
  ProviderId,
  Quote,
  SearchToken,
  Token,
  TradingStatus,
  Wallet,
  WalletStatus,
} from '~/views/trading/types'

/**
 * Everything the Trading page reads from the gateway, as react-query hooks
 * over the wallet.* / trading.* RPC. Each hook names its query key so the
 * event listener below can knock the right ones stale: the gateway
 * broadcasts `trading.changed` after every order, sync, wallet or config
 * change, and `_hello` on reconnect.
 */

export const TRADING_KEYS = {
  status: ['trading', 'status'] as const,
  walletStatus: ['trading', 'wallet-status'] as const,
  wallets: ['trading', 'wallets'] as const,
  portfolio: (wallet?: string, includeHidden = false) =>
    ['trading', 'portfolio', wallet ?? 'all', includeHidden ? 'with-hidden' : 'shown'] as const,
  balances: (wallet?: string) => ['trading', 'balances', wallet ?? 'all'] as const,
  // `limit` and `wallet` shape the answer, so two callers asking for
  // different pages must not share one cache entry.
  orders: (status?: OrderStatus, limit?: number, wallet?: string) =>
    ['trading', 'orders', status ?? 'any', limit ?? 'default', wallet ?? 'all'] as const,
  history: (wallet?: string, chainId?: number) =>
    ['trading', 'history', wallet ?? 'all', chainId ?? 'all'] as const,
  limits: (wallet: string) => ['trading', 'limits', wallet] as const,
  chart: (chainId: number, token: string, range: string) =>
    ['trading', 'chart', chainId, token.toLowerCase(), range] as const,
}

/** Gateway events after which trading data is stale. */
export const TRADING_EVENTS = [
  'trading.changed',
  'trading.approval.requested',
  'trading.order.finished',
  '_hello',
] as const

export function invalidateTrading(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['trading'] })
}

/**
 * Bind once from a mounted page: every trading event refetches whatever is
 * on screen (debounced, so a burst of order updates is one round).
 */
export function useTradingInvalidation(enabled = true): void {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const invalidate = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        invalidateTrading(queryClient)
      }, 150)
    }
    const offs = TRADING_EVENTS.map((event) => rpc.on(event, invalidate))
    return () => {
      offs.forEach((off) => off())
      if (timer) clearTimeout(timer)
    }
  }, [rpc, queryClient, enabled])
}

function useConnected(): boolean {
  return useConnection((s) => s.state === 'connected')
}

export function useTradingStatus(enabled = true) {
  const rpc = useRpc()
  const connected = useConnected()
  return useQuery<TradingStatus>({
    queryKey: TRADING_KEYS.status,
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<TradingStatus>('trading.status', {})
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useWalletStatus(enabled = true) {
  const rpc = useRpc()
  const connected = useConnected()
  return useQuery<WalletStatus>({
    queryKey: TRADING_KEYS.walletStatus,
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<WalletStatus>('wallet.status', {})
    },
    refetchOnWindowFocus: true,
  })
}

interface WalletList {
  wallets?: Wallet[]
  primary?: string | null
}

export function useWallets(enabled = true) {
  const rpc = useRpc()
  const connected = useConnected()
  const query = useQuery<WalletList>({
    queryKey: TRADING_KEYS.wallets,
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<WalletList>('wallet.list', {})
    },
    refetchOnWindowFocus: true,
  })
  const wallets = useMemo(() => query.data?.wallets ?? [], [query.data])
  return { ...query, wallets, primary: query.data?.primary ?? null }
}

/**
 * Holdings and totals. Junk tokens the engine hid are left out (and never
 * counted); `includeHidden` brings them back flagged `hidden`, for the
 * "show hidden" toggle.
 */
export function usePortfolio(wallet: string | undefined, enabled = true, includeHidden = false) {
  const rpc = useRpc()
  const connected = useConnected()
  return useQuery<Portfolio>({
    queryKey: TRADING_KEYS.portfolio(wallet, includeHidden),
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<Portfolio>('trading.portfolio', {
        ...(wallet ? { wallet } : {}),
        ...(includeHidden ? { includeHidden: true } : {}),
      })
    },
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  })
}

interface BalanceList {
  balances?: Balance[]
  /** Per wallet/chain freshness; see `ChainRead`. */
  chains?: ChainRead[]
  updatedAt?: number | null
}

/**
 * The ledger's view of a wallet's balances. This never makes the engine read
 * the chain: the engine's sync loop does, every settled swap does, and it
 * announces `trading.changed` when the ledger moves, which refetches this.
 * The interval is only a backstop for a missed event.
 */
export function useBalances(wallet: string | undefined, enabled = true) {
  const rpc = useRpc()
  const connected = useConnected()
  const query = useQuery<BalanceList>({
    queryKey: TRADING_KEYS.balances(wallet),
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<BalanceList>('wallet.balances', wallet ? { address: wallet } : {})
    },
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  })
  const balances = useMemo(() => query.data?.balances ?? [], [query.data])
  const chainReads = useMemo(() => query.data?.chains ?? [], [query.data])
  return { ...query, balances, chainReads }
}

interface OrderList {
  orders?: Order[]
  pendingApprovals?: number
}

export function useOrders(
  status: OrderStatus | undefined,
  enabled = true,
  limit = 50,
  wallet?: string,
) {
  const rpc = useRpc()
  const connected = useConnected()
  const query = useQuery<OrderList>({
    queryKey: TRADING_KEYS.orders(status, limit, wallet),
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<OrderList>('trading.orders.list', {
        ...(status ? { status } : {}),
        ...(wallet ? { wallet } : {}),
        limit,
      })
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  })
  const orders = useMemo(() => query.data?.orders ?? [], [query.data])
  return { ...query, orders, pendingApprovals: query.data?.pendingApprovals ?? 0 }
}

/** The number on the sidebar badge. Cheap: one small query, event-driven. */
export function usePendingApprovals(enabled = true): number {
  const { pendingApprovals, orders } = useOrders('awaiting_approval', enabled, 20)
  return pendingApprovals || orders.length
}

interface HistoryPage {
  entries?: Entry[]
  nextBefore?: number | null
}

export function useHistory(
  wallet: string | undefined,
  chainId: number | undefined,
  enabled = true,
) {
  const rpc = useRpc()
  const connected = useConnected()
  const query = useQuery<HistoryPage>({
    queryKey: TRADING_KEYS.history(wallet, chainId),
    enabled: connected && enabled,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<HistoryPage>('trading.history', {
        ...(wallet ? { wallet } : {}),
        ...(chainId ? { chainId } : {}),
        limit: 100,
      })
    },
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const entries = useMemo(() => query.data?.entries ?? [], [query.data])
  return { ...query, entries, nextBefore: query.data?.nextBefore ?? null }
}

export function useLimits(wallet: string | null) {
  const rpc = useRpc()
  const connected = useConnected()
  return useQuery<Limits>({
    queryKey: TRADING_KEYS.limits(wallet ?? ''),
    enabled: connected && Boolean(wallet),
    queryFn: async () => {
      await rpc.waitForConnection()
      const raw = await rpc.call<Limits & { approvalThresholdUsd?: number }>('trading.limits', {
        wallet,
      })
      // The engine names the threshold `approvalThresholdUsd`; the desk reads `thresholdUsd`.
      return { ...raw, thresholdUsd: raw.thresholdUsd ?? raw.approvalThresholdUsd ?? 0 }
    },
    refetchInterval: 30_000,
  })
}

export function useChart(chainId: number, token: string | null, range: ChartRange) {
  const rpc = useRpc()
  const connected = useConnected()
  return useQuery<Chart>({
    queryKey: TRADING_KEYS.chart(chainId, token ?? '', range),
    enabled: connected && Boolean(token),
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<Chart>('trading.chart', { chainId, token, range })
    },
    staleTime: 60_000,
  })
}

export interface QuoteParams {
  chainId: number
  wallet: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippagePct?: number
}

/**
 * A live price for the swap form. Refetches every 15 s while the form is
 * complete; `fetchedAt` drives the countdown ring so the person can see
 * the price ageing rather than being surprised by a stale one.
 */
export function useQuote(params: QuoteParams | null) {
  const rpc = useRpc()
  const connected = useConnected()
  const key = params
    ? [
        'trading',
        'quote',
        params.chainId,
        params.wallet,
        params.tokenIn.toLowerCase(),
        params.tokenOut.toLowerCase(),
        params.amountIn,
        params.slippagePct ?? 'auto',
      ]
    : ['trading', 'quote', 'none']
  const query = useQuery<Quote>({
    queryKey: key,
    enabled: connected && params !== null,
    queryFn: async () => {
      await rpc.waitForConnection()
      return rpc.call<Quote>('trading.quote', { ...params, initiator: 'manual' })
    },
    refetchInterval: QUOTE_REFRESH_MS,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: QUOTE_REFRESH_MS,
    placeholderData: (prev) => prev,
  })
  // A price shown from the previous params is about another swap: it is
  // already expired as far as the countdown is concerned.
  const fetchedAt = query.isPlaceholderData ? 0 : query.dataUpdatedAt
  return { ...query, fetchedAt }
}

export interface SwapParams {
  chainId: number
  wallets?: string[] | 'all'
  tokenIn: string
  tokenOut: string
  amountIn?: string
  amountPct?: number
  slippagePct?: number
  note?: string
}

interface SwapResult {
  orders: Order[]
}

export function useSwap() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: SwapParams) =>
      rpc.call<SwapResult>('trading.swap', { ...params, initiator: 'manual' }),
    onSettled: () => invalidateTrading(queryClient),
  })
}

export function useOrderDecision() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ orderId, approve }: { orderId: string; approve: boolean }) =>
      rpc.call<{ order: Order }>(
        approve ? 'trading.orders.approve' : 'trading.orders.reject',
        approve ? { orderId } : { orderId, reason: 'user' },
      ),
    onSettled: () => invalidateTrading(queryClient),
  })
}

/**
 * Hide a junk token, or show one the engine hid. The user's call is final:
 * the engine's classifier never reverses it.
 */
export function useTokenVisibility() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: { chainId: number; address: string; hidden: boolean }) =>
      rpc.call<{ token: Token & { hidden: boolean } }>('trading.tokens.hide', params),
    onSettled: () => invalidateTrading(queryClient),
  })
}

/** WETH an L2 handed back instead of ETH, turned into ETH (amount omitted = all). */
export function useUnwrap() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: { chainId: number; wallet: string; amount?: string }) =>
      rpc.call<{ txHash: string }>('trading.unwrap', params),
    onSettled: () => invalidateTrading(queryClient),
  })
}

export function useSync() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (params: { wallet?: string; full?: boolean }) =>
      rpc.call<{ started: boolean }>('trading.sync', params),
    onSettled: () => invalidateTrading(queryClient),
  })
}

/** One mutation for every vault/wallet write; the sheet picks the method. */
export function useWalletMutation<T = unknown>() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ method, params }: { method: string; params: Record<string, unknown> }) =>
      rpc.call<T>(method, params),
    onSettled: () => invalidateTrading(queryClient),
  })
}

/** Make a provider the one that routes swaps (the toasts belong to the caller). */
export function useSetProvider() {
  const rpc = useRpc()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (provider: ProviderId) =>
      rpc.call<{ provider: ProviderId }>('trading.setProvider', { provider }),
    onSettled: () => invalidateTrading(queryClient),
  })
}

/** Try a provider: the configured one, or a named one, with an optional typed key. */
export function useProbe() {
  const rpc = useRpc()
  return useMutation({
    mutationFn: (params: { provider?: ProviderId; apiKey?: string } = {}) =>
      rpc.call<ProbeResult>('trading.probe', {
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.apiKey ? { apiKey: params.apiKey } : {}),
      }),
  })
}

interface SearchResult {
  tokens?: SearchToken[]
}

/** Debounced token search for the picker. */
/**
 * Token search across every chain the desk trades, not just the ticket's.
 *
 * A symbol or an address is a poor place to make someone guess which network
 * they are on — a Robinhood Chain address pasted while the ticket sits on Base
 * used to find nothing. One query per chain, run together and merged; each
 * result carries its own chainId, so the picker can show where it lives and
 * move the ticket if you take it. `first` is only an ordering preference: the
 * chain already on screen leads.
 */
export function useTokenSearch(first: number, query: string) {
  const rpc = useRpc()
  const connected = useConnected()
  const [debounced, setDebounced] = useState(query)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 220)
    return () => clearTimeout(id)
  }, [query])
  const results = useQueries({
    queries: CHAINS.map((c) => ({
      queryKey: ['trading', 'tokens', c.id, debounced.toLowerCase()],
      enabled: connected && debounced.length >= 2,
      queryFn: async () => {
        await rpc.waitForConnection()
        return rpc.call<SearchResult>('trading.tokens.search', {
          chainId: c.id,
          query: debounced,
        })
      },
      staleTime: 30_000,
      retry: false,
    })),
  })
  const isFetching = results.some((r) => r.isFetching)
  // `results` is a new array on every render, so memoising on it would never
  // hit. The stamps are what actually change when a chain answers.
  const stamps = results.map((r) => r.dataUpdatedAt).join(',')
  const rows = results.flatMap((r) => r.data?.tokens ?? [])
  const tokens = useMemo(
    // The ticket's own chain leads; within a chain the engine's own ranking
    // survives, so an exact symbol match still comes first.
    () => [...rows].sort((a, b) => Number(b.chainId === first) - Number(a.chainId === first)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamps, first],
  )
  return { isFetching, tokens, debounced }
}
