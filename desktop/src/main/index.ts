import { app, BrowserWindow, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import path from 'node:path'
import type { DesktopSettings } from '@shared/settings'
import { GatewaySupervisor } from './gateway/supervisor'
import { registerIpc } from './ipc'
import { installAppMenu } from './menu'
import { registerPetScheme, servePets } from './pets/protocol'
import { PetStore } from './pets/store'
import { SettingsStore } from './settings/store'
import { applyUiScale, applyVibrancy, createMainWindow } from './window'

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  const gateway = new GatewaySupervisor(() => settings.get().gateway)
  const pets = new PetStore(path.join(app.getPath('userData'), 'pets'))
  // Custom schemes must be declared before the app is ready.
  registerPetScheme()

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.agentos.desktop')
    app.on('browser-window-created', (_, win) => optimizer.watchWindowShortcuts(win))

    installLoopbackOriginRewrite()
    servePets(pets)
    registerIpc({ settings, gateway, pets })
    installAppMenu(settings)
    createMainWindow(windowOptions(settings.get()))
    mirrorSettingsToOs(settings)
    // The shell is only useful with a gateway behind it: bring it up (or
    // adopt a running one) without waiting for a click.
    void gateway.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createMainWindow(windowOptions(settings.get()))
    })
  })

  // macOS only: closing the last window keeps the app (and any managed
  // gateway) alive in the Dock; Cmd+Q is the way out.
  app.on('window-all-closed', () => {})

  // Never leave an orphaned gateway behind when the app quits, unless the
  // user asked to keep it running (Settings > General).
  let stopping = false
  app.on('before-quit', (event) => {
    if (stopping || gateway.current().pid === null) return
    if (!settings.get().general.stopGatewayOnQuit) return
    event.preventDefault()
    stopping = true
    void gateway.stop().finally(() => app.quit())
  })
}

function windowOptions(s: DesktopSettings): { reduceTransparency: boolean; uiScale: number } {
  return { reduceTransparency: s.appearance.reduceTransparency, uiScale: s.appearance.uiScale }
}

/**
 * Three settings are really window/OS state: the login item, window
 * vibrancy and the zoom factor. Apply them at boot and again on every change
 * so the file and what is on screen agree.
 */
function mirrorSettingsToOs(settings: SettingsStore): void {
  let last: DesktopSettings | null = null
  const apply = (next: DesktopSettings) => {
    if (next.general.openAtLogin !== last?.general.openAtLogin) {
      try {
        if (app.isPackaged || next.general.openAtLogin !== app.getLoginItemSettings().openAtLogin) {
          app.setLoginItemSettings({ openAtLogin: next.general.openAtLogin })
        }
      } catch {
        /* unsigned dev builds cannot register a login item; the pane reads back the truth */
      }
    }
    if (next.appearance.reduceTransparency !== last?.appearance.reduceTransparency) {
      applyVibrancy(next.appearance.reduceTransparency)
    }
    if (next.appearance.uiScale !== last?.appearance.uiScale) {
      applyUiScale(next.appearance.uiScale)
    }
    last = next
  }
  apply(settings.get())
  settings.subscribe(apply)
}

/**
 * The gateway's WebSocket guard admits loopback Origins or no Origin at all.
 * A renderer loaded from disk sends `Origin: file://` (and `null` for fetch),
 * which it rejects with close code 1008. Present the gateway's own origin on
 * every loopback request instead: the renderer is the local operator, the
 * same trust the browser console gets when the gateway serves it.
 */
function installLoopbackOriginRewrite(): void {
  const urls = ['http://127.0.0.1/*', 'ws://127.0.0.1/*', 'http://localhost/*', 'ws://localhost/*']
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    try {
      const target = new URL(details.url)
      const scheme = target.protocol === 'ws:' ? 'http:' : target.protocol
      requestHeaders.Origin = `${scheme}//${target.host}`
    } catch {
      /* leave headers untouched */
    }
    callback({ requestHeaders })
  })
}
