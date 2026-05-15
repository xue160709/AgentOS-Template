import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_MAX_RATIO,
  VIEW_HEADINGS,
  settingsCategoryFromLocation,
  settingsWorkspaceTitle,
  viewFromLocation,
} from './app-shell-constants.ts'
import type {
  AppViewId,
  ChatState,
  ChatWorkspaceState,
  SettingsCategoryId,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { AppShellSidebar } from './AppShellSidebar'
import { AppShellWorkspace } from './AppShellWorkspace'
import { type ChatPageHandle } from './ChatPage'

export function AppShell() {
  const [activeViewId, setActiveViewId] = useState<AppViewId>(() => viewFromLocation())
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>(() => settingsCategoryFromLocation())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [headerStatus, setHeaderStatus] = useState('Claude Agent')
  const [chatWorkspace, setChatWorkspace] = useState<ChatWorkspaceState>(() => loadChatWorkspaceState())

  const chatRef = useRef<ChatPageHandle>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const appSidebarRef = useRef<HTMLElement>(null)
  const sidebarSplitterRef = useRef<HTMLDivElement>(null)
  const sidebarResizeActive = useRef(false)
  const activeProject =
    chatWorkspace.projects.find((project) => project.id === chatWorkspace.activeProjectId) ?? chatWorkspace.projects[0]!
  const activeThread =
    chatWorkspace.threads.find((thread) => thread.id === chatWorkspace.activeThreadId) ??
    latestVisibleThreadForProject(chatWorkspace, activeProject.id) ??
    chatWorkspace.threads[0]!

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WORKSPACE_STORAGE_KEY, JSON.stringify(chatWorkspace))
    } catch {
      /* ignore */
    }
  }, [chatWorkspace])

  const goHome = useCallback(() => {
    window.location.hash = ''
  }, [])

  const updateThreadChatState = useCallback(
    (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => {
      setChatWorkspace((prev) => {
        let projectId: string | null = null
        const nextThreads = prev.threads.map((thread) => {
          if (thread.id !== threadId) return thread
          projectId = thread.projectId
          return {
            ...thread,
            updatedAt: Date.now(),
            chatState: resolveChatStateUpdate(thread.chatState, update),
          }
        })
        if (!projectId) return prev
        return {
          ...prev,
          projects: touchProject(prev.projects, projectId),
          threads: nextThreads,
        }
      })
    },
    [],
  )

  const selectThread = useCallback(
    (threadId: string) => {
      setChatWorkspace((prev) => {
        const thread = prev.threads.find((item) => item.id === threadId && !item.archivedAt)
        if (!thread) return prev
        return {
          ...prev,
          activeProjectId: thread.projectId,
          activeThreadId: thread.id,
          projects: touchProject(prev.projects, thread.projectId),
        }
      })
      goHome()
    },
    [goHome],
  )

  const createThreadInProject = useCallback(
    (projectId?: string) => {
      const threadId = createId('thread')
      const now = Date.now()
      setChatWorkspace((prev) => {
        const targetProjectId = projectId ?? prev.activeProjectId
        const nextThread: WorkspaceThread = {
          id: threadId,
          projectId: targetProjectId,
          title: '新对话',
          createdAt: now,
          updatedAt: now,
          chatState: createEmptyChatState(),
        }
        return {
          ...prev,
          activeProjectId: targetProjectId,
          activeThreadId: threadId,
          projects: touchProject(prev.projects, targetProjectId, now),
          threads: [nextThread, ...prev.threads],
        }
      })
      void window.claudeChat?.newThread(threadId)
      goHome()
      requestAnimationFrame(() => void chatRef.current?.focusComposer())
      return threadId
    },
    [goHome],
  )

  const selectProject = useCallback(
    (projectId: string) => {
      const fallbackThreadId = createId('thread')
      let createdThreadId: string | null = null
      setChatWorkspace((prev) => {
        if (!prev.projects.some((project) => project.id === projectId)) return prev
        const existingThread = latestVisibleThreadForProject(prev, projectId)
        if (existingThread) {
          return {
            ...prev,
            activeProjectId: projectId,
            activeThreadId: existingThread.id,
            projects: touchProject(prev.projects, projectId),
          }
        }
        const now = Date.now()
        createdThreadId = fallbackThreadId
        return {
          ...prev,
          activeProjectId: projectId,
          activeThreadId: fallbackThreadId,
          projects: touchProject(prev.projects, projectId, now),
          threads: [
            {
              id: fallbackThreadId,
              projectId,
              title: '新对话',
              createdAt: now,
              updatedAt: now,
              chatState: createEmptyChatState(),
            },
            ...prev.threads,
          ],
        }
      })
      if (createdThreadId) void window.claudeChat?.newThread(createdThreadId)
      goHome()
    },
    [goHome],
  )

  const createProject = useCallback(
    (mode: 'scratch' | 'existing') => {
      const raw =
        mode === 'scratch'
          ? window.prompt('新项目名称', 'Untitled Project')
          : window.prompt('输入已有文件夹路径', '/path/to/project')
      const value = raw?.trim()
      if (!value) return

      const now = Date.now()
      const projectId = createId('project')
      const threadId = createId('thread')
      const name = mode === 'existing' ? pathBasename(value) : value
      const project: WorkspaceProject = {
        id: projectId,
        name,
        path: mode === 'existing' ? value : `~/Projects/${name}`,
        createdAt: now,
        updatedAt: now,
      }
      const thread: WorkspaceThread = {
        id: threadId,
        projectId,
        title: '新对话',
        createdAt: now,
        updatedAt: now,
        chatState: createEmptyChatState(),
      }

      setChatWorkspace((prev) => ({
        ...prev,
        activeProjectId: projectId,
        activeThreadId: threadId,
        projects: [project, ...prev.projects],
        threads: [thread, ...prev.threads],
      }))
      void window.claudeChat?.newThread(threadId)
      goHome()
      requestAnimationFrame(() => void chatRef.current?.focusComposer())
    },
    [goHome],
  )

  const archiveThread = useCallback(
    (threadId: string) => {
      let createdThreadId: string | null = null
      setChatWorkspace((prev) => {
        const target = prev.threads.find((thread) => thread.id === threadId)
        if (!target || target.archivedAt) return prev

        const now = Date.now()
        const nextThreads = prev.threads.map((thread) =>
          thread.id === threadId ? { ...thread, archivedAt: now, updatedAt: now } : thread,
        )
        if (prev.activeThreadId !== threadId) {
          return { ...prev, threads: nextThreads }
        }

        const nextState: ChatWorkspaceState = { ...prev, threads: nextThreads }
        const nextActive =
          latestVisibleThreadForProject(nextState, target.projectId) ??
          nextThreads
            .filter((thread) => !thread.archivedAt)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]

        if (nextActive) {
          return {
            ...nextState,
            activeProjectId: nextActive.projectId,
            activeThreadId: nextActive.id,
            projects: touchProject(prev.projects, nextActive.projectId),
          }
        }

        const newThreadId = createId('thread')
        createdThreadId = newThreadId
        return {
          ...nextState,
          activeProjectId: target.projectId,
          activeThreadId: newThreadId,
          threads: [
            {
              id: newThreadId,
              projectId: target.projectId,
              title: '新对话',
              createdAt: now,
              updatedAt: now,
              chatState: createEmptyChatState(),
            },
            ...nextThreads,
          ],
        }
      })
      if (createdThreadId) void window.claudeChat?.newThread(createdThreadId)
      goHome()
    },
    [goHome],
  )

  const toggleThreadPinned = useCallback((threadId: string) => {
    const now = Date.now()
    setChatWorkspace((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === threadId ? { ...thread, pinnedAt: thread.pinnedAt ? undefined : now } : thread,
      ),
    }))
  }, [])

  const handleThreadPromptSubmit = useCallback((threadId: string, prompt: string) => {
    setChatWorkspace((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) => {
        if (thread.id !== threadId) return thread
        const isUntitled = thread.title === '新对话'
        const hasExistingMessages = thread.chatState.items.some((item) => item.type === 'message' && item.role === 'user')
        return {
          ...thread,
          title: isUntitled && !hasExistingMessages ? titleFromPrompt(prompt) : thread.title,
          updatedAt: Date.now(),
        }
      }),
    }))
  }, [])

  const readCssPxVar = useCallback((name: string, fallback: number): number => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : fallback
  }, [])

  const clampSidebarWidth = useCallback(
    (px: number): number => {
      const body = appBodyRef.current
      if (!body) return px
      const min = readCssPxVar('--width-sidebar-min', 160)
      const bodyW = body.getBoundingClientRect().width
      const max = Math.max(min, bodyW * SIDEBAR_MAX_RATIO)
      return Math.min(max, Math.max(min, px))
    },
    [readCssPxVar],
  )

  const applySidebarWidthPx = useCallback(
    (px: number) => {
      const body = appBodyRef.current
      if (!body) return
      const clamped = clampSidebarWidth(px)
      body.style.setProperty('--sidebar-user-width', `${clamped}px`)
      try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clamped)))
      } catch {
        /* ignore */
      }
    },
    [clampSidebarWidth],
  )

  const handleWindowResize = useCallback(() => {
    if (sidebarCollapsed || !appBodyRef.current) return
    const width = Number.parseFloat(
      getComputedStyle(appBodyRef.current).getPropertyValue('--sidebar-current-width').trim(),
    )
    if (Number.isFinite(width)) applySidebarWidthPx(width)
  }, [applySidebarWidthPx, sidebarCollapsed])

  const syncHistoryButtons = useCallback(() => {
    const nav = (window as unknown as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation
    if (nav && typeof nav.canGoBack === 'boolean') {
      setCanBack(nav.canGoBack)
      setCanForward(!!nav.canGoForward)
      return
    }
    setCanBack(window.history.length > 1)
    setCanForward(false)
  }, [])

  useEffect(() => {
    const onHash = () => {
      setActiveViewId(viewFromLocation())
      setSettingsCategory(settingsCategoryFromLocation())
      syncHistoryButtons()
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', syncHistoryButtons)
    window.addEventListener('resize', handleWindowResize)
    onHash()
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', syncHistoryButtons)
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [handleWindowResize, syncHistoryButtons])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      if (!raw) return
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) applySidebarWidthPx(n)
    } catch {
      /* ignore */
    }
  }, [applySidebarWidthPx])

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (sidebarCollapsed) return

    event.preventDefault()
    sidebarResizeActive.current = true
    shellRef.current?.classList.add('is-resizing-sidebar')
    const splitter = sidebarSplitterRef.current
    const sidebar = appSidebarRef.current
    const body = appBodyRef.current
    if (!splitter || !sidebar || !body) return

    const startX = event.clientX
    const startWidth = sidebar.getBoundingClientRect().width || readCssPxVar('--width-sidebar-min', 240)

    const onMove = (moveEvent: PointerEvent) => {
      if (!sidebarResizeActive.current) return
      applySidebarWidthPx(startWidth + moveEvent.clientX - startX)
    }
    const onUp = () => {
      sidebarResizeActive.current = false
      shellRef.current?.classList.remove('is-resizing-sidebar')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    try {
      splitter.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  const workspaceTitle =
    activeViewId === 'settings' ? settingsWorkspaceTitle(settingsCategory) : VIEW_HEADINGS[activeViewId]

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${activeViewId === 'settings' ? ' is-shell-settings' : ''}`}
      id="app-shell"
      ref={shellRef}
    >
      <div className="app-body" ref={appBodyRef}>
        <AppShellSidebar
          activeViewId={activeViewId}
          settingsCategory={settingsCategory}
          projects={chatWorkspace.projects}
          threads={chatWorkspace.threads}
          activeProjectId={chatWorkspace.activeProjectId}
          activeThreadId={chatWorkspace.activeThreadId}
          canBack={canBack}
          canForward={canForward}
          onNewThread={() => createThreadInProject()}
          onSelectProject={selectProject}
          onSelectThread={selectThread}
          onCreateThreadInProject={createThreadInProject}
          onToggleThreadPinned={toggleThreadPinned}
          onArchiveThread={archiveThread}
          onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
          sidebarRef={appSidebarRef}
          splitterRef={sidebarSplitterRef}
          onSplitterPointerDown={handleSidebarPointerDown}
        />
        <AppShellWorkspace
          workspaceTitle={workspaceTitle}
          headerStatus={headerStatus}
          activeViewId={activeViewId}
          settingsCategory={settingsCategory}
          activeProject={activeProject}
          activeThread={activeThread}
          projects={chatWorkspace.projects}
          chatRef={chatRef}
          onStatusChange={setHeaderStatus}
          onNewThread={() => createThreadInProject()}
          onSelectProject={selectProject}
          onCreateProject={createProject}
          onThreadChatStateChange={updateThreadChatState}
          onThreadPromptSubmit={handleThreadPromptSubmit}
        />
      </div>
    </div>
  )
}

const CHAT_WORKSPACE_STORAGE_KEY = 'CodeX-UI-Template-chat-workspace-v1'
const LEGACY_CHAT_STATE_STORAGE_KEY = 'CodeX-UI-Template-chat-state-v1'

function createEmptyChatState(): ChatState {
  return { model: 'Claude Agent', items: [] }
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function loadChatWorkspaceState(): ChatWorkspaceState {
  try {
    const raw = localStorage.getItem(CHAT_WORKSPACE_STORAGE_KEY)
    if (raw) return normalizeChatWorkspaceState(JSON.parse(raw))
  } catch {
    /* ignore */
  }

  return createDefaultChatWorkspaceState()
}

function createDefaultChatWorkspaceState(): ChatWorkspaceState {
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

function normalizeChatWorkspaceState(value: unknown): ChatWorkspaceState {
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
    activeThread ?? latestVisibleThreadForProject({ activeProjectId, activeThreadId: '', projects, threads }, activeProjectId) ?? visibleThreads[0]

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
        status: value.status === 'streaming' || value.status === 'error' || value.status === 'cancelled' ? value.status : 'done',
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
      },
    ]
  }

  return []
}

function resolveChatStateUpdate(
  prev: ChatState,
  update: ChatState | ((prev: ChatState) => ChatState),
): ChatState {
  return typeof update === 'function' ? update(prev) : update
}

function latestVisibleThreadForProject(state: ChatWorkspaceState, projectId: string): WorkspaceThread | undefined {
  return state.threads
    .filter((thread) => thread.projectId === projectId && !thread.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

function touchProject(projects: WorkspaceProject[], projectId: string, time = Date.now()): WorkspaceProject[] {
  return projects.map((project) => (project.id === projectId ? { ...project, updatedAt: time } : project))
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\n/)[0]?.trim() || '新对话'
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}...` : firstLine
}

function pathBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path || 'Untitled Project'
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
