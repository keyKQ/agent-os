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

/** Behaviour of the shell itself: launch, quit, and how the composer sends. */
export interface GeneralSettings {
  /** Register the app as a macOS login item. Mirrored by main on change. */
  openAtLogin: boolean
  /** Stop a managed gateway when the app quits (off: leave it running). */
  stopGatewayOnQuit: boolean
  /** What the window shows at launch: the home screen or the last session. */
  launchView: 'home' | 'last'
  /** Enter sends and Shift+Enter breaks the line; off swaps them (⌘Enter sends). */
  enterToSend: boolean
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  openAtLogin: false,
  stopGatewayOnQuit: true,
  launchView: 'home',
  enterToSend: true,
}

export type TextSize = 'small' | 'default' | 'large'
export const TEXT_SIZES: readonly TextSize[] = ['small', 'default', 'large']

/** Appearance beyond colour: the theme axes live in `ThemeSettings`. */
export interface AppearanceSettings {
  textSize: TextSize
  /** Opaque sidebar and no window vibrancy (System Settings > Accessibility). */
  reduceTransparency: boolean
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  textSize: 'default',
  reduceTransparency: false,
}

export interface NotificationSettings {
  /** Short chime when a reply finishes. */
  sound: boolean
  /** macOS notification when a reply finishes while the window is not focused. */
  replyDone: boolean
  /** macOS notification when the agent is waiting for an approval. */
  approvals: boolean
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  sound: true,
  replyDone: true,
  approvals: true,
}

export interface DesktopSettings {
  theme: ThemeSettings
  gateway: GatewaySettings
  general: GeneralSettings
  appearance: AppearanceSettings
  notifications: NotificationSettings
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: DEFAULT_THEME_SETTINGS,
  gateway: DEFAULT_GATEWAY_SETTINGS,
  general: DEFAULT_GENERAL_SETTINGS,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
}

export const SETTINGS_SECTIONS = [
  'theme',
  'gateway',
  'general',
  'appearance',
  'notifications',
] as const satisfies readonly (keyof DesktopSettings)[]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** A host is a bare hostname or IP literal: no scheme, path, port or spaces. */
export function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const host = value.trim()
  if (!host || host.length > 253) return false
  // Bracketed IPv6 literal, the only place a colon is allowed.
  if (host.startsWith('[') && host.endsWith(']')) return /^[0-9A-Fa-f:.]+$/.test(host.slice(1, -1))
  if (/[\s/\\:@?#[\]]/.test(host)) return false
  return /^[A-Za-z0-9.-]+$/.test(host)
}

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
}

function normalizeGateway(raw: unknown): GatewaySettings {
  const obj = asRecord(raw)
  const port = Number(obj.port)
  return {
    mode: obj.mode === 'external' ? 'external' : 'managed',
    host: isValidHost(obj.host) ? obj.host.trim() : DEFAULT_GATEWAY_SETTINGS.host,
    port: isValidPort(port) ? port : DEFAULT_GATEWAY_SETTINGS.port,
    token: typeof obj.token === 'string' && obj.token.trim() ? obj.token.trim() : null,
    cliPath: typeof obj.cliPath === 'string' && obj.cliPath.trim() ? obj.cliPath.trim() : null,
  }
}

function normalizeGeneral(raw: unknown): GeneralSettings {
  const obj = asRecord(raw)
  const d = DEFAULT_GENERAL_SETTINGS
  return {
    openAtLogin: bool(obj.openAtLogin, d.openAtLogin),
    stopGatewayOnQuit: bool(obj.stopGatewayOnQuit, d.stopGatewayOnQuit),
    launchView: obj.launchView === 'last' ? 'last' : 'home',
    enterToSend: bool(obj.enterToSend, d.enterToSend),
  }
}

function normalizeAppearance(raw: unknown): AppearanceSettings {
  const obj = asRecord(raw)
  const d = DEFAULT_APPEARANCE_SETTINGS
  return {
    textSize: (TEXT_SIZES as readonly unknown[]).includes(obj.textSize)
      ? (obj.textSize as TextSize)
      : d.textSize,
    reduceTransparency: bool(obj.reduceTransparency, d.reduceTransparency),
  }
}

function normalizeNotifications(raw: unknown): NotificationSettings {
  const obj = asRecord(raw)
  const d = DEFAULT_NOTIFICATION_SETTINGS
  return {
    sound: bool(obj.sound, d.sound),
    replyDone: bool(obj.replyDone, d.replyDone),
    approvals: bool(obj.approvals, d.approvals),
  }
}

/** Validate a settings blob read from disk. Unknown keys are dropped. */
export function normalizeSettings(raw: unknown): DesktopSettings {
  const obj = asRecord(raw)
  return {
    theme: normalizeThemeSettings(obj.theme),
    gateway: normalizeGateway(obj.gateway),
    general: normalizeGeneral(obj.general),
    appearance: normalizeAppearance(obj.appearance),
    notifications: normalizeNotifications(obj.notifications),
  }
}

/** Deep partial used by `settings:update` so callers patch one section. */
export type SettingsPatch = {
  [K in keyof DesktopSettings]?: Partial<DesktopSettings[K]>
}

/** Shallow-merge a patch section by section, then validate the result. */
export function mergeSettings(current: DesktopSettings, patch: SettingsPatch): DesktopSettings {
  const merged: Record<string, unknown> = {}
  for (const section of SETTINGS_SECTIONS) {
    merged[section] = { ...current[section], ...(patch[section] ?? {}) }
  }
  return normalizeSettings(merged)
}
