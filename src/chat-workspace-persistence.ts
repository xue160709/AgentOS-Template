import type { ChatState, ChatWorkspaceState, WorkspaceProject, WorkspaceThread } from './components/types'

export const CHAT_WORKSPACE_STORAGE_KEY = 'CodeX-UI-Template-chat-workspace-v1'
const LEGACY_CHAT_STATE_STORAGE_KEY = 'CodeX-UI-Template-chat-state-v1'

export function createEmptyChatState(): ChatState {
  return { model: 'Claude Agent', items: [] }
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function latestVisibleThreadForProject(
  state: ChatWorkspaceState,
  projectId: string,
): WorkspaceThread | undefined {
  return state.threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

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

export async function persistChatWorkspaceState(state: ChatWorkspaceState): Promise<void> {
  const save = typeof window !== 'undefined' ? window.desktop?.saveChatWorkspace : undefined
  if (save) {
    try {
      await save(state)
    } catch {
      /* ignore */
    }
  }

  try {
    localStorage.setItem(CHAT_WORKSPACE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
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

export function createDefaultChatWorkspaceState(): ChatWorkspaceState {
  const now = Date.now()
  const activeProjectId = 'project-codex-ui-template'
  const activeThreadId = 'thread-welcome'
  const legacyChatState = loadLegacyChatState()
  return {
    activeProjectId,
    activeThreadId,
    projects: [
      {
        id: activeProjectId,
        name: 'CodeX-UI-Template',
        path: '/Volumes/macOS/Github/CodeX-UI-Template',
        createdAt: now - 1000 * 60 * 60,
        updatedAt: now,
      },
      {
        id: 'project-design-system',
        name: 'Design System',
        path: '~/Projects/design-system',
        createdAt: now - 1000 * 60 * 45,
        updatedAt: now - 1000 * 60 * 15,
      },
    ],
    threads: [
      {
        id: activeThreadId,
        projectId: activeProjectId,
        title: legacyChatState.items.length > 0 ? '最近对话' : '新对话',
        createdAt: now,
        updatedAt: now,
        chatState: legacyChatState,
      },
      {
        id: 'thread-sidebar-plan',
        projectId: 'project-design-system',
        title: '侧边栏交互梳理',
        createdAt: now - 1000 * 60 * 35,
        updatedAt: now - 1000 * 60 * 35,
        chatState: createEmptyChatState(),
      },
    ],
  }
}

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
        createdAt: toFiniteNumber(thread.createdAt, Date.now()),
        updatedAt: toFiniteNumber(thread.updatedAt, Date.now()),
        pinnedAt: toOptionalFiniteNumber(thread.pinnedAt),
        archivedAt: toOptionalFiniteNumber(thread.archivedAt),
        chatState: normalizeStoredChatState(thread.chatState),
      },
    ]
  })

  if (threads.filter((thread) => !thread.archivedAt).length === 0) {
    const now = Date.now()
    threads.unshift({
      id: createId('thread'),
      projectId: projects[0].id,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      chatState: createEmptyChatState(),
    })
  }

  const activeProjectId =
    typeof value.activeProjectId === 'string' && projectIds.has(value.activeProjectId)
      ? value.activeProjectId
      : projects[0].id
  const visibleThreads = threads.filter((thread) => !thread.archivedAt)
  const activeThread =
    typeof value.activeThreadId === 'string'
      ? visibleThreads.find((thread) => thread.id === value.activeThreadId)
      : undefined
  const fallbackThread =
    activeThread ??
    latestVisibleThreadForProject({ activeProjectId, activeThreadId: '', projects, threads }, activeProjectId) ??
    visibleThreads[0]

  return {
    activeProjectId: fallbackThread?.projectId ?? activeProjectId,
    activeThreadId: fallbackThread?.id ?? '',
    projects,
    threads,
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

  return []
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
