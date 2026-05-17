import type {
  ClaudeFileChangeSetStatus,
  ClaudeFileDiffFile,
  ClaudeFileDiffFileStatus,
  ClaudeFileDiffHunk,
  ClaudeFileDiffLine,
  ClaudeFileDiffLineKind,
} from './claude-chat-types'
import type {
  ChatMessageAttachment,
  ChatState,
  ChatWorkspaceState,
  WorkspaceProject,
  WorkspaceSidebarPrefs,
  WorkspaceThread,
} from './components/types'

/**
 * 聊天工作区 localStorage + Electron 双写与迁移归一化逻辑。
 * Dual-write chat workspace state (localStorage + Electron) with normalization helpers.
 */

// --- Factories & selectors / 默认值与查询 ---

/** localStorage 主键（桌面端另有 JSON 文件）/ Primary storage key; Electron mirrors JSON file */
export const CHAT_WORKSPACE_STORAGE_KEY = 'CodeX-UI-Template-chat-workspace-v1'
const LEGACY_CHAT_STATE_STORAGE_KEY = 'CodeX-UI-Template-chat-state-v1'

/** 新建空 ChatState / Fresh chat transcript shell */
export function createEmptyChatState(): ChatState {
  return { model: 'Claude Agent', items: [] }
}

/** 生成带前缀的稳定随机 id / Stable-ish random id with prefix */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 新建侧栏偏好默认值 / Default sidebar prefs */
export function createDefaultSidebarPrefs(): WorkspaceSidebarPrefs {
  return { collapsed: false, collapsedProjectIds: [] }
}

