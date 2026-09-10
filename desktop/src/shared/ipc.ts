import type { GatewayStatus } from './gateway'
import type { DesktopSettings } from './settings'
import type { ResolvedTheme, ThemeSettings } from './theme'

/**
 * Single source of truth for IPC channel names. Main registers handlers,
 * preload invokes them, renderer only ever sees the typed `DesktopApi`.
 */
export const IPC = {
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  theme: {
    /** Renderer -> main: persist + apply nativeTheme.themeSource. */
    set: 'theme:set',
    /** Renderer -> main: ask what the OS currently resolves to. */
    resolved: 'theme:resolved',
    /** Main -> renderer: OS appearance changed. */
    changed: 'theme:changed',
  },
  gateway: {
    status: 'gateway:status',
    start: 'gateway:start',
    stop: 'gateway:stop',
    /** Main -> renderer: status transitions. */
    changed: 'gateway:changed',
  },
  app: {
    version: 'app:version',
  },
} as const

/** Deep partial used by `settings:update` so callers patch one section. */
export type SettingsPatch = {
  [K in keyof DesktopSettings]?: Partial<DesktopSettings[K]>
}

/**
 * The surface exposed on `window.agentos` by the preload script. Kept here so
 * main, preload and renderer type-check against the same shape.
 */
export interface DesktopApi {
  app: {
    version(): Promise<string>
  }
  settings: {
    get(): Promise<DesktopSettings>
    update(patch: SettingsPatch): Promise<DesktopSettings>
  }
  theme: {
    set(next: Partial<ThemeSettings>): Promise<ThemeSettings>
    resolved(): Promise<ResolvedTheme>
    onChanged(listener: (resolved: ResolvedTheme) => void): () => void
  }
  gateway: {
    status(): Promise<GatewayStatus>
    start(): Promise<GatewayStatus>
    stop(): Promise<GatewayStatus>
    onChanged(listener: (status: GatewayStatus) => void): () => void
  }
}
