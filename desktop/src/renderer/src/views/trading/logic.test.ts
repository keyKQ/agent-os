import { describe, expect, it } from 'vitest'
import {
  DUST_USD,
  splitDust,
  allocationSegments,
  amountFromPct,
  approvalSecondsLeft,
  badgeText,
  capUsage,
  compareAmounts,
  filterHoldings,
  formatAmount,
  formatAmountCompact,
  formatClock,
  formatPct,
  formatPrice,
  formatUsd,
  formatUsdCell,
  fromRaw,
  groupEntriesByDay,
  impactTone,
  initiatorKey,
  isAwaitingApproval,
  isOrderLive,
  isPositiveAmount,
  needsRetype,
  orderTone,
  parseAmount,
  pnlTone,
  quoteCountdown,
  retypeMatches,
  sameToken,
  shortAddress,
  sortHoldings,
  toRaw,
  walletLabel,
} from './logic'
import type { Entry, Holding, Token } from './types'

function token(symbol: string, chainId = 8453, extra: Partial<Token> = {}): Token {
  return {
    chainId,
    address: `0x${symbol.padEnd(40, '0')}`,
    symbol,
    name: symbol,
    decimals: 18,
    logoUrl: null,
    native: false,
    verified: true,
    ...extra,
  }
}

function holding(symbol: string, extra: Partial<Holding> = {}): Holding {
  return {
    chainId: 8453,
    wallet: null,
    token: token(symbol),
    amount: '1',
    raw: '1000000000000000000',
    priceUsd: 1,
    valueUsd: 1,
    costUsd: 1,
    avgCostUsd: 1,
    unrealizedUsd: 0,
    unrealizedPct: 0,
    realizedUsd: 0,
    change24hPct: 0,
    allocationPct: 0,
    ...extra,
  }
}

describe('parseAmount', () => {
  it('normalises what a person types', () => {
    expect(parseAmount('1.5')).toBe('1.5')
    expect(parseAmount(' 1,5 ')).toBe('1.5')
    expect(parseAmount('.5')).toBe('0.5')
    expect(parseAmount('00012.3400')).toBe('12.34')
    expect(parseAmount('0')).toBe('0')
    expect(parseAmount('0.0')).toBe('0')
    expect(parseAmount('10.')).toBe('10')
  })
  it('rejects junk', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('.')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('1e5')).toBeNull()
    expect(parseAmount('-1')).toBeNull()
    expect(parseAmount('1.2.3')).toBeNull()
  })
  it('knows a positive amount', () => {
    expect(isPositiveAmount('0')).toBe(false)
    expect(isPositiveAmount('0.000001')).toBe(true)
    expect(isPositiveAmount(null)).toBe(false)
  })
})

describe('raw units', () => {
  it('converts both ways without floats', () => {
    expect(toRaw('1.5', 6)).toBe(1500000n)
    expect(toRaw('1', 18)).toBe(1000000000000000000n)
    expect(toRaw('0.000000000000000001', 18)).toBe(1n)
    expect(fromRaw(1500000n, 6)).toBe('1.5')
    expect(fromRaw('1000000000000000000', 18)).toBe('1')
    expect(fromRaw(1n, 18)).toBe('0.000000000000000001')
    expect(fromRaw(0n, 6)).toBe('0')
  })
  it('truncates precision the token cannot hold', () => {
    expect(toRaw('1.1234567', 6)).toBe(1123456n)
  })
  it('round-trips a large 18-decimal balance exactly', () => {
    const amount = '123456789.123456789012345678'
    expect(fromRaw(toRaw(amount, 18), 18)).toBe(amount)
  })
  it('takes a share of a balance', () => {
    expect(amountFromPct('1.5', 18, 50)).toBe('0.75')
    expect(amountFromPct('3', 6, 100)).toBe('3')
    expect(amountFromPct('3', 6, 33)).toBe('0.99')
    expect(amountFromPct('3', 6, 0)).toBe('0')
  })
  it('compares amounts by value', () => {
    expect(compareAmounts('1.5', '1.50', 18)).toBe(0)
    expect(compareAmounts('2', '1.9999', 18)).toBe(1)
    expect(compareAmounts('0.1', '0.2', 6)).toBe(-1)
  })
})

