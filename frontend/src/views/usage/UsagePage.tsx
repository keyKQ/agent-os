import './usage.css'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DownloadIcon, RefreshCwIcon, BarChart3Icon } from 'lucide-react'
import { toast } from 'sonner'
import { AsciiField } from '@/components/AsciiField'
import { Button } from '@/components/ui/button'
import { useRpc } from '@/app/providers'
import {
  buildCsv,
  chartRows,
  costSourceBadge,
  csvFilename,
  formatCost,
  formatRelTime,
  hasModelExpand,
  modelBreakdownGrid,
  modelDisplayLabel,
  normalizeRange,
  rangeHiddenHint,
  rowVal,
  sessionExpandRows,
  sessionTimestamp,
  sortSessions,
  sourceCompositionHint,
  usageMetrics,
  visibleSessions,
  type ChartMode,
  type CostSourceBadge,
  type SortColumn,
  type UsageRange,
  type UsageRow,
} from './logic'

const RANGE_KEY = 'agentos-usage-range'
const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
]
// usage.js:16-26 — the sessions table columns; a subset is sortable.
const TABLE_COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: 'session', label: 'Session', sortable: true },
  { key: 'updated_at', label: 'Modified', sortable: true },
  { key: 'input_tokens', label: 'Input', sortable: true },
  { key: 'output_tokens', label: 'Output', sortable: true },
  { key: 'cache_read_tokens', label: 'Cache R', sortable: false },
  { key: 'cache_write_tokens', label: 'Cache W', sortable: false },
  { key: 'cost_usd', label: 'Cost', sortable: true },
  { key: 'cost_source', label: 'Source', sortable: false },
  { key: 'model', label: 'Model', sortable: true },
]

interface UsageStatus {
  sessions?: UsageRow[]
}

function num(row: UsageRow, ...keys: string[]): number | null {
  const v = rowVal(row as Record<string, unknown>, ...keys)
  return v == null || v === '' ? null : Number(v)
}
function localized(n: number | null): string {
  return n != null ? n.toLocaleString() : '—'
}

// ── Cost-source badge chip ────────────────────────────────────────────────────
function SourceBadge({ badge }: { badge: CostSourceBadge }) {
  return (
    <span
      className={`usage-source usage-source--${badge.cls}${badge.ephemeral ? ' usage-source--ephemeral' : ''}`}
      title={badge.tooltip}
    >
      {badge.label}
    </span>
  )
}

