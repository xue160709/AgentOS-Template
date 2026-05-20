/**
 * React 渲染入口：挂载 AppShell、启用窗口安全区监听。
 * React bootstrap: mount AppShell and subscribe to window safe-area updates.
 */

import './style.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell'
import { I18nProvider } from './i18n/i18n'
import { applySafeAreaToDocument, installWindowSafeAreaListeners } from './window-safe-area'

const windowEffects = window.desktop?.windowEffects

if (windowEffects?.macVibrancy) {
  document.documentElement.dataset.windowEffects = 'mac-vibrancy'
}

if (windowEffects?.windowsTitlebarOverlay) {
  document.documentElement.dataset.windowsTitlebarOverlay = 'true'
}

const appRoot = document.querySelector<HTMLDivElement>('#app')
if (!appRoot) throw new Error('Missing #app root element.')

createRoot(appRoot).render(
  <StrictMode>
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  </StrictMode>,
)

installWindowSafeAreaListeners((area) => {
  applySafeAreaToDocument(area)
})

installExternalLinkHandler()

function installExternalLinkHandler() {
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]')
    if (!anchor) return

    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return

    event.preventDefault()
    event.stopPropagation()

    if (window.desktop?.openExternal) {
      void window.desktop.openExternal(href)
      return
    }

    window.open(href, '_blank', 'noopener,noreferrer')
  })
}
