import { type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId, ChatState, SettingsCategoryId, WorkspaceProject, WorkspaceThread } from './types'
import { ChatPage, type ChatPageHandle } from './ChatPage'
import { DocsPage } from './DocsPage'
import { SettingsPage } from './SettingsPage'

type AppShellWorkspaceProps = {
  workspaceTitle: string
  headerStatus: string
  activeViewId: AppViewId
  settingsCategory: SettingsCategoryId
  activeProject: WorkspaceProject
  activeThread: WorkspaceThread
  projects: WorkspaceProject[]
  chatRef: RefObject<ChatPageHandle | null>
  onStatusChange: (text: string) => void
  onNewThread: () => void
  onSelectProject: (projectId: string) => void
  onCreateProject: (mode: 'scratch' | 'existing') => void
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
}

export function AppShellWorkspace({
  workspaceTitle,
  headerStatus: _headerStatus,
  activeViewId,
  settingsCategory,
  activeProject,
  activeThread,
  projects,
  chatRef,
  onStatusChange,
  onNewThread,
  onSelectProject,
  onCreateProject,
  onThreadChatStateChange,
  onThreadPromptSubmit,
}: AppShellWorkspaceProps) {
  const isSettingsChromeHidden = activeViewId === 'settings'

  return (
    <div className="app-workspace">
      {isSettingsChromeHidden ? (
        <div className="app-workspace-top-drag draggable" aria-hidden />
      ) : (
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
          </div>
        </header>
      )}
      <main className="app-main" role="main">
        <ChatPage
          ref={chatRef}
          hidden={activeViewId !== 'home'}
          activeProject={activeProject}
          activeThread={activeThread}
          projects={projects}
          onStatusChange={onStatusChange}
          onNewThread={onNewThread}
          onSelectProject={onSelectProject}
          onCreateProject={onCreateProject}
          onThreadChatStateChange={onThreadChatStateChange}
          onThreadPromptSubmit={onThreadPromptSubmit}
        />
        <DocsPage hidden={activeViewId !== 'docs'} />
        <SettingsPage hidden={activeViewId !== 'settings'} settingsCategory={settingsCategory} />
      </main>
    </div>
  )
}
