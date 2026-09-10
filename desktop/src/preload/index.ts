import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi, type SettingsPatch } from '@shared/ipc'
import type { GatewayStatus } from '@shared/gateway'
import type { ResolvedTheme, ThemeSettings } from '@shared/theme'

/** Subscribe to a main -> renderer push channel and return an unsubscribe. */
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DesktopApi = {
  app: {
    version: () => ipcRenderer.invoke(IPC.app.version),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    update: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settings.update, patch),
  },
  theme: {
    set: (next: Partial<ThemeSettings>) => ipcRenderer.invoke(IPC.theme.set, next),
    resolved: () => ipcRenderer.invoke(IPC.theme.resolved),
    onChanged: (listener) => listen<ResolvedTheme>(IPC.theme.changed, listener),
  },
  gateway: {
    status: () => ipcRenderer.invoke(IPC.gateway.status),
    start: () => ipcRenderer.invoke(IPC.gateway.start),
    stop: () => ipcRenderer.invoke(IPC.gateway.stop),
    onChanged: (listener) => listen<GatewayStatus>(IPC.gateway.changed, listener),
  },
}

contextBridge.exposeInMainWorld('agentos', api)
