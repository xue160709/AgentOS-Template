import { type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId, SettingsCategoryId } from './types'
import { NAV_LABELS, NAV_VIEW_IDS, SETTINGS_SIDEBAR_NAV } from './app-shell-constants.ts'

type AppShellSidebarProps = {
  activeViewId: AppViewId
  settingsCategory: SettingsCategoryId
  canBack: boolean
  canForward: boolean
  onToggleCollapsed: () => void
  sidebarRef: RefObject<HTMLElement | null>
  splitterRef: RefObject<HTMLDivElement | null>
  onSplitterPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function AppShellSidebar({
  activeViewId,
  settingsCategory,
  canBack,
  canForward,
  onToggleCollapsed,
  sidebarRef,
  splitterRef,
  onSplitterPointerDown,
}: AppShellSidebarProps) {
  const isSettingsSidebar = activeViewId === 'settings'

  const goLeaveSettings = () => {
    window.location.hash = ''
  }

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
      <aside
        className={`app-sidebar${isSettingsSidebar ? ' is-settings-mode' : ''}`}
        aria-label={isSettingsSidebar ? '设置导航' : '侧栏导航'}
        ref={sidebarRef}
      >
        <div className="app-sidebar-scroll">
          <div className="app-sidebar-inner">
            {isSettingsSidebar ? (
              <>
                <button type="button" className="app-settings-back-btn" id="btn-settings-back-app" onClick={goLeaveSettings}>
                  <IconInline name="back" />
                  <span>返回应用</span>
                </button>
                <div className="app-sidebar-section-label">设置</div>
                {SETTINGS_SIDEBAR_NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    title={item.disabled ? '尚未实现' : undefined}
                    className={`app-settings-nav-item${settingsCategory === item.id ? ' is-active' : ''}`}
                    data-settings-category={item.id}
                    onClick={() => {
                      if (item.disabled) {
                        return
                      }
                      window.location.hash = `settings/${item.id}`
                    }}
                  >
                    <IconInline name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
        {!isSettingsSidebar && (
          <footer className="app-sidebar-footer">           
              <button
                type="button"
                className="btn btn-toolbar"
                id="btn-footer-settings"
                title="设置"
                aria-label="设置"
                onClick={() => {
                  window.location.hash = 'settings/general'
                }}
              >
                <IconInline name="settings" />
              </button>
          </footer>
        )}
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
