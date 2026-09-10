import {
  isValidHost,
  isValidPort,
  type DesktopSettings,
  type GatewaySettings,
} from '@shared/settings'
import type { GatewayStatus } from '@shared/gateway'
import type { AppInfo } from '@shared/app'
import type { SettingsSection } from '~/stores/ui'

/* ── Gateway form ───────────────────────────────────────────────────────── */

/** What the Gateway pane edits: strings, so a half-typed port is representable. */
export interface GatewayDraft {
  mode: GatewaySettings['mode']
  host: string
  port: string
  token: string
  cliPath: string
}

export function draftFromGateway(gw: GatewaySettings): GatewayDraft {
  return {
    mode: gw.mode,
    host: gw.host,
    port: String(gw.port),
    token: gw.token ?? '',
    cliPath: gw.cliPath ?? '',
  }
}

export function gatewayFromDraft(draft: GatewayDraft): GatewaySettings {
  return {
    mode: draft.mode,
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    token: draft.token.trim() || null,
    cliPath: draft.cliPath.trim() || null,
  }
}

export interface GatewayDraftErrors {
  host?: 'invalid'
  port?: 'invalid'
}

export function gatewayDraftErrors(draft: GatewayDraft): GatewayDraftErrors {
  const errors: GatewayDraftErrors = {}
  if (!isValidHost(draft.host)) errors.host = 'invalid'
  const port = Number(draft.port.trim())
  if (!/^\d+$/.test(draft.port.trim()) || !isValidPort(port)) errors.port = 'invalid'
  return errors
}

/** True when saving the draft would change what is on disk. */
export function gatewayDirty(saved: GatewaySettings, draft: GatewayDraft): boolean {
  const next = gatewayFromDraft(draft)
  return (
    next.mode !== saved.mode ||
    next.host !== saved.host ||
    next.port !== saved.port ||
    next.token !== saved.token ||
    next.cliPath !== saved.cliPath
  )
}

/**
 * The running gateway was started from a different endpoint or mode than the
 * saved settings describe. Token and CLI path changes matter too, but only a
 * managed gateway is ours to restart; for an external one the endpoint is
 * the whole story.
 */
export function gatewayNeedsRestart(saved: GatewaySettings, status: GatewayStatus): boolean {
  if (status.state !== 'running' && status.state !== 'starting') return false
  if (!status.url) return false
  return status.url !== `http://${saved.host}:${saved.port}`
}

/* ── Models ─────────────────────────────────────────────────────────────── */

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

export interface CatalogModel {
  id: string
  name: string
  provider: string
}

export interface ModelOption {
  id: string
  label: string
  /** The current model is not in the catalog; keep it selectable. */
  custom?: boolean
}

/**
 * The picker lists the active provider's models, catalog order, and keeps the
 * configured model selectable even when the catalog does not know it (a
 * model typed into config.toml, or a provider whose catalog is offline).
 */
export function modelOptions(
  models: readonly CatalogModel[],
  provider: string,
  current: string,
): ModelOption[] {
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const m of models) {
    if (provider && m.provider !== provider) continue
    if (!m.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push({ id: m.id, label: m.name && m.name !== m.id ? `${m.name}  ·  ${m.id}` : m.id })
  }
  if (current && !seen.has(current)) out.unshift({ id: current, label: current, custom: true })
  return out
}

/** Read `agentos_router.tiers` (a dict of tier -> {model, ...}) into rows. */
export function routerTiers(raw: unknown): { tier: string; model: string }[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, unknown>)
    .map(([tier, cfg]) => ({
      tier,
      model:
        cfg && typeof cfg === 'object' && typeof (cfg as { model?: unknown }).model === 'string'
          ? ((cfg as { model: string }).model ?? '')
          : '',
    }))
    .filter((row) => row.model)
}

/* ── About ──────────────────────────────────────────────────────────────── */

/** "3d 4h", "2h 05m", "12m", "40s". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/* ── Advanced ───────────────────────────────────────────────────────────── */

/** Plain-text report for a bug report. The auth token never leaves the app. */
export function diagnosticsReport(input: {
  info: AppInfo | null
  gateway: GatewayStatus
  settings: DesktopSettings
  gatewayVersion?: string | null
  configPath?: string | null
  now?: Date
}): string {
  const { info, gateway, settings } = input
  const redacted = {
    ...settings,
    gateway: { ...settings.gateway, token: settings.gateway.token ? '<redacted>' : null },
  }
  const lines = [
    `AgentOS desktop diagnostics · ${(input.now ?? new Date()).toISOString()}`,
    '',
    `app: ${info?.version ?? '?'}${info && !info.packaged ? ' (dev)' : ''}`,
    `electron: ${info?.electron ?? '?'}  chromium: ${info?.chrome ?? '?'}  node: ${info?.node ?? '?'}`,
    `platform: ${info?.platform ?? '?'} ${info?.arch ?? ''}`.trimEnd(),
    '',
    `gateway: ${gateway.state}${gateway.url ? ` ${gateway.url}` : ''}${gateway.pid ? ` pid ${gateway.pid}` : ''}`,
    `gateway version: ${input.gatewayVersion ?? 'unknown'}`,
    `gateway config: ${input.configPath ?? 'unknown'}`,
  ]
  if (gateway.error) lines.push(`gateway error: ${gateway.error}`)
  lines.push('', 'settings:', JSON.stringify(redacted, null, 2))
  return lines.join('\n')
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

/** Sections whose title or blurb contains the query (case-insensitive). */
export function filterSections<T extends { id: SettingsSection; title: string; blurb: string }>(
  sections: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...sections]
  return sections.filter(
    (s) => s.title.toLowerCase().includes(q) || s.blurb.toLowerCase().includes(q),
  )
}
