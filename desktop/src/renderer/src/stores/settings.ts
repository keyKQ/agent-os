import { create } from 'zustand'
import type { SettingsPatch } from '@shared/ipc'
import { DEFAULT_SETTINGS, type AppearanceSettings, type DesktopSettings } from '@shared/settings'
import { desktopApi } from '~/lib/desktop-api'

interface SettingsStore {
  settings: DesktopSettings
  loaded: boolean
  load(): Promise<void>
  update(patch: SettingsPatch): Promise<void>
  reset(): Promise<void>
}

/**
 * Text size and transparency are painted as attributes on <html> so CSS can
 * key off them (tokens.css). Colour is not here: that is theme-store's job.
 */
export function applyAppearance(appearance: AppearanceSettings, root?: HTMLElement): void {
  const el = root ?? document.documentElement
  el.setAttribute('data-text-size', appearance.textSize)
  el.setAttribute('data-transparency', appearance.reduceTransparency ? 'reduced' : 'normal')
}

/** Renderer mirror of the persisted DesktopSettings (theme has its own store). */
export const useSettings = create<SettingsStore>((set) => {
  const receive = (settings: DesktopSettings) => {
    applyAppearance(settings.appearance)
    set({ settings, loaded: true })
  }
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    loaded: false,
    async load() {
      receive(await desktopApi().settings.get())
    },
    async update(patch) {
      receive(await desktopApi().settings.update(patch))
    },
    async reset() {
      receive(await desktopApi().settings.reset())
    },
  }
})
