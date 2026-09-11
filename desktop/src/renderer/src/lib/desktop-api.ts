import type { AppInfo } from '@shared/app'
import type { DesktopApi } from '@shared/ipc'
import { STOPPED_GATEWAY, type GatewayStatus } from '@shared/gateway'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  type DesktopSettings,
} from '@shared/settings'
import { resolveTheme, type ResolvedTheme, type ThemeSettings } from '@shared/theme'

const FALLBACK_KEY = 'agentos-desktop.settings'

const BROWSER_INFO: AppInfo = {
  version: 'browser',
  electron: '',
  chrome: '',
  node: '',
  platform: 'browser',
  arch: '',
  packaged: false,
  paths: { userData: '', settings: `localStorage:${FALLBACK_KEY}`, logs: '' },
}

/**
 * Browser/vitest stand-in for the preload bridge. Persists to localStorage so
 * `npm run dev` in a plain browser tab and unit tests still behave; the
 * gateway section is inert because nothing can spawn a process from here.
 */
function createFallbackApi(): DesktopApi {
  let settings: DesktopSettings = load()
  const themeListeners = new Set<(r: ResolvedTheme) => void>()

  function load(): DesktopSettings {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY)
      return raw ? normalizeSettings(JSON.parse(raw)) : structuredClone(DEFAULT_SETTINGS)
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }
  function save(next: DesktopSettings): DesktopSettings {
    settings = normalizeSettings(next)
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(settings))
    } catch {
      /* storage blocked: keep in memory */
    }
    return structuredClone(settings)
  }
  function systemDark(): boolean {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch {
      return false
    }
  }
  const stoppedOnly = async (): Promise<GatewayStatus> => ({ ...STOPPED_GATEWAY })
  const cannotControl = async (): Promise<GatewayStatus> => ({
    ...STOPPED_GATEWAY,
    state: 'error',
    error: 'Gateway control is only available inside the desktop app.',
  })

  return {
    app: {
      version: async () => BROWSER_INFO.version,
      info: async () => structuredClone(BROWSER_INFO),
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener')
      },
      showItemInFolder: async () => {},
      openPath: async () => 'Only available inside the desktop app.',
      chooseFile: async () => null,
      loginItem: async () => settings.general.openAtLogin,
    },
    settings: {
      get: async () => structuredClone(settings),
      update: async (patch) => save(mergeSettings(settings, patch)),
      reset: async () => save(structuredClone(DEFAULT_SETTINGS)),
      onOpenRequested: () => () => {},
    },
    theme: {
      set: async (next: Partial<ThemeSettings>) => {
        const saved = save({ ...settings, theme: { ...settings.theme, ...next } })
        const resolved = resolveTheme(saved.theme.preference, systemDark())
        for (const fn of themeListeners) fn(resolved)
        return saved.theme
      },
      resolved: async () => resolveTheme(settings.theme.preference, systemDark()),
      onChanged: (listener) => {
        themeListeners.add(listener)
        return () => themeListeners.delete(listener)
      },
    },
    pets: {
      manifest: async () => [],
      installed: async () => [],
      install: async () => {
        throw new Error('Pets are only available inside the desktop app.')
      },
      remove: async () => {},
      preview: async () => {
        throw new Error('Pets are only available inside the desktop app.')
      },
    },
    gateway: {
      status: stoppedOnly,
      start: cannotControl,
      stop: stoppedOnly,
      restart: cannotControl,
      onChanged: () => () => {},
    },
  }
}

let cached: DesktopApi | null = null

/** True when running inside the Electron shell with the preload bridge. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.agentos
}

export function desktopApi(): DesktopApi {
  if (typeof window !== 'undefined' && window.agentos) return window.agentos
  cached ??= createFallbackApi()
  return cached
}

/** Test hook: drop the fallback instance so each test starts clean. */
export function resetDesktopApiForTests(): void {
  cached = null
}
