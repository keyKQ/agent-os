import { BrowserWindow, nativeTheme, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'

/** Matches --background in renderer/src/theme/palettes.ts so the first paint
 *  before React mounts is not a white flash in dark mode. */
const BACKGROUND = { dark: '#060608', light: '#f4f5ee' }

export function createMainWindow(opts: { reduceTransparency?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    // Full-height translucent sidebar like Finder/Notes: the window blurs the
    // desktop behind it and the renderer keeps the sidebar column
    // semi-transparent (see tokens.css .mac-sidebar) while content stays opaque.
    // "Reduce transparency" in Settings turns the effect off (applyVibrancy).
    vibrancy: opts.reduceTransparency ? undefined : 'sidebar',
    visualEffectState: 'active',
    // Native traffic lights sit inside the sidebar's top padding (Sidebar.tsx).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      // .cjs on purpose: see the preload section of electron.vite.config.ts.
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the default browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Mirror the "Reduce transparency" setting onto every open window. */
export function applyVibrancy(reduceTransparency: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setVibrancy(reduceTransparency ? null : 'sidebar')
  }
}
