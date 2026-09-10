import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/** Standard macOS menu bar. App-specific items get added here as features land. */
export function installAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: `AgentOS ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
