/**
 * Sandboxed Generative UI widget renderer for assistant messages.
 * Widgets live in an opaque-origin iframe and receive content through postMessage.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n/i18n'
import {
  buildWidgetSrcdoc,
  buildWidgetStyleBlock,
  readWidgetThemeVars,
  sanitizeWidgetFinal,
  sanitizeWidgetPreview,
} from './generative-ui'
import { copySvgAsPng, downloadSvgFile } from './clipboard'

type GenerativeWidgetProps = {
  widgetCode: string
  title?: string
  streaming: boolean
  showOverlay?: boolean
}

const MAX_WIDGET_HEIGHT = 1800
const STREAM_UPDATE_DELAY = 120
const EXTERNAL_SCRIPT_RE = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/
const widgetHeightCache = new Map<string, number>()

/** Interactive widget iframe with height cache and two-phase streaming/final rendering. */
export const GenerativeWidget = memo(function GenerativeWidget({
  widgetCode,
  title,
  streaming,
  showOverlay,
}: GenerativeWidgetProps) {
  const { t } = useI18n()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const debounceRef = useRef<number | null>(null)
  const lastSentRef = useRef('')
  const finalizedCodeRef = useRef('')
  const heightLockedRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [finalized, setFinalized] = useState(false)
  const [copyPngState, setCopyPngState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const [height, setHeight] = useState(() => widgetHeightCache.get(cacheKey(widgetCode)) ?? 96)
  const hasReceivedHeightRef = useRef(widgetHeightCache.has(cacheKey(widgetCode)))
  const hasExternalScript = useMemo(() => EXTERNAL_SCRIPT_RE.test(widgetCode), [widgetCode])

  const srcdoc = useMemo(() => {
    const vars = readWidgetThemeVars()
    return buildWidgetSrcdoc(buildWidgetStyleBlock(vars), false)
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data.type !== 'string') return
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return

      if (event.data.type === 'generative-ui:ready') {
        setReady(true)
        return
      }

      if (event.data.type === 'generative-ui:resize' && typeof event.data.height === 'number') {
        const nextHeight = Math.min(Math.max(80, event.data.height), MAX_WIDGET_HEIGHT)
        const key = cacheKey(widgetCode)
        if (heightLockedRef.current) {
          setHeight((current) => {
            const stableHeight = Math.max(current, nextHeight)
            widgetHeightCache.set(key, stableHeight)
            return stableHeight
          })
          return
        }

        widgetHeightCache.set(key, nextHeight)
        const iframe = iframeRef.current
        if (!hasReceivedHeightRef.current && iframe) {
          hasReceivedHeightRef.current = true
          iframe.style.transition = 'none'
          void iframe.offsetHeight
          setHeight(nextHeight)
          window.requestAnimationFrame(() => {
            iframe.style.transition = 'height 0.24s ease-out'
          })
          return
        }
        setHeight(nextHeight)
        return
      }

      if (event.data.type === 'generative-ui:link') {
        const href = String(event.data.href || '')
        if (href && !/^\s*(javascript|data)\s*:/i.test(href)) {
          if (window.desktop?.openExternal) {
            void window.desktop.openExternal(href)
          } else {
            window.open(href, '_blank', 'noopener,noreferrer')
          }
        }
        return
      }

      if (event.data.type === 'generative-ui:send-message') {
        const text = String(event.data.text || '').trim()
        if (text) {
          window.dispatchEvent(new CustomEvent('generative-ui:send-message', { detail: { text } }))
        }
        return
      }

      if (event.data.type === 'generative-ui:scripts-ready') {
        setFinalized(true)
        return
      }

      if (event.data.type === 'generative-ui:download-svg') {
        const svg = String(event.data.svg || '')
        if (svg.trim()) downloadSvgFile(svg, title || 'generative-widget')
        return
      }

      if (event.data.type === 'generative-ui:captured-svg') {
        const svg = String(event.data.svg || '')
        const action = String(event.data.action || '')
        if (action === 'copy-png') {
          if (!svg.trim()) {
            setTimedCopyPngState('failed', setCopyPngState)
            return
          }
          void copySvgAsPng(svg).then((ok) => {
            setTimedCopyPngState(ok ? 'copied' : 'failed', setCopyPngState)
          })
          return
        }
        if (svg.trim()) downloadSvgFile(svg, title || 'generative-widget')
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [title, widgetCode])

  useEffect(() => {
    if (!ready) return
    const iframeWindow = iframeRef.current?.contentWindow
    if (!iframeWindow) return
    const observer = new MutationObserver(() => {
      iframeWindow.postMessage(
        {
          type: 'generative-ui:theme',
          vars: readWidgetThemeVars(),
          prefersDark: false,
        },
        '*',
      )
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-window-effects'] })
    return () => observer.disconnect()
  }, [ready])

  useEffect(() => {
    if (!ready || !streaming) return
    const html = sanitizeWidgetPreview(widgetCode)
    if (html === lastSentRef.current) return
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      postWidgetMessage(iframeRef.current, {
        type: 'generative-ui:update',
        html,
      })
      lastSentRef.current = html
    }, STREAM_UPDATE_DELAY)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [ready, streaming, widgetCode])

  useEffect(() => {
    if (!ready || streaming) return
    if (finalizedCodeRef.current === widgetCode) return
    const html = sanitizeWidgetFinal(widgetCode)
    finalizedCodeRef.current = widgetCode
    lastSentRef.current = html
    heightLockedRef.current = true
    setFinalized(false)
    postWidgetMessage(iframeRef.current, {
      type: 'generative-ui:finalize',
      html,
    })
    window.setTimeout(() => {
      heightLockedRef.current = false
      if (!hasExternalScript) setFinalized(true)
    }, 420)
  }, [hasExternalScript, ready, streaming, widgetCode])

  const loadingOverlay = showOverlay || (!streaming && hasExternalScript && ready && !finalized)
  const requestSvgDownload = () => {
    postWidgetMessage(iframeRef.current, {
      type: 'generative-ui:capture-svg',
      action: 'download-svg',
    })
  }
  const requestPngCopy = () => {
    setCopyPngState('copying')
    const sent = postWidgetMessage(iframeRef.current, {
      type: 'generative-ui:capture-svg',
      action: 'copy-png',
    })
    if (!sent) setTimedCopyPngState('failed', setCopyPngState)
  }

  const copyPngLabel =
    copyPngState === 'copying'
      ? t('chat.generativeUiCopyingPng')
      : copyPngState === 'copied'
        ? t('chat.generativeUiCopiedPng')
        : copyPngState === 'failed'
          ? t('chat.copyFailed')
          : t('chat.generativeUiCopyPng')

  return (
    <section className="generative-widget" aria-label={title || t('chat.generativeUiAria')}>
      <iframe
        ref={iframeRef}
        className="generative-widget__iframe"
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        title={title || t('chat.generativeUiAria')}
        onLoad={() => setReady(true)}
        style={{ height, display: showCode ? 'none' : 'block' }}
      />
      {loadingOverlay ? (
        <div className="generative-widget__overlay" aria-hidden="true">
          <span />
        </div>
      ) : null}
      {showCode ? (
        <pre className="generative-widget__code">
          <code>{widgetCode}</code>
        </pre>
      ) : null}
      <div className="generative-widget__toolbar">
        <button type="button" onClick={() => setShowCode((value) => !value)}>
          {showCode ? t('chat.generativeUiHideCode') : t('chat.generativeUiShowCode')}
        </button>
        <button type="button" onClick={requestSvgDownload}>
          {t('chat.generativeUiDownloadSvg')}
        </button>
        <button type="button" onClick={requestPngCopy} disabled={copyPngState === 'copying'}>
          {copyPngLabel}
        </button>
      </div>
    </section>
  )
})

function cacheKey(code: string): string {
  return code.slice(0, 220)
}

function postWidgetMessage(iframe: HTMLIFrameElement | null, message: Record<string, unknown>): boolean {
  const target = iframe?.contentWindow
  if (!target) return false
  target.postMessage(message, '*')
  return true
}

function setTimedCopyPngState(
  state: 'copied' | 'failed',
  setState: (value: 'idle' | 'copying' | 'copied' | 'failed') => void,
) {
  setState(state)
  window.setTimeout(() => setState('idle'), 1800)
}