describe('formatting', () => {
  it('formats money', () => {
    expect(formatUsd(12480.22)).toBe('$12,480.22')
    expect(formatUsd(-3.5)).toBe('−$3.50')
    expect(formatUsd(3.5, { signed: true })).toBe('+$3.50')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(0.004123)).toBe('$0.004123')
    expect(formatUsd(1_250_000, { compact: true })).toBe('$1.3M')
  })
  it('formats percentages', () => {
    expect(formatPct(3.21, { signed: true })).toBe('+3.21%')
    expect(formatPct(-0.4)).toBe('−0.40%')
    expect(formatPct(12.34)).toBe('12.3%')
    expect(formatPct(150)).toBe('150%')
    expect(formatPct(null)).toBe('—')
    // A rate on a near-zero cost basis stops being a number worth printing.
    expect(formatPct(1.1902164029823605e22, { signed: true })).toBe('+>9,999%')
    expect(formatPct(-45_000)).toBe('−>9,999%')
  })
  it('formats token amounts from decimal strings', () => {
    expect(formatAmount('1234.5')).toBe('1,234.5')
    expect(formatAmount('0.123456789')).toBe('0.12345678')
    expect(formatAmount('12.123456789')).toBe('12.123456')
    expect(formatAmount('0.000000001')).toBe('1e-9')
    expect(formatAmount('1000000000000000000')).toBe('1,000,000,000,000,000,000')
    expect(formatAmount('0')).toBe('0')
    expect(formatAmount(null)).toBe('—')
  })
  it('shortens addresses', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
    expect(shortAddress('0x12')).toBe('0x12')
    expect(shortAddress('')).toBe('')
  })
  it('labels a wallet with no label by its address', () => {
    expect(walletLabel({ label: ' ', address: '0x1234567890abcdef1234567890abcdef12345678' })).toBe(
      '0x1234…5678',
    )
    expect(walletLabel({ label: 'Main', address: '0x0' })).toBe('Main')
  })
  it('formats a clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(900)).toBe('15:00')
  })
})

describe('tones', () => {
  it('reads profit and loss', () => {
    expect(pnlTone(12)).toBe('up')
    expect(pnlTone(-0.01)).toBe('down')
    expect(pnlTone(0.001)).toBe('flat')
    expect(pnlTone(null)).toBe('flat')
  })
  it('maps order status to a tone', () => {
    expect(orderTone('confirmed')).toBe('ok')
    expect(orderTone('awaiting_approval')).toBe('warn')
    expect(orderTone('failed')).toBe('danger')
    expect(orderTone('submitted')).toBe('live')
    expect(orderTone('quoted')).toBe('dim')
  })
  it('classifies order lifecycles', () => {
    expect(isAwaitingApproval({ status: 'awaiting_approval' })).toBe(true)
    expect(isOrderLive({ status: 'submitted' })).toBe(true)
    expect(isOrderLive({ status: 'confirmed' })).toBe(false)
  })
  it('grades price impact', () => {
    expect(impactTone(0.2)).toBe('ok')
    expect(impactTone(1.5)).toBe('warn')
    expect(impactTone(7)).toBe('danger')
    expect(impactTone(null)).toBe('ok')
  })
  it('names who started something', () => {
    expect(initiatorKey('manual')).toBe('you')
    expect(initiatorKey('agent')).toBe('agent')
    expect(initiatorKey('external')).toBe('external')
  })
})

