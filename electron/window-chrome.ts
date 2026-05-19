/**
 * 主窗口平台 chrome 配置：Windows 使用自绘顶栏 + 原生窗口控制覆盖区。
 * Main-window platform chrome options: Windows uses app-drawn titlebar + native controls overlay.
 */

import type { BrowserWindowConstructorOptions } from 'electron'

const MAIN_WINDOW_BACKGROUND_LIGHT = '#f9f9f9'
const MAIN_WINDOW_BACKGROUND_DARK = '#181818'
const WINDOWS_TITLEBAR_OVERLAY_HEIGHT = 40

export function getMainWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? MAIN_WINDOW_BACKGROUND_DARK : MAIN_WINDOW_BACKGROUND_LIGHT
}

export function getMainWindowChromeOptions(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean,
): Pick<BrowserWindowConstructorOptions, 'autoHideMenuBar' | 'titleBarOverlay' | 'titleBarStyle'> {
  if (platform !== 'win32') return {}

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: getMainWindowBackgroundColor(shouldUseDarkColors),
      symbolColor: shouldUseDarkColors ? '#f2f2f2' : '#1f1f1f',
      height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
    },
    autoHideMenuBar: true,
  }
}
