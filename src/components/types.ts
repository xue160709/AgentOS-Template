import type { AgentContextSlashItem } from '../claude-chat-types'

export type AppViewId = 'home' | 'docs' | 'settings'

/** Settings 侧栏 `#settings/<id>`，与 Codex 分组导航对齐 */
export type SettingsCategoryId = 'general' | 'skills'

export type MessageStatus = 'done' | 'streaming' | 'error' | 'cancelled'
export type ToolStatus = 'running' | 'done' | 'error' | 'denied'
export type ThinkingStatus = 'running' | 'done'
export type ActivityStatus = 'running' | 'done' | 'error' | 'info'

export type ChatMessageItem = {
  type: 'message'
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
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
}

export type WorkspaceThread = {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  pinnedAt?: number
  archivedAt?: number
  chatState: ChatState
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
}

export type ProjectSkillListState = {
  path: string
  loading: boolean
  loaded: boolean
  skills: AgentContextSlashItem[]
  message?: string
}
