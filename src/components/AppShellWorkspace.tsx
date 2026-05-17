/**
 * 中央工作区：聊天页、文档、设置与侧栏抽屉协同。
 * Center pane coordinating Chat/Docs/Settings routes plus auxiliary drawers.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type {
  AppViewId,
  ChatState,
  SettingsCategoryId,
  ThreadRunState,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { AgentModeControls } from './AgentModeControls'
import { AgentModeMenu } from './AgentModeMenu'
import { AppFileTreePane, type AppFileTreePaneHandle } from './AppFileTreePane'
import { AppWorkspaceSidePanel, type WorkspaceSidePanelTab } from './AppWorkspaceSidePanel'
import { ChatPage, type ChatPageHandle } from './chat/ChatPage'
import { DocsPage } from './DocsPage'
import { SettingsPage } from './setting/SettingsPage'
import { useWorkspaceAgentMode } from './useWorkspaceAgentMode'

type SidePanelState = {
  open: boolean
  tab: WorkspaceSidePanelTab
}

type AppShellWorkspaceProps = {
  workspaceTitle: string
  headerStatus: string
  activeViewId: AppViewId
  settingsCategory: SettingsCategoryId
  activeProject: WorkspaceProject
  activeThread: WorkspaceThread | undefined
  threads: WorkspaceThread[]
  projects: WorkspaceProject[]
  threadRunStates: Record<string, ThreadRunState>
  chatRef: RefObject<ChatPageHandle | null>
  onStatusChange: (text: string) => void
  onNewThread: (projectId?: string) => string | void
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
  onThreadRunStateChange: (threadId: string, state: ThreadRunState | null) => void
  onCustomizeHomePlugin: (projectId: string) => void
  showProjectSkillsInSidebar: boolean
  onShowProjectSkillsInSidebarChange: (enabled: boolean) => void
}

/** Shell 主体渲染路由器 / Shell workspace router mounting routed surfaces */
export function AppShellWorkspace({
  workspaceTitle,
  headerStatus: _headerStatus,
  activeViewId,
  settingsCategory,
  activeProject,
  activeThread,
  threads,
  projects,
  threadRunStates,
  chatRef,
  onStatusChange,
  onNewThread,
  onThreadChatStateChange,
  onThreadPromptSubmit,
  onThreadRunStateChange,
  onCustomizeHomePlugin,
  showProjectSkillsInSidebar,
  onShowProjectSkillsInSidebarChange,
}: AppShellWorkspaceProps) {
  const { t } = useI18n()
  const isSettingsChromeHidden = activeViewId === 'settings'
  const [sidePanel, setSidePanel] = useState<SidePanelState>(() => ({ open: false, tab: 'files' }))
  const filePaneRef = useRef<AppFileTreePaneHandle>(null)
  const agentMode = useWorkspaceAgentMode(activeProject)

  useEffect(() => {
    if (activeViewId === 'settings') setSidePanel((prev) => ({ ...prev, open: false }))
  }, [activeViewId])

  useEffect(() => {
    if (!agentMode.enabled && sidePanel.tab === 'agent') {
      setSidePanel((prev) => ({ ...prev, tab: 'files' }))
    }
  }, [agentMode.enabled, sidePanel.tab])

  const toggleSidePanelTab = useCallback((tab: WorkspaceSidePanelTab) => {
    setSidePanel((prev) => {
      if (prev.open && prev.tab === tab) {
        return { ...prev, open: false }
      }
      return { open: true, tab }
    })
  }, [])

  const openSidePanelWithTab = useCallback((tab: WorkspaceSidePanelTab) => {
    setSidePanel({ open: true, tab })
  }, [])

  const folderToolbarActive = sidePanel.open && sidePanel.tab === 'files'

  return (
    <div className="app-workspace">
      {isSettingsChromeHidden ? (
        <div className="app-workspace-top-drag draggable" aria-hidden />
      ) : (
        <header className="app-workspace-header" role="banner">
          <span className="app-workspace-title no-drag" id="workspace-title" title={workspaceTitle}>
            {workspaceTitle}
          </span>
          <div className="app-workspace-drag-gap draggable" aria-hidden="true" />
          <div className="app-workspace-actions no-drag">
            <AgentModeMenu
              agent={agentMode}
              sidePanelOpen={sidePanel.open}
              sidePanelTab={sidePanel.tab}
              onToggleSidePanelTab={toggleSidePanelTab}
              onAgentEnabledFromPopover={() => openSidePanelWithTab('agent')}
            />
            <button
              type="button"
              className={`btn btn-toolbar${folderToolbarActive ? ' is-active' : ''}`}
              id="btn-toggle-file-panel"
              title={t('workspace.fileTree')}
              aria-label={t('workspace.toggleFilePanel')}
              aria-controls="app-file-panel"
              aria-expanded={folderToolbarActive}
              onClick={() => toggleSidePanelTab('files')}
            >
              <IconInline name="folder" />
            </button>
          </div>
        </header>
      )}
      <div className="app-workspace-content">
        <main className="app-main" role="main">
          <ChatPage
            ref={chatRef}
            hidden={activeViewId !== 'home'}
            activeProject={activeProject}
            activeThread={activeThread}
            threads={threads}
            projects={projects}
            threadRunStates={threadRunStates}
            onStatusChange={onStatusChange}
            onNewThread={onNewThread}
            onThreadChatStateChange={onThreadChatStateChange}
            onThreadPromptSubmit={onThreadPromptSubmit}
            onThreadRunStateChange={onThreadRunStateChange}
            onCustomizeHome={onCustomizeHomePlugin}
          />
          <DocsPage hidden={activeViewId !== 'docs'} />
          <SettingsPage
            hidden={activeViewId !== 'settings'}
            settingsCategory={settingsCategory}
            activeProject={activeProject}
            showProjectSkillsInSidebar={showProjectSkillsInSidebar}
            onShowProjectSkillsInSidebarChange={onShowProjectSkillsInSidebarChange}
          />
        </main>
        <AppWorkspaceSidePanel
          open={sidePanel.open}
          activeTab={sidePanel.tab}
          onActiveTabChange={(tab) => setSidePanel((prev) => ({ ...prev, open: true, tab }))}
          onClose={() => setSidePanel((prev) => ({ ...prev, open: false }))}
          showAgentTab={agentMode.enabled}
          filePaneRef={filePaneRef}
          filesPane={<AppFileTreePane ref={filePaneRef} project={activeProject} isVisible={sidePanel.open && sidePanel.tab === 'files'} />}
          agentPane={
            <div className="app-file-panel-body agent-mode-panel-body">
              <AgentModeControls
                variant="embedded"
                enabled={agentMode.enabled}
                todoEnabled={agentMode.todoEnabled}
                loading={agentMode.loading}
                onAgentSwitchChange={(checked) => {
                  if (checked) void agentMode.enableAgentMode()
                  else void agentMode.updateAgentModeState({ enabled: false })
                }}
                onTodoSwitchChange={(checked) => {
                  void agentMode.updateAgentModeState({ todoEnabled: checked })
                }}
                onCustomizeHome={() => onCustomizeHomePlugin(activeProject.id)}
              />
            </div>
          }
        />
      </div>
    </div>
  )
}
