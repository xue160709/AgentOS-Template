import type { AgentContextSlashItem, ClaudeChatAttachmentKind } from '../claude-chat-types'

export type AppViewId = 'home' | 'docs' | 'settings'

/** Settings 侧栏 `#settings/<id>`，与 Codex 分组导航对齐 */
export type SettingsCategoryId = 'general' | 'skills'

export type MessageStatus = 'done' | 'streaming' | 'error' | 'cancelled'
export type ToolStatus = 'running' | 'done' | 'error' | 'denied'
export type ThinkingStatus = 'running' | 'done'
export type ActivityStatus = 'running' | 'done' | 'error' | 'info'
export type ThreadRunStatus = 'running' | 'waiting'

export type ChatMessageItem = {
  type: 'message'
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  attachments?: ChatMessageAttachment[]
}

export type ChatMessageAttachment = {
  id: string
  kind: ClaudeChatAttachmentKind
  name: string
  path: string
  mimeType: string
  size: number
  preview?: string
  dataUrl?: string
}

export type ChatToolItem = {
  type: 'tool'
  id: string
  toolUseId: string
  name: string
  inputPreview: string
  status: ToolStatus
  detail?: string
}

export type ChatThinkingItem = {
  type: 'thinking'
  id: string
  thinkingId: string
  title: string
  content: string
  status: ThinkingStatus
}

export type ChatActivityItem = {
  type: 'activity'
  id: string
  title: string
  status: ActivityStatus
  detail?: string
  preview?: string
}

export type TranscriptItem = ChatMessageItem | ChatToolItem | ChatThinkingItem | ChatActivityItem

export type ChatState = {
  sessionId?: string
  model: string
  cwd?: string
  items: TranscriptItem[]
}

export type WorkspaceProject = {
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
  /** 项目置顶排序：越大越靠前（持久化在工作区数据中） */
  pinnedAt?: number
}

/** 侧栏布局与折叠偏好（与 {@link WorkspaceProject.pinnedAt} / {@link WorkspaceThread.pinnedAt} 置顶数据同属工作区持久化） */
export type WorkspaceSidebarPrefs = {
  /** 整条侧栏是否收起 */
  collapsed: boolean
  /** 侧栏内收起对话列表的项目 id */
  collapsedProjectIds: string[]
}

export type WorkspaceThread = {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  /** 对话置顶排序：越大越靠前（持久化在工作区数据中） */
  pinnedAt?: number
  archivedAt?: number
  chatState: ChatState
}

export type ThreadRunState = {
  requestId: string
  status: ThreadRunStatus
  updatedAt: number
}

export type FileTreeNode = {
  name: string
  path: string
  relativePath: string
  type: 'directory' | 'file'
  children?: FileTreeNode[]
}

export type FileTreeResult =
  | {
      ok: true
      rootPath: string
      rootName: string
      nodes: FileTreeNode[]
      truncated: boolean
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

export type ChatWorkspaceState = {
  activeProjectId: string
  activeThreadId: string
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
  sidebarPrefs: WorkspaceSidebarPrefs
}

export type ProjectSkillListState = {
  path: string
  loading: boolean
  loaded: boolean
  skills: AgentContextSlashItem[]
  message?: string
}

export type SelectedProjectSkill = Pick<
  AgentContextSlashItem,
  'title' | 'description' | 'path' | 'relativePath' | 'argumentHint'
> & {
  projectId: string
}
