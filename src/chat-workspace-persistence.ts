/**
 * 聊天工作区 localStorage + Electron 双写与迁移归一化逻辑。
 * Dual-write chat workspace state (localStorage + Electron) with normalization helpers.
 */

import type {
  ChatModelPick,
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
  ChatTaskItem,
  ChatTaskState,
  ChatWorkspaceState,
  WorkspaceProject,
  WorkspaceSidebarPrefs,
  WorkspaceThread,
} from './components/types'
import {
  migrateLegacySeedProjects,
  reconcileActiveProject,
  stripRuntimeProjectFields,
} from './project-path'

// --- Factories & selectors / 默认值与查询 ---

/** localStorage 主键（桌面端另有 JSON 文件）/ Primary storage key; Electron mirrors JSON file */
export const CHAT_WORKSPACE_STORAGE_KEY = 'CodeX-UI-Template-chat-workspace-v1'

/** 新建空 ChatState / Fresh chat transcript shell */
export function createEmptyChatState(modelPick?: ChatModelPick): ChatState {
  return { model: modelPick?.anthropicModel ?? 'Claude Agent', modelPick, items: [] }
}

/** 生成带前缀的稳定随机 id / Stable-ish random id with prefix */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 新建侧栏偏好默认值 / Default sidebar prefs */
export function createDefaultSidebarPrefs(): WorkspaceSidebarPrefs {
  return { collapsed: false, collapsedProjectIds: [], projectOrderIds: [] }
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
        return finalizeChatWorkspaceState(normalizeChatWorkspaceState(raw))
      }
      if (fromLocal) {
        const finalized = await finalizeChatWorkspaceState(fromLocal)
        if (window.desktop.saveChatWorkspace) {
          await window.desktop.saveChatWorkspace(finalized)
        }
        return finalized
      }
    } catch {
      /* ignore */
    }
  }

  return finalizeChatWorkspaceState(fromLocal ?? createDefaultChatWorkspaceState())
}

/** 迁移旧种子项目、校验路径并修正活动项目 / Migrate legacy seeds, validate paths, fix active project */
export async function finalizeChatWorkspaceState(state: ChatWorkspaceState): Promise<ChatWorkspaceState> {
  let next = migrateLegacySeedProjects(state)
  next = await annotateProjectPathAvailability(next)
  next = reconcileActiveProject(next)

  const changed =
    JSON.stringify(stripRuntimeProjectFields(next)) !== JSON.stringify(stripRuntimeProjectFields(state))
  if (changed && typeof window !== 'undefined' && window.desktop?.saveChatWorkspace) {
    try {
      await window.desktop.saveChatWorkspace(next)
    } catch {
      /* ignore */
    }
  }

  return next
}

async function annotateProjectPathAvailability(state: ChatWorkspaceState): Promise<ChatWorkspaceState> {
  const validate = typeof window !== 'undefined' ? window.desktop?.validateProjectPaths : undefined
  if (!validate || state.projects.length === 0) {
    return {
      ...state,
      projects: state.projects.map(({ pathMissing: _pathMissing, ...project }) => project),
    }
  }

  try {
    const availability = await validate(state.projects.map((project) => project.path))
    return {
      ...state,
      projects: state.projects.map((project) => ({
        ...project,
        pathMissing: availability[project.path] === false ? true : undefined,
      })),
    }
  } catch {
    return {
      ...state,
      projects: state.projects.map(({ pathMissing: _pathMissing, ...project }) => project),
    }
  }
}

