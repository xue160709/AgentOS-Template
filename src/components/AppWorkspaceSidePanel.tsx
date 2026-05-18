/**
 * 右侧抽屉：文件树。
 * Auxiliary drawer hosting the project file tree.
 */

import { useEffect, type ReactNode, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { AppFileTreePaneHandle } from './AppFileTreePane'

/** 侧栏 Tab / Drawer tab identifiers */
export type WorkspaceSidePanelTab = 'files'

type AppWorkspaceSidePanelProps = {
  open: boolean
  activeTab: WorkspaceSidePanelTab
  onActiveTabChange: (tab: WorkspaceSidePanelTab) => void
  onClose: () => void
  filePaneRef: RefObject<AppFileTreePaneHandle | null>
  filesPane: ReactNode
}

/** 右侧抽屉布局与 Tab 头 / Drawer chrome + segmented tabs */
export function AppWorkspaceSidePanel({
  open,
  activeTab,
  onActiveTabChange: _onActiveTabChange,
  onClose,
  filePaneRef,
  filesPane,
}: AppWorkspaceSidePanelProps) {
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  return (
    <aside
      className={`app-file-panel app-workspace-side-panel${open ? ' is-open' : ''}`}
      id="app-file-panel"
      aria-label={t('workspace.sidePanelAria')}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <div className="app-file-panel-header">
        <div className="app-file-panel-heading">
          <IconInline name="files" />
          <span>{t('filePanel.heading')}</span>
        </div>
        <div className="app-file-panel-actions">
          <button
            type="button"
            className="btn btn-toolbar"
            title={t('filePanel.refreshTitle')}
            aria-label={t('filePanel.refreshAria')}
            disabled={!open}
            onClick={() => filePaneRef.current?.refresh()}
          >
            <IconInline name="refresh" />
          </button>
          <button type="button" className="btn btn-toolbar" title={t('filePanel.closeTitle')} aria-label={t('filePanel.closeAria')} onClick={onClose}>
            <IconInline name="x" />
          </button>
        </div>
      </div>

      <div className="app-workspace-side-panel-panes">
        <div
          id="workspace-side-panel-files"
          role="tabpanel"
          className="app-workspace-side-panel-pane"
          hidden={activeTab !== 'files'}
        >
          {filesPane}
        </div>
      </div>
    </aside>
  )
}
