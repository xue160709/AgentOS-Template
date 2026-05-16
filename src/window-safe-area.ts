/**
 * Electron `Window Controls Overlay` 安全区内边距计算与应用。
 * Compute CSSVariables padding WCO/inset traffic-light safe areas for framed windows.
 */

export type SafeArea = {
  left: number
  right: number
  /** macOS 交通灯预留顶部 / Top inset reserved for macOS traffic lights with hiddenInset */
  top: number
}

declare global {
  interface Navigator {
    windowControlsOverlay?: {
      visible: boolean
      getTitlebarAreaRect(): DOMRect
    }
  }
}

function platformFromBridge(): NodeJS.Platform | undefined {
  return typeof window !== 'undefined' ? window.desktop?.platform : undefined
}

/** 读取当前窗口控件覆盖几何或平台启发值 / Read WCO geometry or platform fallbacks */
export function getWindowControlsSafeArea(): SafeArea {
  if (typeof navigator !== 'undefined') {
    const overlay = navigator.windowControlsOverlay
    if (overlay?.visible) {
      const rect = overlay.getTitlebarAreaRect()
      return {
        left: Math.max(0, Math.round(rect.x)),
        right: Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width))),
        top: Math.max(0, Math.round(rect.y + rect.height)),
      }
    }
  }

  const platform = platformFromBridge()
  if (platform === 'darwin') {
    return { left: 76, right: 0, top: 34 }
  }
  if (platform === 'win32') {
    return { left: 0, right: 0, top: 0 }
  }
  if (platform === 'linux') {
    return { left: 0, right: 120, top: 0 }
  }

  return { left: 0, right: 0, top: 0 }
}

/** 将安全区写入 `:root` CSS 变量 / Mirror safe-area values onto document root */
export function applySafeAreaToDocument(area: SafeArea): void {
  document.documentElement.style.setProperty('--spacing-token-safe-header-left', `${area.left}px`)
  document.documentElement.style.setProperty('--spacing-token-safe-header-right', `${area.right}px`)
  document.documentElement.style.setProperty('--spacing-token-safe-header-top', `${area.top}px`)
}

/** 监听 resize/WCO geometrychange 并回调 / Subscribe to resize + geometrychange */
export function installWindowSafeAreaListeners(onChange: (area: SafeArea) => void): () => void {
  const emit = () => onChange(getWindowControlsSafeArea())

  emit()
  window.addEventListener('resize', emit)

  const overlay = navigator.windowControlsOverlay
  const overlayEvents = overlay as unknown as EventTarget | null
  if (overlayEvents && 'addEventListener' in overlayEvents) {
    overlayEvents.addEventListener('geometrychange', emit)
    return () => {
      window.removeEventListener('resize', emit)
      overlayEvents.removeEventListener('geometrychange', emit)
    }
  }

  return () => {
    window.removeEventListener('resize', emit)
  }
}
