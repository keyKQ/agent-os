import { DEFAULT_THEME_SETTINGS, normalizeThemeSettings, type ThemeSettings } from './theme'

/** Where the desktop shell finds (or launches) the AgentOS gateway. */
export interface GatewaySettings {
  /** `managed`: the app spawns `agentos gateway run`. `external`: connect only. */
  mode: 'managed' | 'external'
  host: string
  port: number
  /** Bearer token for gateways running with auth.mode = "token". */
  token: string | null
  /** Explicit path to the `agentos` CLI; null = auto-locate on PATH. */
  cliPath: string | null
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  mode: 'managed',
  host: '127.0.0.1',
  port: 18791,
  token: null,
  cliPath: null,
}

export interface DesktopSettings {
  theme: ThemeSettings
  gateway: GatewaySettings
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: DEFAULT_THEME_SETTINGS,
  gateway: DEFAULT_GATEWAY_SETTINGS,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function normalizeGateway(raw: unknown): GatewaySettings {
  const obj = asRecord(raw)
  const port = Number(obj.port)
  return {
    mode: obj.mode === 'external' ? 'external' : 'managed',
    host: typeof obj.host === 'string' && obj.host ? obj.host : DEFAULT_GATEWAY_SETTINGS.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_GATEWAY_SETTINGS.port,
    token: typeof obj.token === 'string' && obj.token ? obj.token : null,
    cliPath: typeof obj.cliPath === 'string' && obj.cliPath ? obj.cliPath : null,
  }
}

/** Validate a settings blob read from disk. Unknown keys are dropped. */
export function normalizeSettings(raw: unknown): DesktopSettings {
  const obj = asRecord(raw)
  return {
    theme: normalizeThemeSettings(obj.theme),
    gateway: normalizeGateway(obj.gateway),
  }
}
