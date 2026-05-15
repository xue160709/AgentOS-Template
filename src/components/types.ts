export type AppViewId = 'home' | 'docs' | 'settings'

/** Settings 侧栏 `#settings/<id>`，与 Codex 分组导航对齐 */
export type SettingsCategoryId = 'general' | 'appearance'

export type MessageStatus = 'done' | 'streaming' | 'error' | 'cancelled'
export type ToolStatus = 'running' | 'done' | 'error' | 'denied'

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
}

export type TranscriptItem = ChatMessageItem | ChatToolItem

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

export type ChatWorkspaceState = {
  activeProjectId: string
  activeThreadId: string
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
}
