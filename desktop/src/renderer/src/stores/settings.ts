import { create } from 'zustand'
import type { SettingsPatch } from '@shared/ipc'
import { DEFAULT_SETTINGS, type DesktopSettings } from '@shared/settings'
import { desktopApi } from '~/lib/desktop-api'

interface SettingsStore {
  settings: DesktopSettings
  loaded: boolean
  load(): Promise<void>
  update(patch: SettingsPatch): Promise<void>
}

/** Renderer mirror of the persisted DesktopSettings (theme has its own store). */
export const useSettings = create<SettingsStore>((set) => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  loaded: false,
  async load() {
    set({ settings: await desktopApi().settings.get(), loaded: true })
  },
  async update(patch) {
    set({ settings: await desktopApi().settings.update(patch) })
  },
}))
