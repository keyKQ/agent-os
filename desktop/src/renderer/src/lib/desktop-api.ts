import type { DesktopApi } from '@shared/ipc'
import { STOPPED_GATEWAY, type GatewayStatus } from '@shared/gateway'
import { DEFAULT_SETTINGS, normalizeSettings, type DesktopSettings } from '@shared/settings'
import { resolveTheme, type ResolvedTheme, type ThemeSettings } from '@shared/theme'

const FALLBACK_KEY = 'agentos-desktop.settings'

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

  return {
    app: {
      version: async () => 'browser',
    },
    settings: {
      get: async () => structuredClone(settings),
      update: async (patch) =>
        save({
          theme: { ...settings.theme, ...(patch.theme ?? {}) },
          gateway: { ...settings.gateway, ...(patch.gateway ?? {}) },
        }),
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
    gateway: {
      status: async (): Promise<GatewayStatus> => ({ ...STOPPED_GATEWAY }),
      start: async (): Promise<GatewayStatus> => ({
        ...STOPPED_GATEWAY,
        state: 'error',
        error: 'Gateway control is only available inside the desktop app.',
      }),
      stop: async (): Promise<GatewayStatus> => ({ ...STOPPED_GATEWAY }),
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
