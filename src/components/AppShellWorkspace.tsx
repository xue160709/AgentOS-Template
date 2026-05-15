import { type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId } from './types'
import { ChatPage, type ChatPageHandle } from './ChatPage'
import { DocsPage } from './DocsPage'
import { SettingsPage } from './SettingsPage'

type AppShellWorkspaceProps = {
  workspaceTitle: string
  headerStatus: string
  activeViewId: AppViewId
  chatRef: RefObject<ChatPageHandle | null>
  onStatusChange: (text: string) => void
  onNewThread: () => void
}

export function AppShellWorkspace({
  workspaceTitle,
  headerStatus,
  activeViewId,
  chatRef,
  onStatusChange,
  onNewThread,
}: AppShellWorkspaceProps) {
  return (
    <div className="app-workspace">
      <header className="app-workspace-header" role="banner">
        <span className="app-workspace-title no-drag" id="workspace-title">
          {workspaceTitle}
        </span>
        <div className="app-workspace-drag-gap draggable" aria-hidden="true" />
        <div className="app-workspace-actions no-drag">
          <button type="button" className="btn btn-ghost" id="btn-new-thread" onClick={onNewThread}>
            <IconInline name="plus" />
            <span>新对话</span>
          </button>
          {/* <span className="status-pill user-select-none" id="ipc-status" title="Claude Agent 状态">
            {headerStatus}
          </span> */}
        </div>
      </header>
      <main className="app-main" role="main">
        <ChatPage ref={chatRef} hidden={activeViewId !== 'home'} onStatusChange={onStatusChange} />
        <DocsPage hidden={activeViewId !== 'docs'} />
        <SettingsPage hidden={activeViewId !== 'settings'} />
      </main>
    </div>
  )
}