/** 写入 localStorage 并尽力同步主进程 / Persist locally and best-effort mirror to main */
export async function persistChatWorkspaceState(state: ChatWorkspaceState): Promise<void> {
  const toSave = stripRuntimeProjectFields(state)
  try {
    localStorage.setItem(CHAT_WORKSPACE_STORAGE_KEY, JSON.stringify(toSave))
  } catch {
    /* ignore */
  }

  const save = typeof window !== 'undefined' ? window.desktop?.saveChatWorkspace : undefined
  if (save) {
    try {
      await save(toSave)
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

/** 首次启动空工作区 / Empty workspace for first launch */
export function createDefaultChatWorkspaceState(): ChatWorkspaceState {
  return {
    activeProjectId: '',
    activeThreadId: '',
    projects: [],
    threads: [],
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

  let projectOrderIds = defaults.projectOrderIds
  if (Array.isArray(raw.projectOrderIds)) {
    const seen = new Set<string>()
    projectOrderIds = raw.projectOrderIds.filter((id): id is string => {
      if (typeof id !== 'string' || !projectIds.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  return { collapsed, collapsedProjectIds, projectOrderIds }
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

  if (projects.length === 0) {
    return migrateLegacySeedProjects(createDefaultChatWorkspaceState())
  }
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
        homePluginSlug: typeof thread.homePluginSlug === 'string' && thread.homePluginSlug.trim() ? thread.homePluginSlug.trim() : undefined,
        skillPath: typeof thread.skillPath === 'string' && thread.skillPath.trim() ? thread.skillPath.trim() : undefined,
        skillCommand:
          typeof thread.skillCommand === 'string' && thread.skillCommand.trim() ? thread.skillCommand.trim() : undefined,
        skillTitle: typeof thread.skillTitle === 'string' && thread.skillTitle.trim() ? thread.skillTitle.trim() : undefined,
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

function normalizeStoredChatState(value: unknown): ChatState {
  if (!isRecord(value)) return createEmptyChatState()
  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    model: typeof value.model === 'string' ? value.model : 'Claude Agent',
    modelPick: normalizeStoredModelPick(value.modelPick),
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    tasks: normalizeStoredTaskState(value.tasks),
    items: Array.isArray(value.items) ? value.items.flatMap(normalizeTranscriptItem) : [],
  }
}

function normalizeStoredTaskState(value: unknown): ChatTaskState | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const items = value.items.flatMap(normalizeStoredTaskItem)
  if (items.length === 0) return undefined
  return {
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    updatedAt: toFiniteNumber(value.updatedAt, Date.now()),
    items,
  }
}

function normalizeStoredTaskItem(value: unknown): ChatTaskItem[] {
  if (!isRecord(value) || typeof value.id !== 'string') return []
  const subject = typeof value.subject === 'string' ? value.subject.trim() : ''
  if (!subject) return []
  const status =
    value.status === 'in_progress' || value.status === 'completed' || value.status === 'deleted'
      ? value.status
      : 'pending'
  return [
    {
      id: value.id,
      toolUseId: typeof value.toolUseId === 'string' ? value.toolUseId : undefined,
      subject,
      description: typeof value.description === 'string' ? value.description : undefined,
      activeForm: typeof value.activeForm === 'string' ? value.activeForm : undefined,
      status,
      owner: typeof value.owner === 'string' ? value.owner : undefined,
      blocks: Array.isArray(value.blocks) ? value.blocks.filter((item): item is string => typeof item === 'string') : undefined,
      blockedBy: Array.isArray(value.blockedBy) ? value.blockedBy.filter((item): item is string => typeof item === 'string') : undefined,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
      createdAt: toFiniteNumber(value.createdAt, Date.now()),
      updatedAt: toFiniteNumber(value.updatedAt, Date.now()),
      order: toFiniteNumber(value.order, 0),
    },
  ]
}

function normalizeStoredModelPick(value: unknown): ChatModelPick | undefined {
  if (!isRecord(value)) return undefined
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const anthropicModel = typeof value.anthropicModel === 'string' ? value.anthropicModel.trim() : ''
  if (!providerId || !anthropicModel) return undefined
  return { providerId, anthropicModel }
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
  return value === 'home-plugin-customization' ||
    value === 'home-plugin-card-customization' ||
    value === 'task-run' ||
    value === 'skill-run'
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