describe('sorting and grouping', () => {
  const rows = [
    holding('AAA', { valueUsd: 10, unrealizedUsd: 5, change24hPct: -1, allocationPct: 10 }),
    holding('BBB', { valueUsd: 90, unrealizedUsd: -2, change24hPct: 3, allocationPct: 90 }),
    holding('CCC', { valueUsd: null, unrealizedUsd: null, change24hPct: null, allocationPct: 0 }),
  ]
  it('sorts by value with unknowns last', () => {
    expect(sortHoldings(rows, 'value').map((h) => h.token.symbol)).toEqual(['BBB', 'AAA', 'CCC'])
    expect(sortHoldings(rows, 'value', 'asc').map((h) => h.token.symbol)).toEqual([
      'CCC',
      'AAA',
      'BBB',
    ])
  })
  it('sorts by pnl, change and symbol', () => {
    expect(sortHoldings(rows, 'pnl').map((h) => h.token.symbol)).toEqual(['AAA', 'BBB', 'CCC'])
    expect(sortHoldings(rows, 'change').map((h) => h.token.symbol)).toEqual(['BBB', 'AAA', 'CCC'])
    expect(sortHoldings(rows, 'symbol', 'asc').map((h) => h.token.symbol)).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ])
  })
  it('does not mutate its input', () => {
    const copy = [...rows]
    sortHoldings(rows, 'value')
    expect(rows).toEqual(copy)
  })
  it('folds the allocation tail into other', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((s, i) =>
      holding(s, { allocationPct: 20 - i * 2 }),
    )
    const segs = allocationSegments(many, 3)
    expect(segs.map((s) => s.symbol)).toEqual(['A', 'B', 'C', 'other'])
    expect(segs[3]?.pct).toBeCloseTo(14 + 12 + 10 + 8 + 6)
    expect(allocationSegments([])).toEqual([])
  })
  it('filters holdings by chain', () => {
    const mixed = [holding('A'), holding('B', { chainId: 4663 })]
    expect(filterHoldings(mixed, 4663).map((h) => h.token.symbol)).toEqual(['B'])
    expect(filterHoldings(mixed, null)).toHaveLength(2)
  })
  it('groups entries by local day, newest first', () => {
    const day = (d: number, h = 12) => new Date(2026, 8, d, h).getTime()
    const entry = (id: string, ts: number): Entry => ({
      id,
      ts,
      chainId: 8453,
      wallet: '0x1',
      kind: 'swap',
      txHash: null,
      explorerUrl: null,
      tokenIn: null,
      amountIn: null,
      tokenOut: null,
      amountOut: null,
      valueUsd: null,
      gasUsd: null,
      initiator: 'manual',
      orderId: null,
      note: null,
    })
    const groups = groupEntriesByDay([
      entry('a', day(12, 9)),
      entry('b', day(13, 8)),
      entry('c', day(12, 18)),
    ])
    expect(groups.map((g) => g.day)).toEqual(['2026-09-13', '2026-09-12'])
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(['c', 'a'])
  })
})

describe('quote freshness and confirm rules', () => {
  it('counts a quote down to expiry', () => {
    const t0 = 1_000_000
    expect(quoteCountdown(t0, t0)).toEqual({ seconds: 15, fraction: 1, expired: false })
    expect(quoteCountdown(t0, t0 + 7_500).seconds).toBe(8)
    expect(quoteCountdown(t0, t0 + 7_500).fraction).toBeCloseTo(0.5)
    expect(quoteCountdown(t0, t0 + 15_000)).toEqual({ seconds: 0, fraction: 0, expired: true })
    expect(quoteCountdown(0, t0).expired).toBe(true)
  })
  it('asks for a retype above 1,000 USD only', () => {
    expect(needsRetype(999.99)).toBe(false)
    expect(needsRetype(1000)).toBe(false)
    expect(needsRetype(1000.01)).toBe(true)
    expect(needsRetype(null)).toBe(false)
  })
  it('matches a retyped amount by value', () => {
    expect(retypeMatches('1.50', '1.5')).toBe(true)
    expect(retypeMatches('1,5', '1.5')).toBe(true)
    expect(retypeMatches('1.51', '1.5')).toBe(false)
    expect(retypeMatches('', '1.5')).toBe(false)
  })
  it('times an approval', () => {
    const now = 5_000_000
    expect(approvalSecondsLeft({ expiresAt: now + 61_000 }, now)).toBe(61)
    expect(approvalSecondsLeft({ expiresAt: now - 1 }, now)).toBe(0)
    expect(approvalSecondsLeft({ expiresAt: null }, now)).toBeNull()
  })
})

describe('limits and badges', () => {
  it('measures the daily cap', () => {
    expect(capUsage(250, 1000)).toEqual({ fraction: 0.25, leftUsd: 750 })
    expect(capUsage(1500, 1000)).toEqual({ fraction: 1, leftUsd: 0 })
    expect(capUsage(-5, 1000)).toEqual({ fraction: 0, leftUsd: 1000 })
    expect(capUsage(10, 0)).toEqual({ fraction: 0, leftUsd: 0 })
  })
  it('caps the badge', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(3)).toBe('3')
    expect(badgeText(12)).toBe('9+')
  })
  it('compares tokens case-insensitively per chain', () => {
    const a = token('USDC')
    expect(sameToken(a, { ...a, address: a.address.toUpperCase() })).toBe(true)
    expect(sameToken(a, { ...a, chainId: 4663 })).toBe(false)
    expect(sameToken(a, null)).toBe(false)
  })
})