export function UsagePage() {
  const rpc = useRpc()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [range, setRange] = useState<UsageRange>(() =>
    normalizeRange(typeof localStorage !== 'undefined' ? localStorage.getItem(RANGE_KEY) : null),
  )
  const [chartMode, setChartMode] = useState<ChartMode>('tokens')
  const [sortCol, setSortCol] = useState<SortColumn>('updated_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    document.title = 'Usage - AgentOS Control'
  }, [])

  // usage.js:350-366 — usage.status {} after waitForConnection; the view derives
  // every metric from status.sessions. Legacy polls every 60s and skips while
  // the tab is hidden; react-query's refetchInterval + refetchIntervalInBackground
  // false reproduces that pause/resume without a manual visibilitychange handler.
  const usageQuery = useQuery<UsageRow[]>({
    queryKey: ['usage'],
    queryFn: async () => {
      await rpc.waitForConnection()
      const status = await rpc.call<UsageStatus>('usage.status')
      return status.sessions ?? []
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })

  useEffect(() => {
    if (usageQuery.isError) {
      const err = usageQuery.error
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Failed to load usage: ' + message, { id: 'usage-load-err' })
    }
  }, [usageQuery.isError, usageQuery.error])

  const allSessions = useMemo(() => usageQuery.data ?? [], [usageQuery.data])
  const visible = useMemo(() => visibleSessions(allSessions, range), [allSessions, range])
  const metrics = useMemo(() => usageMetrics(visible), [visible])
  const compositionHint = useMemo(() => sourceCompositionHint(visible), [visible])
  const hiddenHint = useMemo(() => rangeHiddenHint(allSessions, range), [allSessions, range])
  const chart = useMemo(() => chartRows(visible, chartMode), [visible, chartMode])
  const grid = useMemo(() => modelBreakdownGrid(visible), [visible])
  const sorted = useMemo(() => sortSessions(visible, sortCol, sortAsc), [visible, sortCol, sortAsc])

  function pickRange(next: UsageRange) {
    setRange(next)
    try {
      localStorage.setItem(RANGE_KEY, next)
    } catch {
      /* storage unavailable — non-fatal */
    }
    setExpanded(new Set())
  }

  function onSort(col: string) {
    const key = col as SortColumn
    if (sortCol === key) setSortAsc((a) => !a)
    else {
      setSortCol(key)
      setSortAsc(false)
    }
  }
  const sortArrow = (col: string) => (sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : '')
  const ariaSort = (col: string): 'ascending' | 'descending' | 'none' =>
    sortCol === col ? (sortAsc ? 'ascending' : 'descending') : 'none'

  function openChat(key: string) {
    if (key && key !== '—') navigate('/chat?session=' + encodeURIComponent(key))
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function exportCsv() {
    const csv = buildCsv(visible)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvFilename(range)
    a.click()
    URL.revokeObjectURL(url)
  }

  const sessionMeta = [`${sorted.length} session${sorted.length === 1 ? '' : 's'}`, hiddenHint]
    .filter(Boolean)
    .join(' · ')

  const chartCaption =
    (chartMode === 'cost' ? 'Top sessions by cost' : 'Top sessions by total tokens') +
    (chart.poolSize > chart.shown ? ` · showing ${chart.shown} of ${chart.poolSize}` : '')

  return (
    <div className="usage-stage">
      <header className="usage-stage__header">
        <AsciiField />
        <div className="usage-stage__title-block">
          <span className="t-label">Control · Analytics</span>
          <h2 className="t-display">Usage</h2>
          <p className="usage-stage__subtitle">
            Tokens, cost, and per-model spend across every session.
          </p>
          {hiddenHint ? (
            <small className="usage-range-notice" aria-live="polite">
              {hiddenHint}
            </small>
          ) : null}
        </div>
        <div className="usage-stage__actions">
          <Button
            variant="outline"
            title="Download CSV"
            className="text-xs uppercase tracking-[0.14em]"
            onClick={exportCsv}
          >
            <DownloadIcon />
            <span>Export</span>
          </Button>
          <Button
            variant="outline"
            title="Refresh"
            className="text-xs uppercase tracking-[0.14em]"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['usage'] })}
          >
            <RefreshCwIcon />
            <span>Refresh</span>
          </Button>
        </div>
      </header>

      {/* ── Metric tiles ──────────────────────────────────────────────────── */}
      <section className="usage-stats" aria-label="Usage summary">
        <div className="usage-stat usage-stat--hero" aria-label="Total tokens">
          <span className="usage-stat__label t-label">Total tokens</span>
          <strong className="usage-stat__value t-data">
            {metrics.totalTokens.toLocaleString()}
          </strong>
          <span className="usage-stat__hint usage-stat__breakdown">
            <span>
              <em>In</em> {metrics.input.toLocaleString()}
            </span>
            <span>·</span>
            <span>
              <em>Out</em> {metrics.output.toLocaleString()}
            </span>
            {metrics.cacheRead ? (
              <>
                <span>·</span>
                <span>
                  <em>Cache R</em> {metrics.cacheRead.toLocaleString()}
                </span>
              </>
            ) : null}
            {metrics.cacheWrite ? (
              <>
                <span>·</span>
                <span>
                  <em>Cache W</em> {metrics.cacheWrite.toLocaleString()}
                </span>
              </>
            ) : null}
          </span>
        </div>
        <div className="usage-stat" aria-label="Total cost">
          <span className="usage-stat__label t-label">Total cost</span>
          <strong className="usage-stat__value t-data">
            {formatCost(metrics.cost, { decimals: 4 })}
          </strong>
          <span className="usage-stat__hint">{compositionHint}</span>
        </div>
        <div className="usage-stat" aria-label="Sessions">
          <span className="usage-stat__label t-label">Sessions</span>
          <strong className="usage-stat__value t-data">{metrics.sessions}</strong>
          <span className="usage-stat__hint">across all models</span>
        </div>
        <div className="usage-stat" aria-label="Avg cost / session">
          <span className="usage-stat__label t-label">Avg cost / session</span>
          <strong className="usage-stat__value t-data">
            {metrics.avgCost != null ? formatCost(metrics.avgCost, { decimals: 4 }) : '—'}
          </strong>
          <span className="usage-stat__hint">running average</span>
        </div>
      </section>

      {/* ── Chart ─────────────────────────────────────────────────────────── */}
      <section className="usage-chart panel">
        <div className="usage-chart__head">
          <div className="usage-segs" role="group" aria-label="Chart metric">
            <button
              type="button"
              className={`usage-seg${chartMode === 'tokens' ? ' is-active' : ''}`}
              aria-pressed={chartMode === 'tokens'}
              onClick={() => setChartMode('tokens')}
            >
              Tokens
            </button>
            <button
              type="button"
              className={`usage-seg${chartMode === 'cost' ? ' is-active' : ''}`}
              aria-pressed={chartMode === 'cost'}
              onClick={() => setChartMode('cost')}
            >
              Cost
            </button>
          </div>
          <div className="usage-range" role="group" aria-label="Date range">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`usage-range__btn${range === opt.value ? ' is-active' : ''}`}
                aria-pressed={range === opt.value}
                onClick={() => pickRange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="usage-chart__legend">
          <span className="usage-chart__legend-item">
            <span className="usage-chart__swatch usage-chart__swatch--input" />
            Input
          </span>
          {chartMode === 'tokens' ? (
            <span className="usage-chart__legend-item">
              <span className="usage-chart__swatch usage-chart__swatch--output" />
              Output
            </span>
          ) : null}
          <span className="usage-chart__legend-spacer" />
          <span className="usage-chart__caption">{chartCaption}</span>
        </div>
        {chart.bars.length === 0 ? (
          <div className="usage-bars__empty">
            <BarChart3Icon className="usage-bars__empty-icon" aria-hidden="true" />
            <div>No data in the selected window.</div>
          </div>
        ) : (
          <div className="usage-bars">
            {chart.bars.map((bar, i) => (
              <button
                key={bar.key + i}
                type="button"
                className="usage-bar-row"
                title={`Open ${bar.key}`}
                style={{ '--i': i } as React.CSSProperties}
                onClick={() => openChat(bar.key)}
              >
                <span className="usage-bar-row__label">{bar.label}</span>
                <span className="usage-bar-row__track">
                  <span
                    className="usage-bar-row__fill usage-bar-row__fill--input"
                    style={{ width: `${bar.inputPct.toFixed(1)}%` }}
                  />
                  {bar.outputPct > 0 ? (
                    <span
                      className="usage-bar-row__fill usage-bar-row__fill--output"
                      style={{ width: `${bar.outputPct.toFixed(1)}%` }}
                    />
                  ) : null}
                </span>
                <span className="usage-bar-row__value t-data">{bar.valueLabel}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── By model ──────────────────────────────────────────────────────── */}
      <section className="usage-models">
        <div className="usage-section-head">
          <h3 className="usage-section-title t-label">By model</h3>
          <span className="usage-section-meta t-data">
            {grid.models.length} model{grid.models.length === 1 ? '' : 's'}
          </span>
        </div>
        {grid.models.length === 0 ? (
          <div className="usage-models__empty">No model usage yet.</div>
        ) : (
          <div className="usage-model-grid" aria-label="By model breakdown">
            {grid.models.map((m, i) => (
              <article
                className="usage-model-card"
                key={m.model + i}
                style={{ '--i': i } as React.CSSProperties}
              >
                <header className="usage-model-card__head">
                  <div className="usage-model-card__id">
                    {m.provider ? (
                      <span className="usage-model-card__provider">{m.provider}</span>
                    ) : null}
                    <span className="usage-model-card__name" title={m.model}>
                      {m.name}
                    </span>
                  </div>
                  <span className="usage-model-card__share" title="Share of total cost">
                    {m.sharePct.toFixed(1)}%
                  </span>
                </header>
                <div className="usage-model-card__share-bar">
                  <span
                    className="usage-model-card__share-fill"
                    style={{ width: `${m.sharePct.toFixed(1)}%` }}
                  />
                </div>
                <dl className="usage-model-card__rows">
                  <div>
                    <dt>Tokens</dt>
                    <dd className="t-data">{m.totalTokens.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Input</dt>
                    <dd className="t-data usage-dim">{m.inputTokens.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Output</dt>
                    <dd className="t-data usage-dim">{m.outputTokens.toLocaleString()}</dd>
                  </div>
                  {m.cacheReadTokens > 0 ? (
                    <div>
                      <dt>Cache R</dt>
                      <dd className="t-data usage-dim">{m.cacheReadTokens.toLocaleString()}</dd>
                    </div>
                  ) : null}
                  {m.cacheWriteTokens > 0 ? (
                    <div>
                      <dt>Cache W</dt>
                      <dd className="t-data usage-dim">{m.cacheWriteTokens.toLocaleString()}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Sessions</dt>
                    <dd>{m.sessions}</dd>
                  </div>
                  <div className="usage-model-card__cost-row">
                    <dt>Cost</dt>
                    <dd className="t-data usage-cost">{formatCost(m.costUsd)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── Sessions table ────────────────────────────────────────────────── */}
      <section className="usage-sessions">
        <div className="usage-section-head">
          <h3 className="usage-section-title t-label">Sessions</h3>
          <span className="usage-section-meta t-data">{sessionMeta}</span>
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                {TABLE_COLUMNS.map((col) =>
                  col.sortable ? (
                    <th key={col.key} aria-sort={ariaSort(col.key)}>
                      <button
                        type="button"
                        className="usage-th-sort"
                        onClick={() => onSort(col.key)}
                      >
                        {col.label}
                        <span aria-hidden="true">{sortArrow(col.key)}</span>
                      </button>
                    </th>
                  ) : (
                    <th key={col.key}>{col.label}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={TABLE_COLUMNS.length} className="usage-empty-row">
                    <div className="usage-empty">
                      <BarChart3Icon className="usage-empty__icon" aria-hidden="true" />
                      <div className="usage-empty__title">No usage data yet</div>
                      <p className="usage-empty__msg">
                        Run a session and token spend will appear here automatically.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                sorted.map((row, rowIndex) => {
                  const key = String(
                    rowVal(row as Record<string, unknown>, 'session', 'sessionKey', 'key') ?? '',
                  )
                  const ts = sessionTimestamp(row)
                  const badge = costSourceBadge(row as Record<string, unknown>)
                  const modelLabel = modelDisplayLabel(row)
                  const canExpand = hasModelExpand(row)
                  const isOpen = expanded.has(key)
                  return (
                    <ExpandableRow
                      key={key || `row-${rowIndex}`}
                      row={row}
                      sessionKey={key}
                      modified={ts != null ? formatRelTime(ts) : '—'}
                      badge={badge}
                      modelLabel={modelLabel}
                      canExpand={canExpand}
                      isOpen={isOpen}
                      colSpan={TABLE_COLUMNS.length}
                      onOpenChat={() => openChat(key)}
                      onToggle={() => toggleExpand(key)}
                    />
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ── Table row (+ optional inline model-breakdown expansion) ───────────────────
function ExpandableRow({
  row,
  sessionKey,
  modified,
  badge,
  modelLabel,
  canExpand,
  isOpen,
  colSpan,
  onOpenChat,
  onToggle,
}: {
  row: UsageRow
  sessionKey: string
  modified: string
  badge: CostSourceBadge
  modelLabel: string
  canExpand: boolean
  isOpen: boolean
  colSpan: number
  onOpenChat: () => void
  onToggle: () => void
}) {
  return (
    <>
      <tr>
        <td data-label="Session">
          {sessionKey ? (
            <button
              type="button"
              className="usage-sess-link t-data"
              title={`Open chat for ${sessionKey}`}
              onClick={onOpenChat}
            >
              {sessionKey}
            </button>
          ) : (
            '—'
          )}
        </td>
        <td data-label="Modified" className="t-data usage-dim">
          {modified}
        </td>
        <td data-label="Input" className="t-data">
          {localized(num(row, 'input_tokens', 'inputTokens'))}
        </td>
        <td data-label="Output" className="t-data">
          {localized(num(row, 'output_tokens', 'outputTokens'))}
        </td>
        <td data-label="Cache R" className="t-data usage-dim">
          {localized(num(row, 'cache_read_tokens', 'cacheReadTokens'))}
        </td>
        <td data-label="Cache W" className="t-data usage-dim">
          {localized(num(row, 'cache_write_tokens', 'cacheWriteTokens'))}
        </td>
        <td data-label="Cost" className="t-data usage-cost">
          {formatCost(num(row, 'cost_usd', 'costUsd'))}
        </td>
        <td data-label="Source">
          <SourceBadge badge={badge} />
        </td>
        <td data-label="Model">
          {canExpand ? (
            <button
              type="button"
              className={`usage-model-toggle${isOpen ? ' open' : ''}`}
              aria-expanded={isOpen}
              onClick={onToggle}
            >
              <span>{modelLabel}</span>
              <span className="usage-model-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            <span className="usage-model-text">{modelLabel}</span>
          )}
        </td>
      </tr>
      {canExpand && isOpen ? (
        <tr className="usage-expand-row">
          <td className="usage-expand-cell" colSpan={colSpan}>
            <ModelExpansion row={row} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

// usage.js:651-724 — the inline per-model breakdown for an expanded session.
function ModelExpansion({ row }: { row: UsageRow }) {
  const ex = sessionExpandRows(row)
  return (
    <div className="usage-expand">
      <div className="usage-expand__head">
        <span className="usage-expand__connector" aria-hidden="true" />
        <span className="usage-expand__eyebrow">Model breakdown</span>
        <span className="usage-expand__count">
          {ex.count} model{ex.count === 1 ? '' : 's'}
        </span>
        <span className="usage-expand__spacer" />
        <span className="usage-expand__total">
          {ex.totalTokens.toLocaleString()} tokens · {formatCost(ex.totalCost)}
        </span>
      </div>
      {ex.anyProrated ? (
        <div className="usage-expand__notice" role="note">
          Per-model split is estimated; total is the actual billed amount.
        </div>
      ) : null}
      <div className="usage-expand__list" role="table" aria-label="Model breakdown">
        {ex.rows.map((m, i) => (
          <div
            className="usage-expand__row"
            role="row"
            key={m.model + i}
            style={{ '--i': i } as React.CSSProperties}
          >
            <div className="usage-expand__model" role="cell" title={m.model}>
              {m.provider ? <span className="usage-expand__provider">{m.provider}/</span> : null}
              <span className="usage-expand__name">{m.name}</span>
            </div>
            <div className="usage-expand__share" role="cell">
              <span className="usage-expand__share-track">
                <span
                  className="usage-expand__share-fill"
                  style={{ width: `${m.sharePct.toFixed(2)}%` }}
                />
              </span>
              <span className="usage-expand__share-pct">{m.sharePct.toFixed(1)}%</span>
            </div>
            <div className="usage-expand__tokens" role="cell">
              {m.tokens.toLocaleString()}
            </div>
            <div className="usage-expand__cost" role="cell">
              {formatCost(m.cost)}
            </div>
            <div className="usage-expand__source" role="cell">
              <SourceBadge badge={m.badge} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
