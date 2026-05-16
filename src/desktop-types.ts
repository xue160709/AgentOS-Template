/** 桌面端（Electron）偏好，由主进程持久化到 userData */
export type DesktopPreferences = {
  closeToTray: boolean
  openAtLogin: boolean
}

/** 托盘菜单触发的动作（与主进程 IPC 载荷一致） */
export type TrayMenuAction = 'new-thread' | 'open-project'
