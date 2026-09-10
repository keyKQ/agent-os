import { app, BrowserWindow, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import path from 'node:path'
import { GatewaySupervisor } from './gateway/supervisor'
import { registerIpc } from './ipc'
import { installAppMenu } from './menu'
import { SettingsStore } from './settings/store'
import { createMainWindow } from './window'

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
  const gateway = new GatewaySupervisor(() => settings.get().gateway)

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
    registerIpc({ settings, gateway })
    installAppMenu()
    createMainWindow()
    // The shell is only useful with a gateway behind it: bring it up (or
    // adopt a running one) without waiting for a click.
    void gateway.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // macOS only: closing the last window keeps the app (and any managed
  // gateway) alive in the Dock; Cmd+Q is the way out.
  app.on('window-all-closed', () => {})

  // Never leave an orphaned gateway behind when the app quits.
  let stopping = false
  app.on('before-quit', (event) => {
    if (stopping || gateway.current().pid === null) return
    event.preventDefault()
    stopping = true
    void gateway.stop().finally(() => app.quit())
  })
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
