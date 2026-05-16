import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  createEmptyChatState,
  createId,
  latestVisibleThreadForProject,
  loadChatWorkspaceState,
  persistChatWorkspaceState,
} from '../chat-workspace-persistence'
import {
  SIDEBAR_HIDDEN_SKILLS_STORAGE_KEY,
  SIDEBAR_PROJECT_SKILLS_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_MAX_RATIO,
  VIEW_HEADING_KEYS,
  settingsCategoryFromLocation,
  settingsWorkspaceTitleKey,
  viewFromLocation,
} from './app-shell-constants.ts'
import { defaultThreadTitleSet, getInitialLocale, translate, useI18n } from '../i18n/i18n'
import type {
  AppViewId,
  ChatState,
  ChatWorkspaceState,
  ProjectSkillListState,
  SettingsCategoryId,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { AppShellSidebar } from './AppShellSidebar'
import { AppShellWorkspace } from './AppShellWorkspace'
import { type ChatPageHandle } from './ChatPage'

export function AppShell() {
  const { t } = useI18n()
  const [activeViewId, setActiveViewId] = useState<AppViewId>(() => viewFromLocation())
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>(() => settingsCategoryFromLocation())
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [headerStatus, setHeaderStatus] = useState(() => translate(getInitialLocale(), 'shell.headerDefault'))
  const [chatWorkspace, setChatWorkspace] = useState<ChatWorkspaceState | null>(null)
  const [showProjectSkillsInSidebar, setShowProjectSkillsInSidebar] = useState(() =>
    readStoredBoolean(SIDEBAR_PROJECT_SKILLS_STORAGE_KEY, false),
  )
  const [projectSkillStates, setProjectSkillStates] = useState<Record<string, ProjectSkillListState>>({})
  const [hiddenSkillPathsByProject, setHiddenSkillPathsByProject] = useState<Record<string, string[]>>(() =>
    readHiddenSkillPathsMap(),
  )

  const chatRef = useRef<ChatPageHandle>(null)
  const projectSkillStatesRef = useRef(projectSkillStates)
  const shellRef = useRef<HTMLDivElement>(null)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const appSidebarRef = useRef<HTMLElement>(null)
  const sidebarSplitterRef = useRef<HTMLDivElement>(null)
  const sidebarResizeActive = useRef(false)

  const updateChatWorkspace = useCallback((update: (prev: ChatWorkspaceState) => ChatWorkspaceState) => {
    setChatWorkspace((prev) => (prev ? update(prev) : prev))
  }, [])

  const updateShowProjectSkillsInSidebar = useCallback((enabled: boolean) => {
    setShowProjectSkillsInSidebar(enabled)
    writeStoredBoolean(SIDEBAR_PROJECT_SKILLS_STORAGE_KEY, enabled)
  }, [])

  const activeProject =
    chatWorkspace?.projects.find((project) => project.id === chatWorkspace.activeProjectId) ??
    chatWorkspace?.projects[0]
  const activeThread =
    (chatWorkspace &&
      (chatWorkspace.threads.find((thread) => thread.id === chatWorkspace.activeThreadId) ??
        latestVisibleThreadForProject(chatWorkspace, activeProject?.id ?? '') ??
        chatWorkspace.threads[0])) ||
    undefined
  const projectSkillProjectKey = useMemo(
    () => chatWorkspace?.projects.map((project) => `${project.id}:${project.path}`).join('\n') ?? '',
    [chatWorkspace?.projects],
  )

  const projectIdsKey = useMemo(
    () => chatWorkspace?.projects.map((project) => project.id).sort().join('\n') ?? '',
    [chatWorkspace?.projects],
  )

  useEffect(() => {
    if (!projectIdsKey) return
    setHiddenSkillPathsByProject((prev) => {
      const allowed = new Set(projectIdsKey.split('\n'))
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [projectId, paths] of Object.entries(prev)) {
        if (!allowed.has(projectId)) {
          changed = true
          continue
        }
        next[projectId] = paths
      }
      if (changed) writeHiddenSkillPathsMap(next)
      return changed ? next : prev
    })
  }, [projectIdsKey])

  useEffect(() => {
    let cancelled = false
    void loadChatWorkspaceState().then((state) => {
      if (!cancelled) setChatWorkspace(state)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!chatWorkspace) return

    setProjectSkillStates((current) => {
      const projectIds = new Set(chatWorkspace.projects.map((project) => project.id))
      let changed = false
      const next: Record<string, ProjectSkillListState> = {}
      for (const [projectId, state] of Object.entries(current)) {
        if (!projectIds.has(projectId)) {
          changed = true
          continue
        }
        next[projectId] = state
      }
      return changed ? next : current
    })
  }, [projectSkillProjectKey])

  useEffect(() => {
    projectSkillStatesRef.current = projectSkillStates
  }, [projectSkillStates])

  useEffect(() => {
    if (!showProjectSkillsInSidebar || !chatWorkspace) return

    const listAgentContext = window.desktop?.listAgentContext
    let cancelled = false

    const markUnavailable = (project: WorkspaceProject) => {
      setProjectSkillStates((current) => ({
        ...current,
        [project.id]: {
          path: project.path,
          loading: false,
          loaded: true,
          skills: [],
          message: t('shell.projectSkillUnavailable'),
        },
      }))
    }

    for (const project of chatWorkspace.projects) {
      const existing = projectSkillStatesRef.current[project.id]
      if (existing?.path === project.path && (existing.loading || existing.loaded)) continue

      if (!listAgentContext) {
        markUnavailable(project)
        continue
      }

      setProjectSkillStates((current) => ({
        ...current,
        [project.id]: {
          path: project.path,
          loading: true,
          loaded: false,
          skills: [],
        },
      }))

      listAgentContext(project.path)
        .then((result) => {
          if (cancelled) return
          setProjectSkillStates((current) => ({
            ...current,
            [project.id]: {
              path: project.path,
              loading: false,
              loaded: true,
              skills: result.ok
                ? result.skills.filter((skill) => skill.scope === 'project' && skill.kind === 'skill')
                : [],
              message: result.ok ? undefined : result.message,
            },
          }))
        })
        .catch((error) => {
          if (cancelled) return
          setProjectSkillStates((current) => ({
            ...current,
            [project.id]: {
              path: project.path,
              loading: false,
              loaded: true,
              skills: [],
              message: error instanceof Error ? error.message : t('shell.projectSkillReadError'),
            },
          }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [projectSkillProjectKey, showProjectSkillsInSidebar, t])

  useEffect(() => {
    if (!chatWorkspace) return
    void persistChatWorkspaceState(chatWorkspace)
  }, [chatWorkspace])

  const goHome = useCallback(() => {
    window.location.hash = ''
  }, [])

  const updateThreadChatState = useCallback(
    (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => {
      updateChatWorkspace((prev) => {
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
    [updateChatWorkspace],
  )

  const selectThread = useCallback(
    (threadId: string) => {
      updateChatWorkspace((prev) => {
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
    [goHome, updateChatWorkspace],
  )

  const createThreadInProject = useCallback(
    (projectId?: string) => {
      const threadId = createId('thread')
      const now = Date.now()
      updateChatWorkspace((prev) => {
        const targetProjectId = projectId ?? prev.activeProjectId
        const nextThread: WorkspaceThread = {
          id: threadId,
          projectId: targetProjectId,
          title: t('thread.newThreadTitle'),
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
    [goHome, updateChatWorkspace, t],
  )

  const runProjectSkill = useCallback((projectId: string, prompt: string) => {
    const submit = chatRef.current?.submitPromptInNewThread(projectId, prompt)
    if (!submit) {
      createThreadInProject(projectId)
      return
    }
    void submit.then((submitted) => {
      if (!submitted) setHeaderStatus(t('shell.headerProcessingThread'))
    })
  }, [createThreadInProject, t])

  const selectProject = useCallback(
    (projectId: string) => {
      const fallbackThreadId = createId('thread')
      let createdThreadId: string | null = null
      updateChatWorkspace((prev) => {
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
              title: t('thread.newThreadTitle'),
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
    [goHome, updateChatWorkspace, t],
  )

  const createProject = useCallback(
    async (mode: 'scratch' | 'existing') => {
      let value: string | undefined
      if (mode === 'scratch') {
        value = window.prompt(t('project.promptNewName'), t('project.scratchDefaultName'))?.trim()
      } else if (window.desktop?.pickProjectDirectory) {
        value = (await window.desktop.pickProjectDirectory())?.trim()
      } else {
        value = window.prompt(t('project.promptExistingPath'), '')?.trim()
      }
      if (!value) return

      const now = Date.now()
      const projectId = createId('project')
      const threadId = createId('thread')
      const scratchDefault = t('project.scratchDefaultName')
      const name = mode === 'existing' ? pathBasename(value, scratchDefault) : value
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
        title: t('thread.newThreadTitle'),
        createdAt: now,
        updatedAt: now,
        chatState: createEmptyChatState(),
      }

      updateChatWorkspace((prev) => ({
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
    [goHome, updateChatWorkspace, t],
  )

  const archiveThread = useCallback(
    (threadId: string) => {
      let createdThreadId: string | null = null
      updateChatWorkspace((prev) => {
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
              title: t('thread.newThreadTitle'),
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
    [goHome, updateChatWorkspace, t],
  )

  const toggleThreadPinned = useCallback((threadId: string) => {
    const now = Date.now()
    updateChatWorkspace((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) =>
        thread.id === threadId ? { ...thread, pinnedAt: thread.pinnedAt ? undefined : now } : thread,
      ),
    }))
  }, [updateChatWorkspace])

  const toggleProjectPinned = useCallback((projectId: string) => {
    const now = Date.now()
    updateChatWorkspace((prev) => ({
      ...prev,
      projects: prev.projects.map((project) =>
        project.id === projectId ? { ...project, pinnedAt: project.pinnedAt ? undefined : now, updatedAt: now } : project,
      ),
    }))
  }, [updateChatWorkspace])

  const removeProject = useCallback(
    (projectId: string) => {
      let createdThreadId: string | null = null
      let didRemove = false
      updateChatWorkspace((prev) => {
        if (prev.projects.length <= 1) return prev
        if (!prev.projects.some((project) => project.id === projectId)) return prev

        didRemove = true
        const nextProjects = prev.projects.filter((project) => project.id !== projectId)
        let nextThreads = prev.threads.filter((thread) => thread.projectId !== projectId)

        let activeProjectId = prev.activeProjectId
        let activeThreadId = prev.activeThreadId

        if (prev.activeProjectId === projectId) {
          activeProjectId = nextProjects[0]?.id ?? prev.activeProjectId
          const candidate = latestVisibleThreadForProject(
            { ...prev, projects: nextProjects, threads: nextThreads, activeProjectId, activeThreadId: '' },
            activeProjectId,
          )
          if (candidate) {
            activeThreadId = candidate.id
          } else if (activeProjectId) {
            const newThreadId = createId('thread')
            const now = Date.now()
            createdThreadId = newThreadId
            activeThreadId = newThreadId
            nextThreads = [
              {
                id: newThreadId,
                projectId: activeProjectId,
                title: t('thread.newThreadTitle'),
                createdAt: now,
                updatedAt: now,
                chatState: createEmptyChatState(),
              },
              ...nextThreads,
            ]
          }
        }

        return {
          ...prev,
          projects: nextProjects,
          threads: nextThreads,
          activeProjectId,
          activeThreadId,
        }
      })
      if (!didRemove) return
      if (createdThreadId) void window.claudeChat?.newThread(createdThreadId)
      goHome()
    },
    [goHome, t, updateChatWorkspace],
  )

  const revealProjectInFileManager = useCallback((projectPath: string) => {
    void window.desktop?.showItemInFolder?.(projectPath)
  }, [])

  const hideProjectSkill = useCallback((projectId: string, skillPath: string) => {
    setHiddenSkillPathsByProject((prev) => {
      const existing = prev[projectId] ?? []
      if (existing.includes(skillPath)) return prev
      const next = { ...prev, [projectId]: [...existing, skillPath] }
      writeHiddenSkillPathsMap(next)
      return next
    })
  }, [])

  const handleThreadPromptSubmit = useCallback((threadId: string, prompt: string) => {
    updateChatWorkspace((prev) => ({
      ...prev,
      threads: prev.threads.map((thread) => {
        if (thread.id !== threadId) return thread
        const isUntitled = defaultThreadTitleSet.has(thread.title)
        const hasExistingMessages = thread.chatState.items.some((item) => item.type === 'message' && item.role === 'user')
        return {
          ...thread,
          title: isUntitled && !hasExistingMessages ? titleFromPrompt(prompt, t('thread.newThreadTitle')) : thread.title,
          updatedAt: Date.now(),
        }
      }),
    }))
  }, [updateChatWorkspace, t])

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

  const workspaceTitle = useMemo(() => {
    if (activeViewId === 'settings') return t(settingsWorkspaceTitleKey(settingsCategory))
    return t(VIEW_HEADING_KEYS[activeViewId])
  }, [activeViewId, settingsCategory, t])

  if (!chatWorkspace || !activeProject || !activeThread) {
    return null
  }

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
          showProjectSkills={showProjectSkillsInSidebar}
          projectSkillStates={projectSkillStates}
          hiddenSkillPathsByProject={hiddenSkillPathsByProject}
          canBack={canBack}
          canForward={canForward}
          onNewThread={() => createThreadInProject()}
          onSelectProject={selectProject}
          onSelectThread={selectThread}
          onCreateThreadInProject={createThreadInProject}
          onRunProjectSkill={runProjectSkill}
          onToggleThreadPinned={toggleThreadPinned}
          onArchiveThread={archiveThread}
          onToggleProjectPinned={toggleProjectPinned}
          onRemoveProject={removeProject}
          onRevealProjectInFileManager={revealProjectInFileManager}
          onHideProjectSkill={hideProjectSkill}
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
          onNewThread={createThreadInProject}
          onSelectProject={selectProject}
          onCreateProject={createProject}
          onThreadChatStateChange={updateThreadChatState}
          onThreadPromptSubmit={handleThreadPromptSubmit}
          showProjectSkillsInSidebar={showProjectSkillsInSidebar}
          onShowProjectSkillsInSidebarChange={updateShowProjectSkillsInSidebar}
        />
      </div>
    </div>
  )
}

function resolveChatStateUpdate(
  prev: ChatState,
  update: ChatState | ((prev: ChatState) => ChatState),
): ChatState {
  return typeof update === 'function' ? update(prev) : update
}

function touchProject(projects: WorkspaceProject[], projectId: string, time = Date.now()): WorkspaceProject[] {
  return projects.map((project) => (project.id === projectId ? { ...project, updatedAt: time } : project))
}

function titleFromPrompt(prompt: string, fallbackTitle: string): string {
  const firstLine = prompt.trim().split(/\n/)[0]?.trim() || fallbackTitle
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}...` : firstLine
}

function pathBasename(path: string, fallback: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path || fallback
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === '1' || raw === 'true') return true
    if (raw === '0' || raw === 'false') return false
  } catch {
    /* ignore */
  }
  return fallback
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function readHiddenSkillPathsMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(SIDEBAR_HIDDEN_SKILLS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [projectId, paths] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof projectId !== 'string' || !Array.isArray(paths)) continue
      const list = paths.filter((item): item is string => typeof item === 'string')
      if (list.length > 0) out[projectId] = list
    }
    return out
  } catch {
    return {}
  }
}

function writeHiddenSkillPathsMap(map: Record<string, string[]>): void {
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_SKILLS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}
