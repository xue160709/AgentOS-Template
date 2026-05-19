/**
 * 系统菜单栏：生产环境不含开发项；开发环境追加 Develop 子菜单。
 * Application menu: production omits dev items; development adds a Develop submenu.
 */

import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export type InstallApplicationMenuOptions = {
  isDev: boolean
}

export function installApplicationMenu(options: InstallApplicationMenuOptions): void {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null)
    return
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(options.isDev)))
}

function buildApplicationMenuTemplate(isDev: boolean): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'File',
    submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' as const },
            { role: 'delete' as const },
            { role: 'selectAll' as const },
          ]
        : [
            { role: 'delete' as const },
            { type: 'separator' as const },
            { role: 'selectAll' as const },
          ]),
    ],
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  })

  if (isDev) {
    template.push({
      label: 'Develop',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    })
  }

  if (isMac) {
    template.push({ role: 'windowMenu' })
  } else {
    template.push({
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    })
  }

  return template
}