describe('compact cell formatting', () => {
  it('collapses dust values to a floor', () => {
    expect(formatUsdCell(0.00001554)).toBe('<$0.01')
    expect(formatUsdCell(0.0001961, { signed: true })).toBe('+<$0.01')
    expect(formatUsdCell(-0.004)).toBe('−<$0.01')
    expect(formatUsdCell(0)).toBe('$0.00')
    expect(formatUsdCell(0.51)).toBe('$0.51')
    expect(formatUsdCell(null)).toBe('—')
  })
  it('writes tiny prices with a subscript zero count', () => {
    expect(formatPrice(0.000001727)).toBe('$0.0₅1727')
    expect(formatPrice(0.0000001581)).toBe('$0.0₆1581')
    expect(formatPrice(0.00012345)).toBe('$0.0₃1234')
    expect(formatPrice(0.0000000000012)).toBe('$0.0₁₁12')
    expect(formatPrice(0.001)).toBe('$0.001')
    expect(formatPrice(2491.83)).toBe('$2,491.83')
    expect(formatPrice(0)).toBe('$0.00')
    expect(formatPrice(-0.000002)).toBe('−$0.0₅2')
  })
  it('writes dust amounts in scientific notation', () => {
    expect(formatAmount('0.000000123456')).toBe('1.23e-7')
    expect(formatAmount('0.0000001')).toBe('1e-7')
    expect(formatAmount('0.000001')).toBe('1e-6')
    expect(formatAmount('0.0000015')).toBe('1.5e-6')
    expect(formatAmount('0.00001')).toBe('0.00001')
    expect(formatAmount('0.00020641')).toBe('0.00020641')
  })
  it('keeps four significant digits in narrow columns', () => {
    expect(formatAmountCompact('0.00020641')).toBe('0.0002064')
    expect(formatAmountCompact('0.5')).toBe('0.5')
    expect(formatAmountCompact('99.123456')).toBe('99.1234')
    expect(formatAmountCompact('1234567.891')).toBe('1,234,567.891')
    expect(formatAmountCompact('0.0000001234')).toBe('1.23e-7')
    expect(formatAmountCompact('0')).toBe('0')
  })
})

describe('parseAmount shape tolerance', () => {
  it('normalises a number the engine should have sent as a string', () => {
    // A quote's `rate` arrived as a float once and took the whole desk down.
    expect(parseAmount(0.0004521 as unknown as string)).toBe('0.0004521')
    expect(formatAmount(1.5 as unknown as string)).toBe('1.5')
  })

  it('renders an em dash for a shape it cannot read, rather than throwing', () => {
    for (const bad of [{}, [], true, null, undefined]) {
      expect(() => formatAmount(bad as unknown as string)).not.toThrow()
      expect(formatAmount(bad as unknown as string)).toBe('—')
    }
  })
})

describe('splitDust', () => {
  const mk = (symbol: string, valueUsd: number | null) =>
    ({ token: { symbol }, valueUsd }) as unknown as Parameters<typeof splitDust>[0][number]

  // Values are written relative to the threshold so the cases keep their
  // meaning if DUST_USD moves again.
  it('hides positions worth less than the threshold, keeps unpriced ones', () => {
    const { kept, dust } = splitDust([
      mk('ETH', DUST_USD * 120),
      mk('USDC', DUST_USD * 2),
      mk('AGAI', DUST_USD / 100),
      mk('XYZ', null),
    ])
    // An unpriced position is not dust — we simply do not know what it is worth.
    expect(kept.map((h) => h.token.symbol)).toEqual(['ETH', 'USDC', 'XYZ'])
    expect(dust.map((h) => h.token.symbol)).toEqual(['AGAI'])
  })

  it('keeps a position sitting exactly on the threshold', () => {
    const { kept, dust } = splitDust([mk('ON', DUST_USD), mk('UNDER', DUST_USD * 0.99)])
    expect(kept.map((h) => h.token.symbol)).toEqual(['ON'])
    expect(dust.map((h) => h.token.symbol)).toEqual(['UNDER'])
  })
})
