import { type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId } from './types'
import { NAV_LABELS, NAV_VIEW_IDS } from './app-shell-constants'

type AppShellSidebarProps = {
  activeViewId: AppViewId
  canBack: boolean
  canForward: boolean
  onToggleCollapsed: () => void
  sidebarRef: RefObject<HTMLElement | null>
  splitterRef: RefObject<HTMLDivElement | null>
  onSplitterPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function AppShellSidebar({
  activeViewId,
  canBack,
  canForward,
  onToggleCollapsed,
  sidebarRef,
  splitterRef,
  onSplitterPointerDown,
}: AppShellSidebarProps) {
  return (
    <>
      <div className="app-chrome-toolbar no-drag" aria-label="窗口导航">
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-toggle-sidebar"
          title="切换侧栏"
          aria-label="切换侧栏"
          onClick={onToggleCollapsed}
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
      <aside className="app-sidebar" aria-label="侧栏导航" ref={sidebarRef}>
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
        ref={splitterRef}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        onPointerDown={onSplitterPointerDown}
      />
    </>
  )
}
