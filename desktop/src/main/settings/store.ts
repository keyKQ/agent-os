import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, normalizeSettings, type DesktopSettings } from '@shared/settings'
import type { SettingsPatch } from '@shared/ipc'

/**
 * Tiny JSON-backed settings store. One file, read once at boot, written
 * atomically (tmp + rename) on every change. No dependency on electron-store
 * so the module stays testable in plain Node.
 */
export class SettingsStore {
  private value: DesktopSettings
  private readonly listeners = new Set<(s: DesktopSettings) => void>()

  constructor(private readonly filePath: string) {
    this.value = this.load()
  }

  get(): DesktopSettings {
    return structuredClone(this.value)
  }

  update(patch: SettingsPatch): DesktopSettings {
    const merged: DesktopSettings = {
      theme: { ...this.value.theme, ...(patch.theme ?? {}) },
      gateway: { ...this.value.gateway, ...(patch.gateway ?? {}) },
    }
    this.value = normalizeSettings(merged)
    this.persist()
    for (const fn of this.listeners) fn(this.get())
    return this.get()
  }

  subscribe(fn: (s: DesktopSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private load(): DesktopSettings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.filePath)
  }
}
