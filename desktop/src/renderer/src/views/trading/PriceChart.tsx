import { X } from 'lucide-react'
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { t } from '~/i18n'
import { useChart } from '~/stores/trading'
import { formatUsd } from './logic'
import { Spinner } from './parts'
import type { Chart, Holding } from './types'

type Range = '1d' | '1w' | '1m' | '1y'
const RANGES: Range[] = ['1d', '1w', '1m', '1y']

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

/**
 * The picked holding's price under the table. Candles when a pool has
 * OHLC (Base, via GeckoTerminal); an area line from the app's own
 * snapshots otherwise (Robinhood Chain), and it says which.
 */
export function PriceChart({ holding, onClose }: { holding: Holding; onClose: () => void }) {
  const [range, setRange] = useState<Range>('1w')
  const query = useChart(holding.chainId, holding.token.address, range)
  return (
    <section className="trd-chart" aria-label={t('trading.chart.title')}>
      <div className="trd-chart__head">
        <div className="trd-chart__title">
          {holding.token.symbol}
          <span className="trd-num">{formatUsd(holding.priceUsd)}</span>
          {query.data?.source === 'snapshots' ? (
            <small>{t('trading.chart.snapshots')}</small>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label={t('trading.chart.title')} className="mac-segmented">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={range === r}
                className="mac-segment app-no-drag"
                onClick={() => setRange(r)}
              >
                {t(`trading.chart.range.${r}`)}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('trading.chart.close')}
            onClick={onClose}
          >
            <X className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
      </div>
      {query.isPending ? (
        <div className="trd-chart__empty">
          <Spinner />
        </div>
      ) : !query.data || query.data.points.length < 2 ? (
        <div className="trd-chart__empty">{t('trading.chart.empty')}</div>
      ) : (
        <Canvas chart={query.data} />
      )}
    </section>
  )
}

function Canvas({ chart }: { chart: Chart }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fg = cssVar('--muted-foreground')
    const up = cssVar('--ok')
    const down = cssVar('--danger')
    const primary = cssVar('--primary')
    const hairline = cssVar('--hairline')
    let api: IChartApi
    try {
      api = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: fg,
          fontFamily: getComputedStyle(el).fontFamily,
          fontSize: 10,
          attributionLogo: false,
        },
        grid: { vertLines: { color: hairline }, horzLines: { color: hairline } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        handleScroll: false,
        handleScale: false,
      })
    } catch {
      // jsdom and headless renderers have no canvas; the chart is decoration there.
      return
    }
    const points = [...chart.points].sort((a, b) => a.t - b.t)
    const candles = points.every((p) => p.o !== undefined && p.h !== undefined && p.l !== undefined)
    if (candles) {
      const series = api.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderVisible: false,
        wickUpColor: up,
        wickDownColor: down,
      })
      series.setData(
        points.map((p) => ({
          time: Math.floor(p.t / 1000) as UTCTimestamp,
          open: p.o as number,
          high: p.h as number,
          low: p.l as number,
          close: p.c,
        })),
      )
    } else {
      const series = api.addSeries(AreaSeries, {
        lineColor: primary,
        lineWidth: 2,
        topColor: `color-mix(in srgb, ${primary} 30%, transparent)`,
        bottomColor: 'transparent',
        priceLineVisible: false,
      })
      series.setData(
        points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.c })),
      )
    }
    api.timeScale().fitContent()
    return () => api.remove()
  }, [chart])
  return <div ref={ref} className="trd-chart__canvas" data-testid="price-chart" />
}
