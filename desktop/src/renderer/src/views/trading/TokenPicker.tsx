import { Search, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { t } from '~/i18n'
import { useResolveToken, useTokenSearch } from '~/stores/trading'
import { chainName, formatAmount, formatUsd, sameToken } from './logic'
import { AssetCell, Sheet, Spinner } from './parts'
import { NATIVE_ADDRESS, type Balance, type SearchToken, type Token } from './types'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function nativeToken(chainId: number): Token {
  return {
    chainId,
    address: NATIVE_ADDRESS,
    symbol: 'ETH',
    name: chainName(chainId),
    decimals: 18,
    logoUrl: null,
    native: true,
    verified: true,
  }
}

/**
 * Choose a token for a leg of the ticket. What you hold on this chain comes
 * first, then the search: symbol, name, or a pasted address, which resolves
 * on chain even when nobody indexes it. Robinhood lookalikes are flagged.
 */
export function TokenPicker({
  chainId,
  balances,
  exclude,
  onPick,
  onClose,
}: {
  chainId: number
  balances: Balance[]
  exclude: Token | null
  onPick: (token: Token) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const search = useTokenSearch(chainId, query)
  const resolve = useResolveToken()
  const isAddress = ADDRESS_RE.test(query.trim())
  const resolveMutate = resolve.mutate
  useEffect(() => {
    if (isAddress) resolveMutate({ chainId, address: query.trim() })
  }, [isAddress, query, chainId, resolveMutate])

  const held = useMemo(() => {
    const native = nativeToken(chainId)
    const rows: { token: Token; amount: string | null; valueUsd: number | null }[] = []
    const seen = new Set<string>()
    for (const b of balances) {
      if (b.chainId !== chainId) continue
      const key = b.token.address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ token: b.token, amount: b.amount, valueUsd: b.valueUsd })
    }
    if (!seen.has(NATIVE_ADDRESS)) rows.unshift({ token: native, amount: null, valueUsd: null })
    const q = query.trim().toLowerCase()
    return rows
      .filter((r) => !sameToken(r.token, exclude))
      .filter(
        (r) =>
          !q ||
          r.token.symbol.toLowerCase().includes(q) ||
          r.token.name.toLowerCase().includes(q) ||
          r.token.address.toLowerCase() === q,
      )
      .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))
  }, [balances, chainId, exclude, query])

  const results: SearchToken[] = useMemo(() => {
    const out: SearchToken[] = []
    const resolved = resolve.data?.token
    if (isAddress && resolved) out.push({ ...resolved, priceUsd: null, liquidityUsd: null })
    for (const tk of search.tokens) {
      if (sameToken(tk, exclude)) continue
      if (held.some((h) => sameToken(h.token, tk))) continue
      if (out.some((o) => sameToken(o, tk))) continue
      out.push(tk)
    }
    return out
  }, [search.tokens, resolve.data, isAddress, exclude, held])

  const searching = search.isFetching || (isAddress && resolve.isPending)
  const nothing =
    !searching && query.trim().length >= 2 && held.length === 0 && results.length === 0

  return (
    <Sheet title={t('trading.picker.title')} onClose={onClose}>
      <label className="trd-picker__search">
        <Search className="size-3.5 text-dim" strokeWidth={2} aria-hidden />
        <input
          autoFocus
          value={query}
          placeholder={t('trading.picker.search')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('trading.picker.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching ? <Spinner /> : null}
      </label>
      <div className="trd-picker__list" role="listbox" aria-label={t('trading.picker.title')}>
        {held.length > 0 ? (
          <div className="trd-picker__group">{t('trading.picker.held')}</div>
        ) : null}
        {held.map((r) => (
          <button
            key={r.token.address}
            type="button"
            role="option"
            aria-selected={false}
            className="trd-pick app-no-drag"
            data-testid="token-pick"
            onClick={() => onPick(r.token)}
          >
            <AssetCell token={r.token} />
            <span className="trd-pick__right">
              {r.amount !== null ? <span>{formatAmount(r.amount)}</span> : null}
              {r.valueUsd !== null ? <small>{formatUsd(r.valueUsd)}</small> : null}
            </span>
          </button>
        ))}
        {results.length > 0 ? (
          <div className="trd-picker__group">{t('trading.picker.results')}</div>
        ) : null}
        {results.map((tk) => (
          <button
            key={`${tk.address}`}
            type="button"
            role="option"
            aria-selected={false}
            className="trd-pick app-no-drag"
            data-testid="token-pick"
            onClick={() => onPick(tk)}
          >
            <AssetCell
              token={tk}
              sub={
                chainId === 4663 && !tk.verified && !tk.native
                  ? t('trading.picker.lookalike')
                  : tk.name
              }
            />
            <span className="trd-pick__right">
              {tk.priceUsd !== null ? <span>{formatUsd(tk.priceUsd)}</span> : null}
              <small>
                {tk.verified ? (
                  t('trading.picker.verified')
                ) : (
                  <span className="inline-flex items-center gap-1 text-warn">
                    <TriangleAlert className="size-2.5" strokeWidth={2} aria-hidden />
                    {t('trading.picker.unverified')}
                  </span>
                )}
              </small>
            </span>
          </button>
        ))}
        {nothing ? <div className="trd-note">{t('trading.picker.none')}</div> : null}
      </div>
    </Sheet>
  )
}
