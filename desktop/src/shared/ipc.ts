import type { AppInfo, ChooseFileOptions } from './app'
import type { GatewayStatus } from './gateway'
import type { DesktopSettings, SettingsPatch } from './settings'
import type { ResolvedTheme, ThemeSettings } from './theme'

export type { SettingsPatch } from './settings'

/**
 * Single source of truth for IPC channel names. Main registers handlers,
 * preload invokes them, renderer only ever sees the typed `DesktopApi`.
 */
export const IPC = {
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset',
    /** Main -> renderer: the menu bar (⌘,) asked for the Settings window. */
    open: 'settings:open',
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
    restart: 'gateway:restart',
    /** Main -> renderer: status transitions. */
    changed: 'gateway:changed',
  },
  app: {
    version: 'app:version',
    info: 'app:info',
    openExternal: 'app:openExternal',
    showItemInFolder: 'app:showItemInFolder',
    openPath: 'app:openPath',
    chooseFile: 'app:chooseFile',
    loginItem: 'app:loginItem',
  },
} as const

/**
 * The surface exposed on `window.agentos` by the preload script. Kept here so
 * main, preload and renderer type-check against the same shape.
 */
export interface DesktopApi {
  app: {
    version(): Promise<string>
    info(): Promise<AppInfo>
    /** Open an http(s) URL in the default browser. Other schemes are refused. */
    openExternal(url: string): Promise<void>
    /** Reveal a file in Finder. */
    showItemInFolder(path: string): Promise<void>
    /** Open a file or folder with its default app. Resolves to '' or an error message. */
    openPath(path: string): Promise<string>
    /** Native open sheet; null when cancelled. */
    chooseFile(options?: ChooseFileOptions): Promise<string | null>
    /** What macOS reports for the login item, not what settings say. */
    loginItem(): Promise<boolean>
  }
  settings: {
    get(): Promise<DesktopSettings>
    update(patch: SettingsPatch): Promise<DesktopSettings>
    reset(): Promise<DesktopSettings>
    onOpenRequested(listener: () => void): () => void
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
    restart(): Promise<GatewayStatus>
    onChanged(listener: (status: GatewayStatus) => void): () => void
  }
}
