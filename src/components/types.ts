/**
 * 应用壳与聊天工作区的 UI 侧类型（线程、侧栏、文件树等）。
 * UI-side types for app shell and chat workspace (threads, sidebar, file tree).
 */

import type {
  AgentContextSlashItem,
  ClaudeChatAttachmentKind,
  ClaudeFileChangeSetStatus,
  ClaudeFileDiffFile,
} from '../claude-chat-types'

/** 顶部主导航视图 / Primary shell view id */
export type AppViewId = 'home' | 'docs' | 'settings'

/** 设置页侧栏路由 `#settings/<id>` / Settings sidebar route fragment `#settings/<id>` */
export type SettingsCategoryId = 'general' | 'skills' | 'agent'

/** 消息气泡渲染状态 / Chat bubble render status */
export type MessageStatus = 'done' | 'streaming' | 'error' | 'cancelled'

/** 工具调用卡片状态 / Tool call row status */
export type ToolStatus = 'running' | 'done' | 'error' | 'denied'

/** 思考链折叠块状态 / Thinking block status */
export type ThinkingStatus = 'running' | 'done'

/** Agent 活动条状态 / Agent activity chip status */
export type ActivityStatus = 'running' | 'done' | 'error' | 'info'

/** 会话内 Agent 运行状态 / In-thread agent run status */
export type ThreadRunStatus = 'running' | 'waiting'

/** 会话中的一条用户或助手消息 / Transcript user or assistant message */
export type ChatMessageItem = {
  type: 'message'
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  attachments?: ChatMessageAttachment[]
}

/** 会话消息携带的附件快照 / Attachment snapshot embedded in a transcript message */
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

/** 工具调用条目 / Tool invocation transcript row */
export type ChatToolItem = {
  type: 'tool'
  id: string
  toolUseId: string
  name: string
  inputPreview: string
  status: ToolStatus
  detail?: string
}

/** 思考过程条目 / Thinking transcript row */
export type ChatThinkingItem = {
  type: 'thinking'
  id: string
  thinkingId: string
  title: string
  content: string
  status: ThinkingStatus
}

/** Agent 活动条目 / Agent activity transcript row */
export type ChatActivityItem = {
  type: 'activity'
  id: string
  title: string
  status: ActivityStatus
  detail?: string
  preview?: string
}

/** 会话中的文件 diff 卡片 / File diff card embedded in the transcript */
export type ChatFileDiffItem = {
  type: 'file_diff'
  id: string
  requestId: string
  changeSetId: string
  checkpointId?: string
  files: ClaudeFileDiffFile[]
  status: ClaudeFileChangeSetStatus
  detail?: string
}

/** 对话时间轴联合类型 / Union of rows shown in the transcript timeline */
export type TranscriptItem = ChatMessageItem | ChatToolItem | ChatThinkingItem | ChatActivityItem | ChatFileDiffItem

/** 单线程内的聊天 UI 状态快照 / Per-thread chat UI state snapshot */
export type ChatState = {
  sessionId?: string
  model: string
  cwd?: string
  items: TranscriptItem[]
}

/** 工作区中的项目卡片 / Workspace project card metadata */
export type WorkspaceProject = {
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
  /** 置顶权重：越大越靠前（持久化）/ Pin rank: larger sorts higher (persisted) */
  pinnedAt?: number
}

/** 侧栏折叠偏好（与置顶同属工作区持久化）/ Sidebar collapse prefs co-persisted with pins */
export type WorkspaceSidebarPrefs = {
  /** 整条侧栏是否收起 / Whether entire sidebar rail is collapsed */
  collapsed: boolean
  /** 在侧栏内折叠对话列表的项目 id / Project ids whose thread lists are collapsed */
  collapsedProjectIds: string[]
}

/** 工作区对话线程 / Workspace chat thread */
export type WorkspaceThread = {
  id: string
  projectId: string
  title: string
  /** 特殊线程用途，例如项目首页插件定制 / Special thread purpose, such as project home customization */
  purpose?: 'home-plugin-customization'
  createdAt: number
  updatedAt: number
  /** 置顶权重：越大越靠前（持久化）/ Pin rank: larger sorts higher (persisted) */
  pinnedAt?: number
  archivedAt?: number
  chatState: ChatState
}

/** 追踪单次 Agent 请求的运行状态 / Tracks one in-flight agent request */
export type ThreadRunState = {
  requestId: string
  status: ThreadRunStatus
  startedAt?: number
  updatedAt: number
}

/** 文件树节点（递归）/ Recursive file tree node */
export type FileTreeNode = {
  name: string
  path: string
  relativePath: string
  type: 'directory' | 'file'
  children?: FileTreeNode[]
}

/** 读取项目文件树的结果 / Result of loading a project file tree */
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

/** 完整聊天工作区状态（活动项目/线程与列表）/ Full chat workspace snapshot */
export type ChatWorkspaceState = {
  activeProjectId: string
  activeThreadId: string
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
  sidebarPrefs: WorkspaceSidebarPrefs
}

/** 某项目的技能列表加载状态 / Loaded slash skills for one project */
export type ProjectSkillListState = {
  path: string
  loading: boolean
  loaded: boolean
  skills: AgentContextSlashItem[]
  message?: string
}

/** 侧栏中选中的技能条目 / Skill entry selected in sidebar */
export type SelectedProjectSkill = Pick<
  AgentContextSlashItem,
  'title' | 'description' | 'path' | 'relativePath' | 'argumentHint'
> & {
  projectId: string
}
