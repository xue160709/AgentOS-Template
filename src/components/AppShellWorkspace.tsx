/**
 * 中央工作区：聊天页、文档、设置与侧栏抽屉协同。
 * Center pane coordinating Chat/Docs/Settings routes plus auxiliary drawers.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { AgentContextSlashItem, AgentKnowledgeSearchItem, ProjectFileSearchItem } from '../claude-chat-types'
import type {
  AgentSettingsPanelId,
  AppSearchScope,
  AppViewId,
  ChatState,
  FileTreeNode,
  ProjectSkillRunRequest,
  SettingsCategoryId,
  ThreadRunState,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { AgentModeMenu } from './AgentModeMenu'
import { AppFileTreePane, type AppFileTreePaneHandle } from './AppFileTreePane'
import { AppSearchModal } from './AppSearchModal'
import { AppWorkspaceSidePanel, type WorkspaceSidePanelTab } from './AppWorkspaceSidePanel'
import { ChatPage, type ChatPageHandle } from './chat/ChatPage'
import { DocsPage } from './DocsPage'
import { ProjectFilePreviewOverlay, type ProjectFilePreviewOverlayState } from './ProjectFilePreviewOverlay'
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
  projectOrderIds: readonly string[]
  threadRunStates: Record<string, ThreadRunState>
  chatRef: RefObject<ChatPageHandle | null>
  onStatusChange: (text: string) => void
  onNewThread: (projectId?: string) => string | void
  onCreateProject: (mode: 'scratch' | 'existing') => void | Promise<void>
  onSelectProject: (projectId: string) => void
  onSelectThread: (threadId: string) => void
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
  onThreadRunStateChange: (threadId: string, state: ThreadRunState | null) => void
  homeModeResetKey: number
  onCreateHomePluginCardThread: (projectId: string, initialPrompt: string) => string | void
  onEditHomePluginCard: (projectId: string, item: HomePluginRunItem) => void
  hiddenSkillPaths: string[]
  projectSkills: AgentContextSlashItem[]
  onRunProjectSkill: (projectId: string, skill: ProjectSkillRunRequest) => void
  onStopProjectSkillRun: (projectId: string, skillPath: string) => void
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
  projectOrderIds,
  threadRunStates,
  chatRef,
  onStatusChange,
  onNewThread,
  onCreateProject,
  onSelectProject,
  onSelectThread,
  onThreadChatStateChange,
  onThreadPromptSubmit,
  onThreadRunStateChange,
  homeModeResetKey,
  onCreateHomePluginCardThread,
  onEditHomePluginCard,
  hiddenSkillPaths,
  projectSkills,
  onRunProjectSkill,
  onStopProjectSkillRun,
  showProjectSkillsInSidebar,
  onShowProjectSkillsInSidebarChange,
}: AppShellWorkspaceProps) {
  // --- Derived chrome flags (settings hide header; home “surface” vs chat stream) / 派生框架标志（设置页隐藏顶栏；首页表面对话流）---

  const { t } = useI18n()
  const isSettingsChromeHidden = activeViewId === 'settings'
  const [sidePanel, setSidePanel] = useState<SidePanelState>(() => ({ open: false, tab: 'files' }))
  const [filePreview, setFilePreview] = useState<ProjectFilePreviewOverlayState | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchScope, setSearchScope] = useState<AppSearchScope>('all')
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [agentSettingsPanel, setAgentSettingsPanel] = useState<AgentSettingsPanelId>('general')
  const filePaneRef = useRef<AppFileTreePaneHandle>(null)
  const filePreviewRequestRef = useRef(0)
  const agentMode = useWorkspaceAgentMode(activeProject)

  /** 与 ChatPage.showThreadView 一致：有消息或插件定制线程时视为对话流，否则为项目首页 / Mirrors ChatPage.showThreadView */
  const chatItems = activeThread?.chatState.items ?? []
  const hasThreadMessages = chatItems.length > 0
  const showConversationFlow =
    hasThreadMessages ||
    activeThread?.purpose === 'home-plugin-customization' ||
    activeThread?.purpose === 'home-plugin-card-customization' ||
    activeThread?.purpose === 'task-run' ||
    activeThread?.purpose === 'skill-run'
  const showAgentModeToolbar = activeViewId === 'home' && !showConversationFlow

  // --- Close auxiliary drawer when navigating into settings / 进入设置路由时收起辅助抽屉 ---

  useEffect(() => {
    if (activeViewId === 'settings') setSidePanel((prev) => ({ ...prev, open: false }))
  }, [activeViewId])

  useEffect(() => {
    filePreviewRequestRef.current += 1
    setFilePreview(null)
  }, [activeProject.path])

  useEffect(() => {
    if (activeViewId !== 'home') {
      filePreviewRequestRef.current += 1
      setFilePreview(null)
    }
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

  const openSearch = useCallback((scope: AppSearchScope) => {
    setSearchScope(scope)
    setSearchOpen(true)
  }, [])

  const openAgentSettings = useCallback((panel: AgentSettingsPanelId) => {
    setAgentSettingsPanel(panel)
    setAgentSettingsOpen(true)
  }, [])

  useEffect(() => {
    const onOpenSearch = (event: Event) => {
      const scope = (event as CustomEvent<{ scope?: AppSearchScope }>).detail?.scope
      openSearch(scope === 'files' || scope === 'chats' || scope === 'messages' || scope === 'memory' || scope === 'skills' || scope === 'tasks' ? scope : 'all')
    }
    window.addEventListener('agentos:open-search', onOpenSearch)
    return () => window.removeEventListener('agentos:open-search', onOpenSearch)
  }, [openSearch])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const scope: AppSearchScope | null = key === 'k' ? 'all' : key === 'p' ? 'files' : key === 'g' ? 'chats' : null
      if (!scope) return
      event.preventDefault()
      event.stopPropagation()
      openSearch(scope)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openSearch])

  const openProjectFilePreview = useCallback(
    async (node: FileTreeNode) => {
      const requestId = filePreviewRequestRef.current + 1
      filePreviewRequestRef.current = requestId
      setFilePreview({
        status: 'loading',
        path: node.path,
        relativePath: node.relativePath,
        name: node.name,
      })

      const readProjectFile = window.desktop?.readProjectFile
      if (!readProjectFile) {
        setFilePreview({
          status: 'error',
          path: node.path,
          relativePath: node.relativePath,
          name: node.name,
          message: t('filePanel.previewUnsupported'),
        })
        return
      }

      try {
        const result = await readProjectFile(activeProject.path, node.path)
        if (filePreviewRequestRef.current !== requestId) return
        if (result.ok) {
          setFilePreview({ status: 'ready', file: result })
          return
        }
        setFilePreview({
          status: 'error',
          path: result.path || node.path,
          relativePath: result.relativePath || node.relativePath,
          name: result.name || node.name,
          message: result.message,
        })
      } catch (error) {
        if (filePreviewRequestRef.current !== requestId) return
        setFilePreview({
          status: 'error',
          path: node.path,
          relativePath: node.relativePath,
          name: node.name,
          message: error instanceof Error ? error.message : t('filePanel.previewUnavailable'),
        })
      }
    },
    [activeProject.path, t],
  )

  const openSearchFileResult = useCallback(
    (item: ProjectFileSearchItem) => {
      if (item.type === 'directory') {
        setSidePanel({ open: true, tab: 'files' })
        return
      }
      void openProjectFilePreview({
        name: item.label,
        path: item.path,
        relativePath: item.relativePath,
        type: item.type,
      })
    },
    [openProjectFilePreview],
  )

  const openSearchMessageResult = useCallback(
    (threadId: string, itemId?: string) => {
      onSelectThread(threadId)
      if (!itemId) return

      let attempts = 0
      const reveal = () => {
        attempts += 1
        const found = chatRef.current?.revealMessage(itemId) ?? false
        if (!found && attempts < 8) requestAnimationFrame(reveal)
      }
      requestAnimationFrame(reveal)
    },
    [chatRef, onSelectThread],
  )

  const askAboutKnowledgeResult = useCallback(
    (item: AgentKnowledgeSearchItem) => {
      const prompt = [
        t('search.askPromptIntro', { title: item.title }),
        item.relativePath ? t('search.askPromptPath', { path: item.relativePath }) : '',
        item.snippet ? t('search.askPromptSnippet', { snippet: item.snippet }) : '',
      ]
        .filter(Boolean)
        .join('\n')
      void chatRef.current?.submitPromptInNewThread(item.projectId, prompt)
    },
    [chatRef, t],
  )

  const insertKnowledgeContext = useCallback(
    (item: AgentKnowledgeSearchItem) => {
      const contextText = [
        item.relativePath ? `@${item.relativePath}` : item.title,
        item.snippet ? item.snippet : '',
      ]
        .filter(Boolean)
        .join('\n')
      chatRef.current?.insertComposerText(contextText)
    },
    [chatRef],
  )

  const folderToolbarActive = sidePanel.open && sidePanel.tab === 'files'
  const activePreviewPath = filePreview?.status === 'ready' ? filePreview.file.path : filePreview?.path ?? null

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
            {showAgentModeToolbar ? <AgentModeMenu agent={agentMode} onOpenSettings={() => openAgentSettings('general')} /> : null}
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
            projectOrderIds={projectOrderIds}
            threadRunStates={threadRunStates}
            onStatusChange={onStatusChange}
            onNewThread={onNewThread}
            onCreateProject={onCreateProject}
            onSelectProject={onSelectProject}
            onThreadChatStateChange={onThreadChatStateChange}
            onThreadPromptSubmit={onThreadPromptSubmit}
            onThreadRunStateChange={onThreadRunStateChange}
            agentMode={agentMode}
            agentModeEnabled={agentMode.enabled}
            todoEnabled={agentMode.todoEnabled}
            agentModeLoading={agentMode.loading}
            agentSettingsOpen={agentSettingsOpen}
            agentSettingsPanel={agentSettingsPanel}
            onOpenAgentSettings={openAgentSettings}
            onAgentSettingsPanelChange={setAgentSettingsPanel}
            onCloseAgentSettings={() => setAgentSettingsOpen(false)}
            homeModeResetKey={homeModeResetKey}
            hiddenSkillPaths={hiddenSkillPaths}
            onCreateHomePluginCardThread={onCreateHomePluginCardThread}
            onEditHomePluginCard={onEditHomePluginCard}
            onRunProjectSkill={onRunProjectSkill}
            onStopProjectSkillRun={onStopProjectSkillRun}
          />
          <DocsPage hidden={activeViewId !== 'docs'} />
          <SettingsPage
            hidden={activeViewId !== 'settings'}
            settingsCategory={settingsCategory}
            activeProject={activeProject}
            showProjectSkillsInSidebar={showProjectSkillsInSidebar}
            onShowProjectSkillsInSidebarChange={onShowProjectSkillsInSidebarChange}
          />
          {filePreview ? (
            <ProjectFilePreviewOverlay preview={filePreview} onClose={() => setFilePreview(null)} />
          ) : null}
        </main>
        <AppWorkspaceSidePanel
          open={sidePanel.open}
          activeTab={sidePanel.tab}
          onActiveTabChange={(tab) => setSidePanel((prev) => ({ ...prev, open: true, tab }))}
          onClose={() => setSidePanel((prev) => ({ ...prev, open: false }))}
          filePaneRef={filePaneRef}
          filesPane={
            <AppFileTreePane
              ref={filePaneRef}
              project={activeProject}
              isVisible={sidePanel.open && sidePanel.tab === 'files'}
              activeFilePath={activePreviewPath}
              onOpenFile={openProjectFilePreview}
            />
          }
        />
      </div>
      {searchOpen ? (
        <AppSearchModal
          activeProject={activeProject}
          projects={projects}
          threads={threads}
          projectSkills={projectSkills}
          threadRunStates={threadRunStates}
          initialScope={searchScope}
          onClose={() => setSearchOpen(false)}
          onOpenFile={openSearchFileResult}
          onRunProjectSkill={onRunProjectSkill}
          onAskKnowledge={askAboutKnowledgeResult}
          onInsertKnowledgeContext={insertKnowledgeContext}
          onSelectMessage={openSearchMessageResult}
          onSelectThread={onSelectThread}
        />
      ) : null}
    </div>
  )
}
