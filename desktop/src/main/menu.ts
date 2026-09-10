import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { requestOpenSettings } from './ipc/app'

const REPO_URL = 'https://github.com/use-agent-os/agent-os'

/**
 * Standard macOS menu bar. "Settings…" sits where every Mac app keeps it
 * (app menu, ⌘,) and opens the renderer's Settings window over IPC.
 */
export function installAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => requestOpenSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'AgentOS on GitHub', click: () => void shell.openExternal(REPO_URL) },
        {
          label: 'Report an Issue…',
          click: () => void shell.openExternal(`${REPO_URL}/issues/new`),
        },
        { type: 'separator' },
        { label: `AgentOS ${app.getVersion()}`, enabled: false },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