/** 某项目下最新未归档线程 / Latest non-archived thread for project */
export function latestVisibleThreadForProject(
  state: ChatWorkspaceState,
  projectId: string,
): WorkspaceThread | undefined {
  return state.threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

// --- Persistence IO / 持久化读写 ---

/** 合并 Electron 与本地缓存加载工作区 / Load workspace preferring Electron then local fallback */
export async function loadChatWorkspaceState(): Promise<ChatWorkspaceState> {
  const fromLocal = loadChatWorkspaceFromLocalStorage()

  if (typeof window !== 'undefined' && window.desktop?.getChatWorkspace) {
    try {
      const raw = await window.desktop.getChatWorkspace()
      if (raw != null) {
        return normalizeChatWorkspaceState(raw)
      }
      if (fromLocal && window.desktop.saveChatWorkspace) {
        await window.desktop.saveChatWorkspace(fromLocal)
        return fromLocal
      }
    } catch {
      /* ignore */
    }
  }

  return fromLocal ?? createDefaultChatWorkspaceState()
}

/** 写入 localStorage 并尽力同步主进程 / Persist locally and best-effort mirror to main */
export async function persistChatWorkspaceState(state: ChatWorkspaceState): Promise<void> {
  try {
    localStorage.setItem(CHAT_WORKSPACE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }

  const save = typeof window !== 'undefined' ? window.desktop?.saveChatWorkspace : undefined
  if (save) {
    try {
      await save(state)
    } catch {
      /* ignore */
    }
  }
}

function loadChatWorkspaceFromLocalStorage(): ChatWorkspaceState | null {
  try {
    const raw = localStorage.getItem(CHAT_WORKSPACE_STORAGE_KEY)
    if (raw) return normalizeChatWorkspaceState(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  return null
}

/** 首次启动默认项目与欢迎线程 / Seed workspace for first launch */
export function createDefaultChatWorkspaceState(): ChatWorkspaceState {
  const now = Date.now()
  const activeProjectId = 'project-codex-ui-template'
  const legacyChatState = loadLegacyChatState()
  const hasLegacyConversation = legacyChatState.items.length > 0
  const activeThreadId = hasLegacyConversation ? 'thread-welcome' : ''
  return {
    activeProjectId,
    activeThreadId,
    projects: [
      {
        id: activeProjectId,
        name: 'AgentOS',
        path: '/Volumes/macOS/Github/CodeX-UI-Template',
        createdAt: now - 1000 * 60 * 60,
        updatedAt: now,
      },
    ],
    threads: hasLegacyConversation
      ? [
          {
            id: activeThreadId,
            projectId: activeProjectId,
            title: '最近对话',
            createdAt: now,
            updatedAt: now,
            chatState: legacyChatState,
          },
        ]
      : [],
    sidebarPrefs: createDefaultSidebarPrefs(),
  }
}

function normalizeSidebarPrefs(value: unknown, projectIds: Set<string>): WorkspaceSidebarPrefs {
  const defaults = createDefaultSidebarPrefs()
  if (!isRecord(value)) return defaults
  const raw = value.sidebarPrefs
  if (!isRecord(raw)) return defaults

  const collapsed = raw.collapsed === true

  let collapsedProjectIds = defaults.collapsedProjectIds
  if (Array.isArray(raw.collapsedProjectIds)) {
    collapsedProjectIds = raw.collapsedProjectIds.filter(
      (id): id is string => typeof id === 'string' && projectIds.has(id),
    )
  }

  return { collapsed, collapsedProjectIds }
}

// --- Normalization / 状态规范化 ---

/** 将未知 JSON 负载清洗为 ChatWorkspaceState / Coerce arbitrary JSON into workspace state */
export function normalizeChatWorkspaceState(value: unknown): ChatWorkspaceState {
  if (!isRecord(value) || !Array.isArray(value.projects) || !Array.isArray(value.threads)) {
    return createDefaultChatWorkspaceState()
  }

  const projects = value.projects.flatMap((project): WorkspaceProject[] => {
    if (!isRecord(project) || typeof project.id !== 'string' || typeof project.name !== 'string') return []
    return [
      {
        id: project.id,
        name: project.name || 'Untitled Project',
        path: typeof project.path === 'string' ? project.path : '',
        createdAt: toFiniteNumber(project.createdAt, Date.now()),
        updatedAt: toFiniteNumber(project.updatedAt, Date.now()),
        pinnedAt: toOptionalFiniteNumber(project.pinnedAt),
      },
    ]
  })

  if (projects.length === 0) return createDefaultChatWorkspaceState()
  const projectIds = new Set(projects.map((project) => project.id))
  const threads = value.threads.flatMap((thread): WorkspaceThread[] => {
    if (!isRecord(thread) || typeof thread.id !== 'string' || typeof thread.projectId !== 'string') return []
    if (!projectIds.has(thread.projectId)) return []
    return [
      {
        id: thread.id,
        projectId: thread.projectId,
        title: typeof thread.title === 'string' && thread.title.trim() ? thread.title : '新对话',
        purpose: normalizeThreadPurpose(thread.purpose),
        createdAt: toFiniteNumber(thread.createdAt, Date.now()),
        updatedAt: toFiniteNumber(thread.updatedAt, Date.now()),
        pinnedAt: toOptionalFiniteNumber(thread.pinnedAt),
        archivedAt: toOptionalFiniteNumber(thread.archivedAt),
        chatState: normalizeStoredChatState(thread.chatState),
      },
    ]
  })

  const sidebarPrefs = normalizeSidebarPrefs(value, projectIds)

  const activeProjectId =
    typeof value.activeProjectId === 'string' && projectIds.has(value.activeProjectId)
      ? value.activeProjectId
      : projects[0].id
  const visibleThreads = threads.filter((thread) => !thread.archivedAt)
  const requestedProjectHome = value.activeThreadId === ''
  const activeThread =
    typeof value.activeThreadId === 'string' && !requestedProjectHome
      ? visibleThreads.find((thread) => thread.id === value.activeThreadId)
      : undefined
  const activeProjectThread = requestedProjectHome
    ? undefined
    : activeThread?.projectId === activeProjectId
      ? activeThread
      : latestVisibleThreadForProject(
          { activeProjectId, activeThreadId: '', projects, threads, sidebarPrefs },
          activeProjectId,
        )

  return {
    activeProjectId,
    activeThreadId: activeProjectThread?.id ?? '',
    projects,
    threads,
    sidebarPrefs,
  }
}

function loadLegacyChatState(): ChatState {
  try {
    const raw = localStorage.getItem(LEGACY_CHAT_STATE_STORAGE_KEY)
    if (!raw) return createEmptyChatState()
    return normalizeStoredChatState(JSON.parse(raw))
  } catch {
    return createEmptyChatState()
  }
}

function normalizeStoredChatState(value: unknown): ChatState {
  if (!isRecord(value)) return createEmptyChatState()
  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    model: typeof value.model === 'string' ? value.model : 'Claude Agent',
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    items: Array.isArray(value.items) ? value.items.flatMap(normalizeTranscriptItem) : [],
  }
}

function normalizeTranscriptItem(value: unknown): ChatState['items'] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return []

  if (value.type === 'message' && (value.role === 'user' || value.role === 'assistant')) {
    return [
      {
        type: 'message',
        id: value.id,
        role: value.role,
        content: typeof value.content === 'string' ? value.content : '',
        status:
          value.status === 'streaming' || value.status === 'error' || value.status === 'cancelled'
            ? value.status
            : 'done',
        createdAt: toOptionalFiniteNumber(value.createdAt),
        startedAt: toOptionalFiniteNumber(value.startedAt),
        completedAt: toOptionalFiniteNumber(value.completedAt),
        durationMs: toOptionalFiniteNumber(value.durationMs),
        attachments: normalizeMessageAttachments(value.attachments),
      },
    ]
  }

  if (value.type === 'tool' && typeof value.toolUseId === 'string' && typeof value.name === 'string') {
    return [
      {
        type: 'tool',
        id: value.id,
        toolUseId: value.toolUseId,
        name: value.name,
        inputPreview: typeof value.inputPreview === 'string' ? value.inputPreview : '',
        status:
          value.status === 'running' || value.status === 'error' || value.status === 'denied' ? value.status : 'done',
        detail: typeof value.detail === 'string' ? value.detail : undefined,
      },
    ]
  }

  if (value.type === 'thinking' && typeof value.thinkingId === 'string') {
    return [
      {
        type: 'thinking',
        id: value.id,
        thinkingId: value.thinkingId,
        title: typeof value.title === 'string' ? value.title : 'Think',
        content: typeof value.content === 'string' ? value.content : '',
        status: value.status === 'running' ? value.status : 'done',
      },
    ]
  }

  if (value.type === 'activity' && typeof value.title === 'string') {
    return [
      {
        type: 'activity',
        id: value.id,
        title: value.title,
        status:
          value.status === 'running' || value.status === 'done' || value.status === 'error' || value.status === 'info'
            ? value.status
            : 'info',
        detail: typeof value.detail === 'string' ? value.detail : undefined,
        preview: typeof value.preview === 'string' ? value.preview : undefined,
      },
    ]
  }

  if (value.type === 'file_diff' && typeof value.changeSetId === 'string' && Array.isArray(value.files)) {
    return [
      {
        type: 'file_diff',
        id: value.id,
        requestId: typeof value.requestId === 'string' ? value.requestId : '',
        changeSetId: value.changeSetId,
        checkpointId: typeof value.checkpointId === 'string' ? value.checkpointId : undefined,
        files: normalizeFileDiffFiles(value.files),
        status: normalizeFileChangeSetStatus(value.status),
        detail: typeof value.detail === 'string' ? value.detail : undefined,
      },
    ]
  }

  return []
}

// --- Module helpers / 模块内工具 ---

function normalizeMessageAttachments(value: unknown): ChatMessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attachments = value
    .map((item): ChatMessageAttachment | undefined => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return undefined
      const kind = item.kind === 'image' || item.kind === 'text' ? item.kind : undefined
      if (!kind) return undefined
      return {
        id: item.id,
        kind,
        name: item.name,
        path: typeof item.path === 'string' ? item.path : '',
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
        size: toFiniteNumber(item.size, 0),
        preview: typeof item.preview === 'string' ? item.preview : undefined,
        dataUrl: typeof item.dataUrl === 'string' ? item.dataUrl : undefined,
      }
    })
    .filter((item): item is ChatMessageAttachment => Boolean(item))
  return attachments.length ? attachments : undefined
}

