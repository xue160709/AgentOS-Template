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
import { AgentModeMenu } from './AgentModeMenu'
import { AppFileTreePane, type AppFileTreePaneHandle } from './AppFileTreePane'
import { AppWorkspaceSidePanel, type WorkspaceSidePanelTab } from './AppWorkspaceSidePanel'
import { ChatPage, type ChatPageHandle } from './chat/ChatPage'
import { DocsPage } from './DocsPage'
import { SettingsPage } from './setting/SettingsPage'
import { useWorkspaceAgentMode } from './useWorkspaceAgentMode'
import type { HomePluginRunItem } from '../desktop-types'

/** 右侧辅助抽屉开关与当前标签 / Auxiliary side panel open flag and active tab */
type SidePanelState = {
  open: boolean
  tab: WorkspaceSidePanelTab
}

/** `AppShellWorkspace` 的 props：标题、活动视图、聊天委托与侧栏联动 / Props wiring title, active view, chat callbacks, and drawer prefs */
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
  homeModeResetKey: number
  onCreateHomePluginCardThread: (projectId: string, initialPrompt: string) => string | void
  onEditHomePluginCard: (projectId: string, item: HomePluginRunItem) => void
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
  homeModeResetKey,
  onCreateHomePluginCardThread,
  onEditHomePluginCard,
  showProjectSkillsInSidebar,
  onShowProjectSkillsInSidebarChange,
}: AppShellWorkspaceProps) {
  // --- Derived chrome flags (settings hide header; home “surface” vs chat stream) / 派生框架标志（设置页隐藏顶栏；首页表面对话流）---

  const { t } = useI18n()
  const isSettingsChromeHidden = activeViewId === 'settings'
  const [sidePanel, setSidePanel] = useState<SidePanelState>(() => ({ open: false, tab: 'files' }))
  const filePaneRef = useRef<AppFileTreePaneHandle>(null)
  const agentMode = useWorkspaceAgentMode(activeProject)

  /** 与 ChatPage.showThreadView 一致：有消息或插件定制线程时视为对话流，否则为项目首页 / Mirrors ChatPage.showThreadView */
  const chatItems = activeThread?.chatState.items ?? []
  const hasThreadMessages = chatItems.length > 0
  const showConversationFlow =
    hasThreadMessages ||
    activeThread?.purpose === 'home-plugin-customization' ||
    activeThread?.purpose === 'home-plugin-card-customization' ||
    activeThread?.purpose === 'task-run'
  const showAgentModeToolbar = activeViewId === 'home' && !showConversationFlow

  // --- Close auxiliary drawer when navigating into settings / 进入设置路由时收起辅助抽屉 ---

  useEffect(() => {
    if (activeViewId === 'settings') setSidePanel((prev) => ({ ...prev, open: false }))
  }, [activeViewId])

  // --- Side panel: single-tab toggle (second click closes) / 侧栏：单标签切换（再点同按钮则关闭）---

  const toggleSidePanelTab = useCallback((tab: WorkspaceSidePanelTab) => {
    setSidePanel((prev) => {
      if (prev.open && prev.tab === tab) {
        return { ...prev, open: false }
      }
      return { open: true, tab }
    })
  }, [])

  const folderToolbarActive = sidePanel.open && sidePanel.tab === 'files'

  // --- Layout: title bar (hidden in settings), routed `<main>`, right drawer / 布局：标题栏（设置页隐藏）、路由主区、右侧抽屉 ---

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
            {showAgentModeToolbar ? <AgentModeMenu agent={agentMode} /> : null}
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
          {/* 三视图互斥：`hidden` 保留挂载以维持 Chat 内存态 / Mutually exclusive routes; `hidden` keeps Chat mounted */}
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
            agentModeEnabled={agentMode.enabled}
            todoEnabled={agentMode.todoEnabled}
            agentModeLoading={agentMode.loading}
            homeModeResetKey={homeModeResetKey}
            onCreateHomePluginCardThread={onCreateHomePluginCardThread}
            onEditHomePluginCard={onEditHomePluginCard}
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
          filePaneRef={filePaneRef}
          filesPane={<AppFileTreePane ref={filePaneRef} project={activeProject} isVisible={sidePanel.open && sidePanel.tab === 'files'} />}
        />
      </div>
    </div>
  )
}
