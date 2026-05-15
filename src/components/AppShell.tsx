import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId } from './types'
import { ChatPage, type ChatPageHandle } from './ChatPage'
import { DocsPage } from './DocsPage'
import { SettingsPage } from './SettingsPage'

const SIDEBAR_WIDTH_STORAGE_KEY = 'CodeX-UI-Template-sidebar-width-px'
const SIDEBAR_MAX_RATIO = 0.3

const VIEW_HEADINGS: Record<AppViewId, string> = {
  home: 'Codex Chatbot',
  docs: '文档',
  settings: '设置',
}

const NAV_LABELS: Record<'home' | 'docs', string> = {
  home: '聊天',
  docs: '文档',
}

const NAV_VIEW_IDS = ['home', 'docs'] as const

function normalizeViewId(value: string): AppViewId {
  return value === 'docs' || value === 'settings' ? value : 'home'
}

function viewFromLocation(): AppViewId {
  return normalizeViewId(window.location.hash.replace(/^#/, ''))
}

export function AppShell() {
  const [activeViewId, setActiveViewId] = useState<AppViewId>(() => viewFromLocation())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [headerStatus, setHeaderStatus] = useState('Claude Agent')

  const chatRef = useRef<ChatPageHandle>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const appSidebarRef = useRef<HTMLElement>(null)
  const sidebarSplitterRef = useRef<HTMLDivElement>(null)
  const sidebarResizeActive = useRef(false)

  const readCssPxVar = useCallback((name: string, fallback: number): number => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : fallback
  }, [])

  const clampSidebarWidth = useCallback(
    (px: number): number => {
      const body = appBodyRef.current
      if (!body) return px
      const min = readCssPxVar('--width-sidebar-min', 160)
      const bodyW = body.getBoundingClientRect().width
      const max = Math.max(min, bodyW * SIDEBAR_MAX_RATIO)
      return Math.min(max, Math.max(min, px))
    },
    [readCssPxVar],
  )

  const applySidebarWidthPx = useCallback(
    (px: number) => {
      const body = appBodyRef.current
      if (!body) return
      const clamped = clampSidebarWidth(px)
      body.style.setProperty('--sidebar-user-width', `${clamped}px`)
      try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clamped)))
      } catch {
        /* ignore */
      }
    },
    [clampSidebarWidth],
  )

  const handleWindowResize = useCallback(() => {
    if (sidebarCollapsed || !appBodyRef.current) return
    const width = Number.parseFloat(
      getComputedStyle(appBodyRef.current).getPropertyValue('--sidebar-current-width').trim(),
    )
    if (Number.isFinite(width)) applySidebarWidthPx(width)
  }, [applySidebarWidthPx, sidebarCollapsed])

  const syncHistoryButtons = useCallback(() => {
    const nav = (window as unknown as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation
    if (nav && typeof nav.canGoBack === 'boolean') {
      setCanBack(nav.canGoBack)
      setCanForward(!!nav.canGoForward)
      return
    }
    setCanBack(window.history.length > 1)
    setCanForward(false)
  }, [])

  useEffect(() => {
    const onHash = () => {
      setActiveViewId(viewFromLocation())
      syncHistoryButtons()
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', syncHistoryButtons)
    window.addEventListener('resize', handleWindowResize)
    onHash()
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', syncHistoryButtons)
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [handleWindowResize, syncHistoryButtons])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      if (!raw) return
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) applySidebarWidthPx(n)
    } catch {
      /* ignore */
    }
  }, [applySidebarWidthPx])

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (sidebarCollapsed) return

    event.preventDefault()
    sidebarResizeActive.current = true
    shellRef.current?.classList.add('is-resizing-sidebar')
    const splitter = sidebarSplitterRef.current
    const sidebar = appSidebarRef.current
    const body = appBodyRef.current
    if (!splitter || !sidebar || !body) return

    const startX = event.clientX
    const startWidth = sidebar.getBoundingClientRect().width || readCssPxVar('--width-sidebar-min', 240)

    const onMove = (moveEvent: PointerEvent) => {
      if (!sidebarResizeActive.current) return
      applySidebarWidthPx(startWidth + moveEvent.clientX - startX)
    }
    const onUp = () => {
      sidebarResizeActive.current = false
      shellRef.current?.classList.remove('is-resizing-sidebar')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    try {
      splitter.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  const workspaceTitle = VIEW_HEADINGS[activeViewId]

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
      id="app-shell"
      ref={shellRef}
    >
      <div className="app-body" ref={appBodyRef}>
        <div className="app-chrome-toolbar no-drag" aria-label="窗口导航">
          <button
            type="button"
            className="btn btn-toolbar"
            id="btn-toggle-sidebar"
            title="切换侧栏"
            aria-label="切换侧栏"
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            <IconInline name="sidebar" />
          </button>
          <button
            type="button"
            className="btn btn-toolbar"
            id="btn-back"
            title="后退"
            aria-label="后退"
            disabled={!canBack}
            onClick={() => window.history.back()}
          >
            <IconInline name="back" />
          </button>
          <button
            type="button"
            className="btn btn-toolbar"
            id="btn-forward"
            title="前进"
            aria-label="前进"
            disabled={!canForward}
            onClick={() => window.history.forward()}
          >
            <IconInline name="forward" />
          </button>
        </div>
        <aside className="app-sidebar" aria-label="侧栏导航" ref={appSidebarRef}>
          <div className="app-sidebar-scroll">
            <div className="app-sidebar-inner">
              <div className="app-sidebar-section-label">工作区</div>
              {NAV_VIEW_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`app-nav-item${activeViewId === id ? ' is-active' : ''}`}
                  data-view={id}
                  onClick={() => {
                    window.location.hash = id === 'home' ? '' : id
                  }}
                >
                  {NAV_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
          <footer className="app-sidebar-footer">
            <button
              type="button"
              className={`btn btn-toolbar${activeViewId === 'settings' ? ' is-active' : ''}`}
              id="btn-footer-settings"
              title="设置"
              aria-label="设置"
              onClick={() => {
                window.location.hash = 'settings'
              }}
            >
              <IconInline name="settings" />
            </button>
            <span className="user-select-none text-token-secondary">CodeX-UI-Template</span>
          </footer>
        </aside>
        <div
          className="app-sidebar-splitter no-drag"
          id="app-sidebar-splitter"
          ref={sidebarSplitterRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          onPointerDown={handleSidebarPointerDown}
        />
        <div className="app-workspace">
          <header className="app-workspace-header" role="banner">
            <span className="app-workspace-title no-drag" id="workspace-title">
              {workspaceTitle}
            </span>
            <div className="app-workspace-drag-gap draggable" aria-hidden="true" />
            <div className="app-workspace-actions no-drag">
              <button
                type="button"
                className="btn btn-ghost"
                id="btn-new-thread"
                onClick={() => void chatRef.current?.startNewThread()}
              >
                <IconInline name="plus" />
                <span>新对话</span>
              </button>
              <span className="status-pill user-select-none" id="ipc-status" title="Claude Agent 状态">
                {headerStatus}
              </span>
            </div>
          </header>
          <main className="app-main" role="main">
            <ChatPage ref={chatRef} hidden={activeViewId !== 'home'} onStatusChange={setHeaderStatus} />
            <DocsPage hidden={activeViewId !== 'docs'} />
            <SettingsPage hidden={activeViewId !== 'settings'} />
          </main>
        </div>
      </div>
    </div>
  )
}
