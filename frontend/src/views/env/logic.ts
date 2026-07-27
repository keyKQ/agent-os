/**
 * Pure helpers for the Environment screen.
 *
 * Kept out of the component so the grouping, filtering, and validation rules
 * can be tested without a DOM — the same split the Skills and MCP views use.
 */

/** Shared so the Settings glance and the Environment screen hit one cache. */
export const ENV_QUERY_KEY = ['env', 'list'] as const

export type EnvSource = 'process' | 'cwd_file' | 'home_file' | 'unset'

export interface EnvVarRow {
  name: string
  isSet: boolean
  source: EnvSource
  /** Masked for secrets, the real setting for non-secrets, null when unset. */
  masked: string | null
  secret: boolean
  description: string
  url: string
  category: string
  owner: string
  required: boolean
  writable: boolean
  restartRequired: boolean
  missing: boolean
}

export interface EnvListResponse {
  envFilePath: string
  vars: EnvVarRow[]
  setCount: number
  totalCount: number
  shadowedCount: number
}

export type EnvFilter = 'all' | 'missing' | 'set' | 'custom'

/** Category order in the UI: what a new install configures first comes first. */
const CATEGORY_ORDER = ['provider', 'search', 'image', 'audio', 'memory', 'skill', 'custom']

const CATEGORY_LABELS: Record<string, string> = {
  provider: 'LLM providers',
  search: 'Search',
  image: 'Image generation',
  audio: 'Audio',
  memory: 'Memory embedding',
  skill: 'Skills',
  custom: 'Your own variables',
}

const SOURCE_LABELS: Record<EnvSource, string> = {
  process: 'process env',
  cwd_file: 'project .env',
  home_file: 'AgentOS .env',
  unset: '',
}

/** POSIX-portable variable name — mirrors the server-side gate. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

export function sourceLabel(source: EnvSource): string {
  return SOURCE_LABELS[source] ?? source
}

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name.trim())
}

/**
 * A value coming from `process` is being overridden by the environment the
 * gateway was started with, so editing the file changes nothing until that
 * export goes away. It is the difference between "saved" and "in effect".
 */
export function isShadowed(row: EnvVarRow): boolean {
  return row.source === 'process'
}

export function filterVars(rows: EnvVarRow[], filter: EnvFilter, query: string): EnvVarRow[] {
  const needle = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter === 'missing' && row.isSet) return false
    if (filter === 'set' && !row.isSet) return false
    if (filter === 'custom' && row.category !== 'custom') return false
    if (!needle) return true
    return (
      row.name.toLowerCase().includes(needle) ||
      row.description.toLowerCase().includes(needle) ||
      row.owner.toLowerCase().includes(needle)
    )
  })
}

export interface EnvGroup {
  category: string
  label: string
  rows: EnvVarRow[]
  setCount: number
}

export function groupByCategory(rows: EnvVarRow[]): EnvGroup[] {
  const buckets = new Map<string, EnvVarRow[]>()
  for (const row of rows) {
    const bucket = buckets.get(row.category)
    if (bucket) bucket.push(row)
    else buckets.set(row.category, [row])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      const ai = CATEGORY_ORDER.indexOf(a)
      const bi = CATEGORY_ORDER.indexOf(b)
      // Unknown categories sort last but stay stable among themselves.
      return (ai === -1 ? CATEGORY_ORDER.length : ai) - (bi === -1 ? CATEGORY_ORDER.length : bi)
    })
    .map(([category, groupRows]) => ({
      category,
      label: categoryLabel(category),
      rows: [...groupRows].sort((a, b) => a.name.localeCompare(b.name)),
      setCount: groupRows.filter((row) => row.isSet).length,
    }))
}

export interface EnvSummary {
  setCount: number
  totalCount: number
  shadowedCount: number
  missingCount: number
}

export function summarize(payload: EnvListResponse | undefined): EnvSummary {
  const rows = payload?.vars ?? []
  return {
    setCount: payload?.setCount ?? rows.filter((r) => r.isSet).length,
    totalCount: payload?.totalCount ?? rows.length,
    shadowedCount: payload?.shadowedCount ?? rows.filter(isShadowed).length,
    missingCount: rows.filter((r) => r.missing).length,
  }
}

/**
 * Client-side name check for the "add a variable" form. The server is still
 * the authority — this exists so a typo is answered instantly instead of
 * after a round trip.
 */
export function validateNewName(name: string, known: EnvVarRow[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a variable name.'
  if (!isValidEnvName(trimmed)) {
    return 'Use letters, digits, and underscores, starting with a letter or underscore.'
  }
  const existing = known.find((row) => row.name === trimmed)
  if (existing && !existing.writable) {
    return 'This name cannot be written through AgentOS.'
  }
  return null
}