function normalizeFileDiffFiles(value: unknown): ClaudeFileDiffFile[] {
  if (!Array.isArray(value)) return []
  return value
    .map((file): ClaudeFileDiffFile | undefined => {
      if (!isRecord(file)) return undefined
      return {
        path: typeof file.path === 'string' ? file.path : '',
        relativePath: typeof file.relativePath === 'string' ? file.relativePath : typeof file.path === 'string' ? file.path : '',
        status: normalizeFileDiffStatus(file.status),
        additions: toFiniteNumber(file.additions, 0),
        deletions: toFiniteNumber(file.deletions, 0),
        hunks: normalizeFileDiffHunks(file.hunks),
        truncated: file.truncated === true || undefined,
      }
    })
    .filter((file): file is ClaudeFileDiffFile => Boolean(file))
}

function normalizeFileDiffHunks(value: unknown): ClaudeFileDiffFile['hunks'] {
  if (!Array.isArray(value)) return []
  return value
    .map((hunk): ClaudeFileDiffHunk | undefined => {
      if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined
      const lines = hunk.lines
        .map((line): ClaudeFileDiffLine | undefined => {
          if (!isRecord(line)) return undefined
          const kind = normalizeFileDiffLineKind(line.kind)
          return {
            kind,
            content: typeof line.content === 'string' ? line.content : '',
            oldLineNumber: typeof line.oldLineNumber === 'number' ? line.oldLineNumber : undefined,
            newLineNumber: typeof line.newLineNumber === 'number' ? line.newLineNumber : undefined,
          }
        })
        .filter((line): line is ClaudeFileDiffLine => Boolean(line))
      return {
        oldStart: toFiniteNumber(hunk.oldStart, 0),
        oldLines: toFiniteNumber(hunk.oldLines, 0),
        newStart: toFiniteNumber(hunk.newStart, 0),
        newLines: toFiniteNumber(hunk.newLines, 0),
        lines,
      }
    })
    .filter((hunk): hunk is ClaudeFileDiffHunk => Boolean(hunk))
}

function normalizeFileChangeSetStatus(value: unknown): ClaudeFileChangeSetStatus {
  if (value === 'reviewed' || value === 'reverted' || value === 'error') return value
  return 'captured'
}

function normalizeFileDiffStatus(value: unknown): ClaudeFileDiffFileStatus {
  if (value === 'added' || value === 'modified' || value === 'deleted') return value
  return 'unknown'
}

function normalizeFileDiffLineKind(value: unknown): ClaudeFileDiffLineKind {
  if (value === 'add' || value === 'delete') return value
  return 'context'
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeThreadPurpose(value: unknown): WorkspaceThread['purpose'] {
  return value === 'home-plugin-customization' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
