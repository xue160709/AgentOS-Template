/**
 * 应用壳：工作区持久化、侧栏尺寸、聊天路由与设置哈希同步。
 * Root shell owning workspace persistence, sidebar sizing, chat routing, and hash-synced settings.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent as ReactFormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { flushSync } from 'react-dom'
import {
  createEmptyChatState,
  createId,
  latestVisibleThreadForProject,
  loadChatWorkspaceState,
  persistChatWorkspaceState,
  createDefaultChatWorkspaceState,
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
import { CHAT_WORKSPACE_CLEARED_EVENT, CLAUDE_AGENT_SETTINGS_CHANGED_EVENT } from '../app-events'
import { defaultThreadTitleSet, getInitialLocale, translate, useI18n } from '../i18n/i18n'
import { IconInline } from '../icon-inline'
import type { DesktopPreferences, HomePluginRunItem, HomePluginTaskEvent } from '../desktop-types'
import type { ClaudeAgentModelProvider, ClaudeAgentProviderAuthMode, ClaudeAgentSettingsSnapshot } from '../claude-chat-types'
import {
  LOCAL_PROVIDER_PRESET_CATALOG,
  localizeProviderPresetName,
  normalizePresetCatalog,
  type ProviderPreset,
} from '../model-provider-presets'
import type {
  AppViewId,
  ChatState,
  ChatWorkspaceState,
  ProjectSkillRunRequest,
  ProjectSkillListState,
  SelectedProjectSkill,
  SettingsCategoryId,
  ThreadRunState,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { AppShellSidebar } from './AppShellSidebar'
import { AppShellWorkspace } from './AppShellWorkspace'
import { type ChatPageHandle } from './chat/ChatPage'
import { projectIdsForSidebar } from './project-order'

const CHAT_WORKSPACE_SAVE_DEBOUNCE_MS = 750
const INITIAL_PROVIDER_SKIP_VALUE = '__skip'
const INITIAL_PROVIDER_CUSTOM_VALUE = '__custom'
const EYE_COMFORT_CLASS = 'is-eye-comfort'

type InitialModelFormState = {
  presetId: string
  name: string
  apiKeyUrl: string
  authMode: ClaudeAgentProviderAuthMode
  apiKey: string
  baseUrl: string
  model: string
  modelSupportsImages: boolean
  haikuModel: string
  haikuSupportsImages: boolean
  sonnetModel: string
  sonnetSupportsImages: boolean
  opusModel: string
  opusSupportsImages: boolean
}

/** 组合侧栏 + 工作区 + 聊天页顶栏 / Composes sidebar rail, workspace chrome, and chat surfaces */
export function AppShell() {
  // --- Shell state / 壳层状态 ---

  const { t, locale } = useI18n()
  const [activeViewId, setActiveViewId] = useState<AppViewId>(() => viewFromLocation())
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>(() => settingsCategoryFromLocation())
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [headerStatus, setHeaderStatus] = useState(() => translate(getInitialLocale(), 'shell.headerDefault'))
  const [chatWorkspace, setChatWorkspace] = useState<ChatWorkspaceState | null>(null)
  const [showProjectSkillsInSidebar, setShowProjectSkillsInSidebar] = useState(() =>
    readStoredBoolean(SIDEBAR_PROJECT_SKILLS_STORAGE_KEY, true),
  )
  const [projectSkillStates, setProjectSkillStates] = useState<Record<string, ProjectSkillListState>>({})
  const [threadRunStates, setThreadRunStates] = useState<Record<string, ThreadRunState>>({})
  const [selectedProjectSkill, setSelectedProjectSkill] = useState<SelectedProjectSkill | null>(null)
  const [hiddenSkillPathsByProject, setHiddenSkillPathsByProject] = useState<Record<string, string[]>>(() =>
    readHiddenSkillPathsMap(),
  )
  const [homeModeResetKey, setHomeModeResetKey] = useState(0)
  const [initialModelForm, setInitialModelForm] = useState<InitialModelFormState>(() => createInitialModelFormState())
  const [initialModelEnabled, setInitialModelEnabled] = useState(false)
  const [initialModelTouched, setInitialModelTouched] = useState(false)
  const [initialModelStatus, setInitialModelStatus] = useState('')
  const [initialModelBusy, setInitialModelBusy] = useState(false)
  const [initialProjectPath, setInitialProjectPath] = useState('')
  const workspaceClearedRef = useRef(false)
  const initialModelTouchedRef = useRef(false)

  const chatRef = useRef<ChatPageHandle>(null)
  const workspaceSaveTimerRef = useRef<number | null>(null)
  const workspaceSaveInFlightRef = useRef(false)
  const pendingWorkspaceSaveRef = useRef<ChatWorkspaceState | null>(null)
  const projectSkillStatesRef = useRef(projectSkillStates)
  const shellRef = useRef<HTMLDivElement>(null)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const appSidebarRef = useRef<HTMLElement>(null)
  const sidebarSplitterRef = useRef<HTMLDivElement>(null)
  const sidebarResizeActive = useRef(false)

  // --- Workspace mutation helpers (centralized `setChatWorkspace`) / 工作区变更辅助（统一走 setChatWorkspace）---

  const updateChatWorkspace = useCallback((update: (prev: ChatWorkspaceState) => ChatWorkspaceState) => {
    setChatWorkspace((prev) => (prev ? update(prev) : prev))
  }, [])

  const updateShowProjectSkillsInSidebar = useCallback((enabled: boolean) => {
    setShowProjectSkillsInSidebar(enabled)
    writeStoredBoolean(SIDEBAR_PROJECT_SKILLS_STORAGE_KEY, enabled)
  }, [])

  const updateThreadRunState = useCallback((threadId: string, state: ThreadRunState | null) => {
    setThreadRunStates((prev) => {
      const current = prev[threadId]
      if (!state) {
        if (!current) return prev
        const next = { ...prev }
        delete next[threadId]
        return next
      }
      if (
        current?.requestId === state.requestId &&
        current.status === state.status &&
        current.updatedAt === state.updatedAt
      ) {
        return prev
      }
      return { ...prev, [threadId]: state }
    })
  }, [])

  // --- Desktop bridge: mirror `locale` into desktop prefs + tray strings / 桌面桥：将 locale 写入桌面偏好与托盘文案 ---

  useEffect(() => {
    if (!window.desktop?.setDesktopPreferences) return
    void window.desktop.setDesktopPreferences({ locale })
    void window.desktop.syncTrayLocale?.(locale)
  }, [locale])

  useEffect(() => {
    if (!window.desktop?.getDesktopPreferences) return
    let cancelled = false
    void window.desktop.getDesktopPreferences().then((prefs) => {
      if (!cancelled) applyEyeComfortPreference(prefs)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    initialModelTouchedRef.current = initialModelTouched
  }, [initialModelTouched])

  // --- Derived handles: active project/thread powering chat chrome / 派生句柄：驱动聊天框架的当前项目与线程 ---

  const activeProject =
    chatWorkspace?.projects.find((project) => project.id === chatWorkspace.activeProjectId) ??
    chatWorkspace?.projects[0]
  const explicitActiveThread =
    chatWorkspace && activeProject
      ? chatWorkspace.threads.find(
          (thread) =>
            thread.id === chatWorkspace.activeThreadId &&
            thread.projectId === activeProject.id,
        )
      : undefined
  const activeThread =
    explicitActiveThread ??
    (chatWorkspace?.activeThreadId && activeProject
      ? latestVisibleThreadForProject(chatWorkspace, activeProject.id)
      : undefined)
  const projectSkillProjectKey = useMemo(
    () => chatWorkspace?.projects.map((project) => `${project.id}:${project.path}`).join('\n') ?? '',
    [chatWorkspace?.projects],
  )

  const projectIdsKey = useMemo(
    () => chatWorkspace?.projects.map((project) => project.id).sort().join('\n') ?? '',
    [chatWorkspace?.projects],
  )

  const threadIdsKey = useMemo(
    () => chatWorkspace?.threads.map((thread) => thread.id).sort().join('\n') ?? '',
    [chatWorkspace?.threads],
  )

  const sidebarCollapsed = chatWorkspace?.sidebarPrefs.collapsed ?? false
  const isWindows = typeof window !== 'undefined' && window.desktop?.platform === 'win32'
  const initialProviderPresets = useMemo(
    () => normalizePresetCatalog(LOCAL_PROVIDER_PRESET_CATALOG, locale).providers,
    [locale],
  )

  // --- Prune stored maps when projects disappear; keep collapsed ids consistent / 项目删除后裁剪存储映射；折叠 id 列表保持一致 ---

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
    if (!projectIdsKey) return
    updateChatWorkspace((prev) => {
      const allowed = new Set(prev.projects.map((project) => project.id))
      const filtered = prev.sidebarPrefs.collapsedProjectIds.filter((id) => allowed.has(id))
      if (filtered.length === prev.sidebarPrefs.collapsedProjectIds.length) return prev
      return {
        ...prev,
        sidebarPrefs: { ...prev.sidebarPrefs, collapsedProjectIds: filtered },
      }
    })
  }, [projectIdsKey, updateChatWorkspace])

  // --- Hydrate workspace from persistence (Electron file + localStorage merge) / 从持久化恢复工作区（Electron 文件与 localStorage 合并）---

  useEffect(() => {
    let cancelled = false
    void loadChatWorkspaceState().then((state) => {
      if (!cancelled) setChatWorkspace(state)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const applyInitialModelSnapshot = useCallback(
    (snapshot: ClaudeAgentSettingsSnapshot) => {
      if (initialModelTouchedRef.current) return
      const provider = selectInitialModelProvider(snapshot)
      const localizedProvider = provider ? localizeProviderPresetName(provider, initialProviderPresets) : undefined
      setInitialModelForm({
        presetId: localizedProvider?.presetId ?? '',
        name: localizedProvider?.name ?? '',
        apiKeyUrl: localizedProvider?.apiKeyUrl ?? '',
        authMode: localizedProvider?.authMode ?? 'apiKey',
        apiKey: localizedProvider?.apiKey ?? '',
        baseUrl: localizedProvider?.baseUrl ?? '',
        model: localizedProvider?.model ?? '',
        modelSupportsImages: localizedProvider?.modelSupportsImages ?? false,
        haikuModel: localizedProvider?.defaultHaikuModel ?? '',
        haikuSupportsImages: localizedProvider?.defaultHaikuSupportsImages ?? false,
        sonnetModel:
          localizedProvider?.defaultSonnetModel ?? localizedProvider?.model ?? '',
        sonnetSupportsImages:
          localizedProvider?.defaultSonnetSupportsImages ?? localizedProvider?.modelSupportsImages ?? false,
        opusModel: localizedProvider?.defaultOpusModel ?? '',
        opusSupportsImages: localizedProvider?.defaultOpusSupportsImages ?? false,
      })
      setInitialModelStatus(t('shell.initModelLoaded'))
    },
    [initialProviderPresets, t],
  )

  useEffect(() => {
    if (!chatWorkspace || chatWorkspace.projects.length > 0) return
    if (!window.claudeChat) {
      setInitialModelStatus(t('shell.initModelBridgeUnavailable'))
      return
    }

    let cancelled = false
    setInitialModelStatus(t('shell.initModelLoading'))
    void window.claudeChat
      .getSettings()
      .then((snapshot) => {
        if (cancelled) return
        applyInitialModelSnapshot(snapshot)
      })
      .catch((error) => {
        if (cancelled) return
        setInitialModelStatus(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
    }
  }, [applyInitialModelSnapshot, chatWorkspace, t])

  // --- Watch active project folder on disk (`pathMissing` badge in UI) / 监视当前项目目录是否存在（侧栏 pathMissing 标记）---

  useEffect(() => {
    if (!chatWorkspace || !activeProject) return
    const validate = window.desktop?.validateProjectPaths
    if (!validate) return

    let cancelled = false
    void validate([activeProject.path]).then((results) => {
      if (cancelled) return
      const missing = results[activeProject.path] === false
      if (missing === Boolean(activeProject.pathMissing)) return
      updateChatWorkspace((prev) => ({
        ...prev,
        projects: prev.projects.map((project) =>
          project.id === activeProject.id ? { ...project, pathMissing: missing || undefined } : project,
        ),
      }))
    })

    return () => {
      cancelled = true
    }
  }, [activeProject?.id, activeProject?.path, activeProject?.pathMissing, chatWorkspace, updateChatWorkspace])

  // --- GC: strip orphan skill/run maps after thread & project deletes / 垃圾回收：删除线程/项目后移除孤儿技能与运行态 ---

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

    setThreadRunStates((current) => {
      const threadIds = new Set(chatWorkspace.threads.map((thread) => thread.id))
      let changed = false
      const next: Record<string, ThreadRunState> = {}
      for (const [threadId, state] of Object.entries(current)) {
        if (!threadIds.has(threadId)) {
          changed = true
          continue
        }
        next[threadId] = state
      }
      return changed ? next : current
    })
  }, [projectSkillProjectKey, threadIdsKey, chatWorkspace])

  useEffect(() => {
    projectSkillStatesRef.current = projectSkillStates
  }, [projectSkillStates])

  // --- Sidebar skills rail: debounced `listAgentContext` scan per project / 侧栏技能：按项目惰性扫描 listAgentContext ---

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

  // --- Autosave: debounce `persistChatWorkspaceState` + flush on unmount / 自动保存：防抖写入 persist，并在卸载时刷盘 ---

  const flushWorkspaceSave = useCallback(() => {
    if (workspaceSaveInFlightRef.current) return
    const pending = pendingWorkspaceSaveRef.current
    if (!pending) return

    pendingWorkspaceSaveRef.current = null
    workspaceSaveInFlightRef.current = true
    void persistChatWorkspaceState(pending).finally(() => {
      workspaceSaveInFlightRef.current = false
      if (pendingWorkspaceSaveRef.current) flushWorkspaceSave()
    })
  }, [])

  useEffect(() => {
    if (!chatWorkspace) return
    if (workspaceClearedRef.current && isEmptyChatWorkspace(chatWorkspace)) {
      return
    }
    workspaceClearedRef.current = false
    pendingWorkspaceSaveRef.current = chatWorkspace
    if (workspaceSaveTimerRef.current != null) {
      window.clearTimeout(workspaceSaveTimerRef.current)
    }
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      workspaceSaveTimerRef.current = null
      flushWorkspaceSave()
    }, CHAT_WORKSPACE_SAVE_DEBOUNCE_MS)
  }, [chatWorkspace, flushWorkspaceSave])

  useEffect(() => {
    return () => {
      if (workspaceSaveTimerRef.current != null) {
        window.clearTimeout(workspaceSaveTimerRef.current)
        workspaceSaveTimerRef.current = null
      }
      flushWorkspaceSave()
    }
  }, [flushWorkspaceSave])

  // --- Routing helper: strip hash to return to main workspace chrome / 路由辅助：清空 hash 回到主工作区框架 ---

  const goHome = useCallback(() => {
    window.location.hash = ''
  }, [])

  const handleWorkspaceCleared = useCallback(() => {
    workspaceClearedRef.current = true
    if (workspaceSaveTimerRef.current != null) {
      window.clearTimeout(workspaceSaveTimerRef.current)
      workspaceSaveTimerRef.current = null
    }
    pendingWorkspaceSaveRef.current = null
    setChatWorkspace(createDefaultChatWorkspaceState())
    setProjectSkillStates({})
    setThreadRunStates({})
    setSelectedProjectSkill(null)
    setHomeModeResetKey((value) => value + 1)
    setHeaderStatus(t('shell.headerDefault'))
    window.location.hash = ''
  }, [t])

  // --- Chat/workspace reducers: merge transcript updates and CRUD threads/projects / 归约器：合并聊天内容并增删改线程与项目 ---

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
      setSelectedProjectSkill(null)
      updateChatWorkspace((prev) => {
        const thread = prev.threads.find((item) => item.id === threadId)
        if (!thread) return prev
        return {
          ...prev,
          activeProjectId: thread.projectId,
          activeThreadId: thread.id,
        }
      })
      goHome()
    },
    [goHome, updateChatWorkspace],
  )

  const createThreadInProject = useCallback(
    (projectId?: string) => {
      setSelectedProjectSkill(null)
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

  const createHomePluginCardThread = useCallback(
    (projectId: string, initialPrompt: string) => {
      setSelectedProjectSkill(null)
      const threadId = createId('thread')
      const now = Date.now()
      updateChatWorkspace((prev) => {
        if (!prev.projects.some((project) => project.id === projectId)) return prev
        const nextThread: WorkspaceThread = {
          id: threadId,
          projectId,
          title: deriveDataCardThreadTitle(initialPrompt, t),
          purpose: 'home-plugin-card-customization',
          createdAt: now,
          updatedAt: now,
          chatState: createEmptyChatState(),
        }
        return {
          ...prev,
          activeProjectId: projectId,
          activeThreadId: threadId,
          projects: touchProject(prev.projects, projectId, now),
          threads: [nextThread, ...prev.threads],
        }
      })
      goHome()
      return threadId
    },
    [goHome, t, updateChatWorkspace],
  )

  const openHomePluginCardThread = useCallback(
    (projectId: string, item: HomePluginRunItem) => {
      setSelectedProjectSkill(null)
      let threadId = ''
      let createdThread = false
      const now = Date.now()
      const boundThreadId = item.manifest.threadId?.trim()

      updateChatWorkspace((prev) => {
        if (!prev.projects.some((project) => project.id === projectId)) return prev
        const existing = boundThreadId
          ? prev.threads.find((thread) => thread.id === boundThreadId && thread.projectId === projectId && !thread.archivedAt)
          : undefined
        if (existing) {
          threadId = existing.id
          return {
            ...prev,
            activeProjectId: projectId,
            activeThreadId: existing.id,
          }
        }

        threadId = createId('thread')
        createdThread = true
        const nextThread: WorkspaceThread = {
          id: threadId,
          projectId,
          title: t('thread.homePluginCardEditTitle', { name: item.manifest.name }),
          purpose: 'home-plugin-card-customization',
          homePluginSlug: item.slug,
          createdAt: now,
          updatedAt: now,
          chatState: createEmptyChatState(),
        }
        return {
          ...prev,
          activeProjectId: projectId,
          activeThreadId: threadId,
          projects: touchProject(prev.projects, projectId, now),
          threads: [nextThread, ...prev.threads],
        }
      })
      goHome()

      void (async () => {
        if (threadId && createdThread) await window.claudeChat?.newThread(threadId)
        requestAnimationFrame(() => {
          if (!threadId || !createdThread) {
            void chatRef.current?.focusComposer()
            return
          }
          const prompt = buildEditHomePluginCardPrompt(item, threadId)
          const submit = chatRef.current?.submitPromptInThread(projectId, threadId, prompt, 'home-plugin-card-customization')
          if (!submit) {
            void chatRef.current?.focusComposer()
            return
          }
          void submit.then((submitted) => {
            if (!submitted) void chatRef.current?.focusComposer()
          })
        })
      })()
    },
    [goHome, t, updateChatWorkspace],
  )

  const runProjectSkill = useCallback(
    (projectId: string, skill: ProjectSkillRunRequest) => {
      setSelectedProjectSkill(null)
      if (!chatWorkspace?.projects.some((project) => project.id === projectId)) {
        createThreadInProject(projectId)
        return
      }
      const threadId = createId('thread')
      const now = Date.now()
      const prompt = skill.title

      updateChatWorkspace((prev) => {
        if (!prev.projects.some((project) => project.id === projectId)) return prev
        const nextThread: WorkspaceThread = {
          id: threadId,
          projectId,
          title: t('thread.newThreadTitle'),
          purpose: 'skill-run',
          skillPath: skill.path,
          skillCommand: skill.command,
          skillTitle: skill.title,
          createdAt: now,
          updatedAt: now,
          chatState: createEmptyChatState(),
        }
        return {
          ...prev,
          activeProjectId: projectId,
          activeThreadId: threadId,
          projects: touchProject(prev.projects, projectId, now),
          threads: [nextThread, ...prev.threads],
        }
      })
      goHome()

      requestAnimationFrame(() => {
        void (async () => {
          await window.claudeChat?.newThread(threadId)
          const submitted = await chatRef.current?.submitPromptInThread(projectId, threadId, prompt)
          if (!submitted) setHeaderStatus(t('shell.headerProcessingThread'))
        })()
      })
    },
    [chatWorkspace?.projects, createThreadInProject, goHome, t, updateChatWorkspace],
  )

  const stopProjectSkillRun = useCallback(
    async (projectId: string, skillPath: string) => {
      const runningThread = chatWorkspace?.threads
        .filter((thread) => thread.projectId === projectId && thread.purpose === 'skill-run' && thread.skillPath === skillPath && !thread.archivedAt)
        .filter((thread) => Boolean(threadRunStates[thread.id]))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const requestId = runningThread ? threadRunStates[runningThread.id]?.requestId : undefined
      if (!requestId || requestId.startsWith('pending-') || !window.claudeChat) return
      await window.claudeChat.cancel(requestId)
    },
    [chatWorkspace?.threads, threadRunStates],
  )

  const selectProject = useCallback(
    (projectId: string) => {
      setSelectedProjectSkill(null)
      setHomeModeResetKey((value) => value + 1)
      updateChatWorkspace((prev) => {
        if (!prev.projects.some((project) => project.id === projectId)) return prev
        return {
          ...prev,
          activeProjectId: projectId,
          activeThreadId: '',
        }
      })
      goHome()
    },
    [goHome, updateChatWorkspace],
  )

  const createProjectFromExistingPath = useCallback(
    (projectPath: string) => {
      const value = projectPath.trim()
      if (!value) return

      const now = Date.now()
      const projectId = createId('project')
      const scratchDefault = t('project.scratchDefaultName')
      const project: WorkspaceProject = {
        id: projectId,
        name: pathBasename(value, scratchDefault),
        path: value,
        createdAt: now,
        updatedAt: now,
      }

      setSelectedProjectSkill(null)
      updateChatWorkspace((prev) => ({
        ...prev,
        activeProjectId: projectId,
        activeThreadId: '',
        projects: [project, ...prev.projects],
        threads: prev.threads,
        sidebarPrefs: {
          ...prev.sidebarPrefs,
          projectOrderIds: [projectId, ...projectIdsForSidebar(prev.projects, prev.sidebarPrefs.projectOrderIds)],
        },
      }))
      goHome()
      requestAnimationFrame(() => void chatRef.current?.focusComposer())
    },
    [goHome, t, updateChatWorkspace],
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

      if (mode === 'existing') {
        createProjectFromExistingPath(value)
        return
      }

      const now = Date.now()
      const projectId = createId('project')
      const name = value
      const project: WorkspaceProject = {
        id: projectId,
        name,
        path: `~/Projects/${name}`,
        createdAt: now,
        updatedAt: now,
      }

      setSelectedProjectSkill(null)
      updateChatWorkspace((prev) => ({
        ...prev,
        activeProjectId: projectId,
        activeThreadId: '',
        projects: [project, ...prev.projects],
        threads: prev.threads,
        sidebarPrefs: {
          ...prev.sidebarPrefs,
          projectOrderIds: [projectId, ...projectIdsForSidebar(prev.projects, prev.sidebarPrefs.projectOrderIds)],
        },
      }))
      goHome()
      requestAnimationFrame(() => void chatRef.current?.focusComposer())
    },
    [createProjectFromExistingPath, goHome, updateChatWorkspace, t],
  )

  const updateInitialModelField = useCallback(
    <K extends keyof InitialModelFormState>(field: K, value: InitialModelFormState[K]) => {
      setInitialModelEnabled(true)
      setInitialModelTouched(true)
      setInitialModelForm((current) => ({ ...current, [field]: value }))
    },
    [],
  )

  const chooseInitialProviderPreset = useCallback(
    (preset: ProviderPreset) => {
      setInitialModelEnabled(true)
      setInitialModelTouched(true)
      setInitialModelForm({
        presetId: preset.id,
        name: preset.name,
        apiKeyUrl: preset.apiKeyUrl,
        authMode: preset.authMode,
        apiKey: '',
        baseUrl: preset.baseUrl,
        model: preset.model,
        modelSupportsImages: preset.modelSupportsImages,
        haikuModel: preset.defaultHaikuModel,
        haikuSupportsImages: preset.defaultHaikuSupportsImages,
        sonnetModel: preset.defaultSonnetModel,
        sonnetSupportsImages: preset.defaultSonnetSupportsImages,
        opusModel: preset.defaultOpusModel,
        opusSupportsImages: preset.defaultOpusSupportsImages,
      })
      setInitialModelStatus(t('shell.initModelProviderSelected', { name: preset.name }))
    },
    [t],
  )

  const chooseInitialCustomProvider = useCallback(() => {
    setInitialModelEnabled(true)
    setInitialModelTouched(true)
    setInitialModelForm(createInitialModelFormState())
    setInitialModelStatus(t('shell.initModelCustomSelected'))
  }, [t])

  const skipInitialModelSetup = useCallback(() => {
    setInitialModelEnabled(false)
    setInitialModelStatus(t('shell.initModelSkipped'))
  }, [t])

  const openInitialModelApiKeyLink = useCallback((event: ReactMouseEvent<HTMLAnchorElement>, url: string) => {
    if (!window.desktop?.openExternal) return
    event.preventDefault()
    void window.desktop.openExternal(url)
  }, [])

  const pickInitialProjectFolder = useCallback(async () => {
    let value: string | undefined
    if (window.desktop?.pickProjectDirectory) {
      value = (await window.desktop.pickProjectDirectory())?.trim()
    } else {
      value = window.prompt(t('project.promptExistingPath'), '')?.trim()
    }
    if (!value) return
    setInitialProjectPath(value)
    setInitialModelStatus(t('shell.initProjectSelected'))
  }, [t])

  const saveInitialModelSettings = useCallback(async () => {
    if (!initialModelEnabled || !hasInitialModelInput(initialModelForm)) {
      return true
    }
    if (!window.claudeChat) {
      setInitialModelStatus(t('shell.initModelBridgeUnavailable'))
      return false
    }

    const primaryModel = initialModelForm.model.trim() || initialModelForm.sonnetModel.trim()
    const sonnetModel = initialModelForm.sonnetModel.trim()
    const haikuModel = initialModelForm.haikuModel.trim()
    const opusModel = initialModelForm.opusModel.trim()
    const selectedModel = sonnetModel || primaryModel || opusModel || haikuModel
    if (!selectedModel) {
      setInitialModelStatus(t('shell.initModelRequired'))
      return false
    }
    if (!initialModelForm.apiKey.trim()) {
      setInitialModelStatus(t('shell.initModelApiKeyRequired'))
      return false
    }

    setInitialModelBusy(true)
    setInitialModelStatus(t('shell.initModelSaving'))

    try {
      const snapshot = await window.claudeChat.getSettings()
      const providers = snapshot.settings.providers.length
        ? snapshot.settings.providers.map((provider) => ({ ...provider }))
        : [createInitialModelProvider()]
      const activeId = providers.some((provider) => provider.id === snapshot.settings.activeProviderId)
        ? snapshot.settings.activeProviderId
        : providers[0].id

      const nextProviders = providers.map((provider) =>
        provider.id === activeId
          ? {
              ...provider,
              presetId: initialModelForm.presetId,
              name: initialModelForm.name.trim(),
              apiKeyUrl: initialModelForm.apiKeyUrl.trim(),
              authMode: initialModelForm.authMode,
              apiKey: initialModelForm.apiKey.trim(),
              authToken: '',
              baseUrl: initialModelForm.baseUrl.trim(),
              model: primaryModel || selectedModel,
              modelSupportsImages: initialModelForm.modelSupportsImages,
              defaultHaikuModel: haikuModel,
              defaultHaikuSupportsImages: initialModelForm.haikuSupportsImages,
              defaultSonnetModel: sonnetModel || selectedModel,
              defaultSonnetSupportsImages: initialModelForm.sonnetSupportsImages,
              defaultOpusModel: opusModel,
              defaultOpusSupportsImages: initialModelForm.opusSupportsImages,
            }
          : provider,
      )

      const nextSnapshot = await window.claudeChat.saveSettings({
        configSource: 'settings',
        activeProviderId: activeId,
        activeAnthropicModel: selectedModel,
        providers: nextProviders,
      })
      window.dispatchEvent(new CustomEvent(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, { detail: nextSnapshot }))
      applyInitialModelSnapshot(nextSnapshot)
      setInitialModelStatus(t('shell.initModelSaved'))
      return true
    } catch (error) {
      setInitialModelStatus(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setInitialModelBusy(false)
    }
  }, [applyInitialModelSnapshot, initialModelEnabled, initialModelForm, t])

  const startInitialSetup = useCallback(
    async (event: ReactFormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!initialProjectPath.trim()) {
        setInitialModelStatus(t('shell.initProjectRequired'))
        return
      }
      const saved = await saveInitialModelSettings()
      if (!saved) return
      createProjectFromExistingPath(initialProjectPath)
    },
    [createProjectFromExistingPath, initialProjectPath, saveInitialModelSettings, t],
  )

  // --- OS tray: default locale once + wire menu actions (new thread / open project) / 系统托盘：初始化语言并绑定新建会话与打开项目 ---

  useEffect(() => {
    void window.desktop?.syncTrayLocale?.(getInitialLocale())
  }, [])

  useEffect(() => {
    const onWorkspaceCleared = () => {
      handleWorkspaceCleared()
    }
    window.addEventListener(CHAT_WORKSPACE_CLEARED_EVENT, onWorkspaceCleared)
    return () => window.removeEventListener(CHAT_WORKSPACE_CLEARED_EVENT, onWorkspaceCleared)
  }, [handleWorkspaceCleared])

  useEffect(() => {
    const subscribe = window.desktop?.onTrayMenuAction
    if (!subscribe) return
    return subscribe((action) => {
      if (!chatWorkspace) return
      if (action === 'new-thread') {
        createThreadInProject()
      } else if (action === 'open-project') {
        void createProject('existing')
      }
    })
  }, [chatWorkspace, createProject, createThreadInProject])

  // --- Home plugin tasks: mirror background threads opened from the panel / 首页插件任务：同步面板打开的后台线程 ---

  const ensureTaskRunThread = useCallback(
    (event: HomePluginTaskEvent) => {
      if (!event.thread) return
      const seed = event.thread
      updateChatWorkspace((prev) => {
        const project =
          prev.projects.find((item) => item.id === seed.projectId) ??
          prev.projects.find((item) => sameProjectPath(item.path, event.projectPath))
        if (!project) return prev

        const now = Date.now()
        const existing = prev.threads.find((thread) => thread.id === seed.id)
        const title = seed.title || (event.task.mode === 'agent' ? '执行agent' : `执行${event.task.title}`)
        if (existing) {
          const nextUpdatedAt = Math.max(existing.updatedAt, seed.updatedAt || now)
          if (
            existing.projectId === project.id &&
            existing.title === title &&
            existing.purpose === 'task-run' &&
            existing.homePluginSlug === event.slug &&
            existing.updatedAt === nextUpdatedAt
          ) {
            return prev
          }
          const nextThreads = prev.threads.map((thread) =>
            thread.id === seed.id
              ? {
                  ...thread,
                  projectId: project.id,
                  title,
                  purpose: 'task-run' as const,
                  homePluginSlug: event.slug,
                  updatedAt: nextUpdatedAt,
                }
              : thread,
          )
          return { ...prev, threads: nextThreads }
        }

        const nextThread: WorkspaceThread = {
          id: seed.id,
          projectId: project.id,
          title,
          purpose: 'task-run',
          homePluginSlug: event.slug,
          createdAt: seed.createdAt || now,
          updatedAt: seed.updatedAt || now,
          chatState: createEmptyChatState(),
        }
        return {
          ...prev,
          projects: touchProject(prev.projects, project.id, now),
          threads: [nextThread, ...prev.threads],
        }
      })
    },
    [updateChatWorkspace],
  )

  useEffect(() => {
    const subscribe = window.desktop?.onHomePluginTaskEvent
    if (!subscribe) return
    return subscribe((event) => {
      ensureTaskRunThread(event)
    })
  }, [ensureTaskRunThread])

  const archiveThread = useCallback(
    async (threadId: string) => {
      const target = chatWorkspace?.threads.find((thread) => thread.id === threadId)
      if (!target || target.archivedAt) return

      if (target.purpose === 'task-run' && target.homePluginSlug) {
        const project = chatWorkspace?.projects.find((item) => item.id === target.projectId)
        if (project?.path && window.desktop?.stopTaskHomePlugin) {
          try {
            await window.desktop.stopTaskHomePlugin(project.path, target.homePluginSlug)
          } catch {
            /* stop is best-effort when archiving a running task */
          }
        }
      } else if (target.purpose === 'skill-run') {
        const requestId = threadRunStates[target.id]?.requestId
        if (requestId && !requestId.startsWith('pending-') && window.claudeChat) {
          try {
            await window.claudeChat.cancel(requestId)
          } catch {
            /* stop is best-effort when archiving a running Skill */
          }
        }
      }

      updateChatWorkspace((prev) => {
        const current = prev.threads.find((thread) => thread.id === threadId)
        if (!current || current.archivedAt) return prev

        const now = Date.now()
        const nextThreads = prev.threads.map((thread) =>
          thread.id === threadId ? { ...thread, archivedAt: now, updatedAt: now } : thread,
        )
        if (prev.activeThreadId !== threadId) {
          return { ...prev, threads: nextThreads }
        }

        const nextState: ChatWorkspaceState = { ...prev, threads: nextThreads }
        const nextActive = latestVisibleThreadForProject(nextState, current.projectId)

        if (nextActive) {
          return {
            ...nextState,
            activeProjectId: nextActive.projectId,
            activeThreadId: nextActive.id,
          }
        }

        return {
          ...nextState,
          activeProjectId: current.projectId,
          activeThreadId: '',
        }
      })
      setSelectedProjectSkill(null)
      goHome()
    },
    [chatWorkspace, goHome, threadRunStates, updateChatWorkspace],
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
    updateChatWorkspace((prev) => {
      const target = prev.projects.find((project) => project.id === projectId)
      if (!target) return prev

      const currentOrder = projectIdsForSidebar(prev.projects, prev.sidebarPrefs.projectOrderIds)
      const nextOrder = target.pinnedAt
        ? currentOrder
        : [projectId, ...currentOrder.filter((id) => id !== projectId)]

      return {
        ...prev,
        projects: prev.projects.map((project) =>
          project.id === projectId
            ? { ...project, pinnedAt: project.pinnedAt ? undefined : now, updatedAt: now }
            : project,
        ),
        sidebarPrefs: {
          ...prev.sidebarPrefs,
          projectOrderIds: nextOrder,
        },
      }
    })
  }, [updateChatWorkspace])

  const reorderProject = useCallback((projectId: string, targetProjectId: string, position: 'before' | 'after') => {
    updateChatWorkspace((prev) => {
      if (projectId === targetProjectId) return prev
      const projectIds = new Set(prev.projects.map((project) => project.id))
      if (!projectIds.has(projectId) || !projectIds.has(targetProjectId)) return prev

      const currentOrder = projectIdsForSidebar(prev.projects, prev.sidebarPrefs.projectOrderIds)
      const withoutDragged = currentOrder.filter((id) => id !== projectId)
      const targetIndex = withoutDragged.indexOf(targetProjectId)
      if (targetIndex === -1) return prev

      const insertIndex = position === 'before' ? targetIndex : targetIndex + 1
      const nextOrder = [...withoutDragged.slice(0, insertIndex), projectId, ...withoutDragged.slice(insertIndex)]
      if (nextOrder.join('\n') === currentOrder.join('\n')) return prev

      return {
        ...prev,
        sidebarPrefs: {
          ...prev.sidebarPrefs,
          projectOrderIds: nextOrder,
        },
      }
    })
  }, [updateChatWorkspace])

  const toggleSidebarCollapsed = useCallback(() => {
    updateChatWorkspace((prev) => ({
      ...prev,
      sidebarPrefs: { ...prev.sidebarPrefs, collapsed: !prev.sidebarPrefs.collapsed },
    }))
  }, [updateChatWorkspace])

  const toggleSidebarProjectCollapsed = useCallback((projectId: string) => {
    updateChatWorkspace((prev) => {
      const nextIds = new Set(prev.sidebarPrefs.collapsedProjectIds)
      if (nextIds.has(projectId)) nextIds.delete(projectId)
      else nextIds.add(projectId)
      return {
        ...prev,
        sidebarPrefs: { ...prev.sidebarPrefs, collapsedProjectIds: [...nextIds] },
      }
    })
  }, [updateChatWorkspace])

  const removeProject = useCallback(
    (projectId: string) => {
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
          activeThreadId = ''
        }

        return {
          ...prev,
          projects: nextProjects,
          threads: nextThreads,
          activeProjectId,
          activeThreadId,
          sidebarPrefs: {
            ...prev.sidebarPrefs,
            collapsedProjectIds: prev.sidebarPrefs.collapsedProjectIds.filter((id) => id !== projectId),
            projectOrderIds: prev.sidebarPrefs.projectOrderIds.filter((id) => id !== projectId),
          },
        }
      })
      if (!didRemove) return
      setSelectedProjectSkill((current) => (current?.projectId === projectId ? null : current))
      goHome()
    },
    [goHome, updateChatWorkspace],
  )

  const revealProjectInFileManager = useCallback((projectPath: string) => {
    void window.desktop?.showItemInFolder?.(projectPath)
  }, [])

  const relocateProject = useCallback(
    async (projectId: string) => {
      let value: string | undefined
      if (window.desktop?.pickProjectDirectory) {
        value = (await window.desktop.pickProjectDirectory())?.trim()
      } else {
        value = window.prompt(t('project.promptExistingPath'), '')?.trim()
      }
      if (!value) return

      const now = Date.now()
      updateChatWorkspace((prev) => ({
        ...prev,
        projects: prev.projects.map((project) =>
          project.id === projectId
            ? { ...project, path: value, pathMissing: undefined, updatedAt: now }
            : project,
        ),
      }))
    },
    [t, updateChatWorkspace],
  )

  const hideProjectSkill = useCallback((projectId: string, skillPath: string) => {
    setHiddenSkillPathsByProject((prev) => {
      const existing = prev[projectId] ?? []
      if (existing.includes(skillPath)) return prev
      const next = { ...prev, [projectId]: [...existing, skillPath] }
      writeHiddenSkillPathsMap(next)
      return next
    })
    setSelectedProjectSkill((current) =>
      current?.projectId === projectId && current.path === skillPath ? null : current,
    )
  }, [])

  const selectProjectSkill = useCallback((projectId: string, skill: Omit<SelectedProjectSkill, 'projectId'>) => {
    setSelectedProjectSkill({ ...skill, projectId })
  }, [])

  const handleThreadPromptSubmit = useCallback((threadId: string, prompt: string) => {
    setSelectedProjectSkill(null)
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

  // --- Read CSS length tokens, clamp sidebar, persist user width / 读取 CSS 长度 token、夹紧侧栏宽度并持久化用户宽度 ---

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
        /* 私密模式或禁用存储时忽略 / Ignore when storage is blocked (private mode, etc.) */
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

  const openSettingsCategory = useCallback(
    (category: SettingsCategoryId) => {
      flushSync(() => {
        setActiveViewId('settings')
        setSettingsCategory(category)
      })

      const nextHash = `settings/${category}`
      const currentHash = window.location.hash.replace(/^#\/?/, '')
      if (currentHash !== nextHash) {
        window.location.hash = nextHash
      } else {
        syncHistoryButtons()
      }
    },
    [syncHistoryButtons],
  )

  // --- `hashchange` → settings view; keep back/forward mirrors in sync / hash 变化映射到设置视图；同步前进后退按钮态 ---

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

  // --- On boot, reapply stored sidebar width token / 启动时重新应用已保存的侧栏宽度 ---

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      if (!raw) return
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) applySidebarWidthPx(n)
    } catch {
      /* 私密模式或禁用存储时忽略 / Ignore when storage is blocked (private mode, etc.) */
    }
  }, [applySidebarWidthPx])

  // --- Splitter drag: pointer capture translates to sidebar width delta / 分割条拖拽：指针捕获映射为侧栏宽度增量 ---

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
      /* 旧版 Chromium 可能抛错；无捕获时仍可用 mousemove 兜底 / Older Chromium may throw; move handlers still work */
    }
  }

  // --- Title region: settings category vs “project · thread” on home / 标题区：设置分类与首页「项目 · 线程」---

  const workspaceTitle = useMemo(() => {
    if (activeViewId === 'settings') return t(settingsWorkspaceTitleKey(settingsCategory))
    if (activeViewId === 'home') {
      const projectName = activeProject?.name.trim()
      const threadTitle = activeThread?.title.trim()
      if (projectName && threadTitle) return `${projectName} · ${threadTitle}`
      if (projectName) return projectName
    }
    return t(VIEW_HEADING_KEYS[activeViewId])
  }, [activeProject?.name, activeThread?.title, activeViewId, settingsCategory, t])

  // --- Render gates: wait for data; empty workspace CTA; guard missing project / 渲染门控：等待数据；空工作区引导；缺少项目则短路 ---

  if (!chatWorkspace) {
    return null
  }

  const initialProjectComplete = Boolean(initialProjectPath.trim())
  const initialSetupReady = initialProjectComplete && !initialModelBusy
  const initialProjectName = initialProjectPath ? pathBasename(initialProjectPath, t('shell.initProjectFolderTitle')) : ''
  const initialModelSummary = buildInitialModelSummary(initialModelForm)
  const initialProviderSelectValue = !initialModelEnabled
    ? INITIAL_PROVIDER_SKIP_VALUE
    : initialModelForm.presetId || INITIAL_PROVIDER_CUSTOM_VALUE
  const selectedInitialProviderPreset = initialModelEnabled && initialModelForm.presetId
    ? initialProviderPresets.find((preset) => preset.id === initialModelForm.presetId)
    : undefined
  const initialProviderSelectMeta = !initialModelEnabled
    ? initialModelSummary
      ? t('shell.initModelCurrentConfig', { summary: initialModelSummary })
      : t('shell.initModelSkipMeta')
    : selectedInitialProviderPreset
      ? selectedInitialProviderPreset.baseUrl
      : t('settings.models.customProviderMeta')
  const initialModelUsesCustomProvider = initialModelEnabled && !initialModelForm.presetId
  const initialModelRows = [
    {
      key: 'haiku',
      label: t('settings.models.fieldHaiku'),
      hint: t('settings.models.fieldHaikuHint'),
      inputId: 'init-model-haiku',
      field: 'haikuModel' as const,
      value: initialModelForm.haikuModel,
      supportField: 'haikuSupportsImages' as const,
      supportsImages: initialModelForm.haikuSupportsImages,
    },
    {
      key: 'sonnet',
      label: t('settings.models.fieldSonnet'),
      hint: t('settings.models.fieldSonnetHint'),
      inputId: 'init-model-sonnet',
      field: 'sonnetModel' as const,
      value: initialModelForm.sonnetModel,
      supportField: 'sonnetSupportsImages' as const,
      supportsImages: initialModelForm.sonnetSupportsImages,
    },
    {
      key: 'opus',
      label: t('settings.models.fieldOpus'),
      hint: t('settings.models.fieldOpusHint'),
      inputId: 'init-model-opus',
      field: 'opusModel' as const,
      value: initialModelForm.opusModel,
      supportField: 'opusSupportsImages' as const,
      supportsImages: initialModelForm.opusSupportsImages,
    },
  ]

  if (chatWorkspace.projects.length === 0) {
    return (
      <div className="app-shell app-shell-empty" id="app-shell">
        <form className="app-shell-empty__panel no-drag" onSubmit={(event) => void startInitialSetup(event)}>
          <header className="app-shell-empty__header">
            <span className="app-shell-empty__eyebrow">{t('shell.initEyebrow')}</span>
            <h1>{t('shell.emptyWorkspaceHeading')}</h1>
            <p>{t('shell.emptyWorkspaceBody')}</p>
          </header>

          <div className="app-shell-empty__flow" aria-label={t('shell.initFlowAria')}>
            <section className="app-shell-empty__step app-shell-empty__step--project" aria-labelledby="init-project-title">
              <div className="app-shell-empty__step-heading">
                <span className="app-shell-empty__step-index">1</span>
                <div>
                  <h2 id="init-project-title">{t('shell.initProjectTitle')}</h2>
                  <p>{t('shell.initProjectBody')}</p>
                </div>
              </div>
              <button
                type="button"
                className={`app-shell-empty__project-preview${initialProjectComplete ? ' is-selected' : ''}`}
                onClick={() => void pickInitialProjectFolder()}
                disabled={initialModelBusy}
              >
                <IconInline name="folder" />
                <div>
                  <strong>{t('shell.initProjectFolderTitle')}</strong>
                  <span>{initialProjectName ? initialProjectPath : t('shell.initProjectFolderHint')}</span>
                </div>
              </button>
            </section>

            <section className="app-shell-empty__step app-shell-empty__step--model" aria-labelledby="init-model-title">
              <div className="app-shell-empty__step-heading">
                <span className="app-shell-empty__step-index">2</span>
                <div>
                  <h2 id="init-model-title">{t('shell.initModelTitle')}</h2>
                  <p>{t('shell.initModelBody')}</p>
                </div>
              </div>

              <div className="app-shell-empty__provider-select-block">
                <label htmlFor="init-provider-select" className="app-shell-empty__provider-select-label">
                  {t('settings.models.addProviderDialogTitle')}
                </label>
                <div className="app-shell-empty__provider-select-wrap">
                  <select
                    id="init-provider-select"
                    className="app-shell-empty__provider-select"
                    value={initialProviderSelectValue}
                    aria-label={t('shell.initModelPresetAria')}
                    disabled={initialModelBusy}
                    onChange={(event) => {
                      const value = event.target.value
                      if (value === INITIAL_PROVIDER_SKIP_VALUE) {
                        skipInitialModelSetup()
                        return
                      }
                      if (value === INITIAL_PROVIDER_CUSTOM_VALUE) {
                        chooseInitialCustomProvider()
                        return
                      }
                      const preset = initialProviderPresets.find((item) => item.id === value)
                      if (preset) chooseInitialProviderPreset(preset)
                    }}
                  >
                    <option value={INITIAL_PROVIDER_SKIP_VALUE}>{t('shell.initModelSkipTitle')}</option>
                    {initialProviderPresets.map((preset) => (
                      <option value={preset.id} key={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                    <option value={INITIAL_PROVIDER_CUSTOM_VALUE}>{t('settings.models.customProvider')}</option>
                  </select>
                  <span className="app-shell-empty__provider-select-chevron" aria-hidden="true">
                    <IconInline name="chevron" />
                  </span>
                </div>
                <p className="app-shell-empty__provider-select-meta">{initialProviderSelectMeta}</p>
              </div>

              {initialModelEnabled ? (
                <>
                  {!initialModelUsesCustomProvider ? (
                    <p className="app-shell-empty__preset-hint">{t('shell.initModelPresetHiddenHint')}</p>
                  ) : null}
                  <div className="settings-group settings-group--provider-fields app-shell-empty__model-fields">
                    {initialModelUsesCustomProvider ? (
                      <div className="settings-field-row">
                        <div className="settings-field-row__meta">
                          <label htmlFor="init-model-provider-name" className="settings-field-row__label">
                            <IconInline name="settings" />
                            {t('settings.models.fieldName')}
                          </label>
                          <p className="settings-field-row__hint">{t('settings.models.fieldNameHint')}</p>
                        </div>
                        <input
                          id="init-model-provider-name"
                          type="text"
                          className="settings-input"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={t('settings.models.fieldNamePlaceholder')}
                          value={initialModelForm.name}
                          onChange={(event) => updateInitialModelField('name', event.target.value)}
                          disabled={initialModelBusy}
                        />
                      </div>
                    ) : null}
                    <div className="settings-field-row">
                      <div className="settings-field-row__meta">
                        <label htmlFor="init-model-api-key" className="settings-field-row__label">
                          <IconInline name="key" />
                          {t('settings.models.fieldApiKey')}
                        </label>
                        {/* <p className="settings-field-row__hint">{t('settings.models.fieldApiKeyHint')}</p> */}
                        {initialModelForm.apiKeyUrl ? (
                          <a
                            className="settings-api-key-link"
                            href={initialModelForm.apiKeyUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => openInitialModelApiKeyLink(event, initialModelForm.apiKeyUrl)}
                          >
                            {t('settings.models.getApiKey')}
                          </a>
                        ) : null}
                      </div>
                      <input
                        id="init-model-api-key"
                        type="password"
                        className="settings-input"
                        autoComplete="off"
                        spellCheck={false}
                        value={initialModelForm.apiKey}
                        onChange={(event) => updateInitialModelField('apiKey', event.target.value)}
                        disabled={initialModelBusy}
                      />
                    </div>
                    {initialModelUsesCustomProvider ? (
                      <div className="settings-field-row">
                        <div className="settings-field-row__meta">
                          <label htmlFor="init-model-base-url" className="settings-field-row__label">
                            <IconInline name="server" />
                            {t('settings.models.fieldBaseUrl')}
                          </label>
                          <p className="settings-field-row__hint">{t('settings.models.fieldBaseUrlHint')}</p>
                        </div>
                        <input
                          id="init-model-base-url"
                          type="url"
                          className="settings-input"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={t('shell.initModelBaseUrlPlaceholder')}
                          value={initialModelForm.baseUrl}
                          onChange={(event) => updateInitialModelField('baseUrl', event.target.value)}
                          disabled={initialModelBusy}
                        />
                      </div>
                    ) : null}
                    {initialModelUsesCustomProvider ? (
                      <div className="settings-model-map" aria-label={t('settings.models.modelMappingsAria')}>
                        {initialModelRows.map((row) => (
                          <div className="settings-field-row settings-model-row" key={row.key}>
                            <div className="settings-field-row__meta">
                              <label htmlFor={row.inputId} className="settings-field-row__label">
                                <IconInline name="chip" />
                                {row.label}
                              </label>
                              <p className="settings-field-row__hint">{row.hint}</p>
                            </div>
                            <input
                              id={row.inputId}
                              type="text"
                              className="settings-input"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t('shell.initModelIdPlaceholder')}
                              value={row.value}
                              onChange={(event) => updateInitialModelField(row.field, event.target.value)}
                              disabled={initialModelBusy}
                            />
                            <label
                              className="settings-model-image-toggle"
                              title={t('settings.models.modelImageToggleTitle', { slot: row.label })}
                            >
                              <span className="settings-model-image-toggle__glyph" aria-hidden="true">
                                <IconInline name="image" />
                              </span>
                              <span className="settings-switch-control">
                                <input
                                  type="checkbox"
                                  className="settings-switch-input"
                                  checked={row.supportsImages}
                                  aria-label={t('settings.models.modelImageToggleAria', { slot: row.label })}
                                  onChange={(event) => updateInitialModelField(row.supportField, event.target.checked)}
                                  disabled={initialModelBusy}
                                />
                                <span className="settings-switch-track" aria-hidden="true">
                                  <span className="settings-switch-thumb" />
                                </span>
                              </span>
                            </label>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </section>
          </div>

          <footer className="app-shell-empty__footer">
            <p className="app-shell-empty__status" role="status">
              {initialModelStatus || t('shell.initModelIdle')}
            </p>
            <button type="submit" className="btn btn-primary app-shell-empty__submit" disabled={!initialSetupReady}>
              <IconInline name="check" />
              <span>{initialModelBusy ? t('shell.initModelSaving') : t('shell.initSubmit')}</span>
            </button>
          </footer>
        </form>
      </div>
    )
  }

  if (!activeProject) {
    return null
  }

  // --- Primary layout once a project exists: sidebar rail + workspace stack / 存在项目后的主布局：侧栏轨道 + 工作区堆叠 ---

  return (
    <div
      className={`app-shell${isWindows ? ' is-platform-win32' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${activeViewId === 'settings' ? ' is-shell-settings' : ''}`}
      id="app-shell"
      ref={shellRef}
    >
      <div className="app-body" ref={appBodyRef}>
        <AppShellSidebar
          activeViewId={activeViewId}
          settingsCategory={settingsCategory}
          projects={chatWorkspace.projects}
          projectOrderIds={chatWorkspace.sidebarPrefs.projectOrderIds}
          threads={chatWorkspace.threads}
          threadRunStates={threadRunStates}
          activeProjectId={chatWorkspace.activeProjectId}
          activeThreadId={chatWorkspace.activeThreadId}
          collapsedProjectIds={chatWorkspace.sidebarPrefs.collapsedProjectIds}
          showProjectSkills={showProjectSkillsInSidebar}
          projectSkillStates={projectSkillStates}
          selectedProjectSkill={selectedProjectSkill}
          hiddenSkillPathsByProject={hiddenSkillPathsByProject}
          canBack={canBack}
          canForward={canForward}
          onCreateProject={createProject}
          onOpenSearch={() => window.dispatchEvent(new CustomEvent('agentos:open-search', { detail: { scope: 'all' } }))}
          onOpenSettingsCategory={openSettingsCategory}
          onSelectProject={selectProject}
          onSelectThread={selectThread}
          onSelectProjectSkill={selectProjectSkill}
          onRunProjectSkill={runProjectSkill}
          onToggleThreadPinned={toggleThreadPinned}
          onArchiveThread={archiveThread}
          onToggleProjectPinned={toggleProjectPinned}
          onReorderProject={reorderProject}
          onToggleSidebarProjectCollapsed={toggleSidebarProjectCollapsed}
          onRemoveProject={removeProject}
          onRelocateProject={(projectId) => void relocateProject(projectId)}
          onRevealProjectInFileManager={revealProjectInFileManager}
          onHideProjectSkill={hideProjectSkill}
          onToggleCollapsed={toggleSidebarCollapsed}
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
          threads={chatWorkspace.threads}
          projects={chatWorkspace.projects}
          projectOrderIds={chatWorkspace.sidebarPrefs.projectOrderIds}
          threadRunStates={threadRunStates}
          chatRef={chatRef}
          onStatusChange={setHeaderStatus}
          onNewThread={createThreadInProject}
          onCreateProject={createProject}
          onSelectProject={selectProject}
          onSelectThread={selectThread}
          onThreadChatStateChange={updateThreadChatState}
          onThreadPromptSubmit={handleThreadPromptSubmit}
          onThreadRunStateChange={updateThreadRunState}
          homeModeResetKey={homeModeResetKey}
          onCreateHomePluginCardThread={createHomePluginCardThread}
          onEditHomePluginCard={openHomePluginCardThread}
          hiddenSkillPaths={hiddenSkillPathsByProject[activeProject.id] ?? []}
          projectSkills={projectSkillStates[activeProject.id]?.skills ?? []}
          onRunProjectSkill={runProjectSkill}
          onStopProjectSkillRun={stopProjectSkillRun}
          showProjectSkillsInSidebar={showProjectSkillsInSidebar}
          onShowProjectSkillsInSidebarChange={updateShowProjectSkillsInSidebar}
        />
      </div>
    </div>
  )
}

// --- File-level utilities (pure helpers below `AppShell`) / 文件级工具函数（`AppShell` 下方的纯函数）---

function resolveChatStateUpdate(
  prev: ChatState,
  update: ChatState | ((prev: ChatState) => ChatState),
): ChatState {
  return typeof update === 'function' ? update(prev) : update
}

function touchProject(projects: WorkspaceProject[], projectId: string, time = Date.now()): WorkspaceProject[] {
  return projects.map((project) => (project.id === projectId ? { ...project, updatedAt: time } : project))
}

function deriveDataCardThreadTitle(prompt: string, t: (path: string, vars?: Record<string, string | number>) => string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (!normalized) return t('thread.homePluginCardCreateTitle')
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized
}

function buildEditHomePluginCardPrompt(item: HomePluginRunItem, threadId: string): string {
  const pluginDir = `.agents/home-plugins/${item.slug}`
  return [
    `请修改数据卡片：${item.manifest.name}`,
    `当前专用 threadId：${threadId}`,
    `目标插件目录：${pluginDir}`,
    '',
    '开始前请先读取：',
    `${pluginDir}/manifest.json`,
    `${pluginDir}/extractor.js`,
    '',
    '要求：只修改这一张卡片，不要创建或改写其他 Home Plugin；修改后保持 small / medium / large 三种响应式展示契约。',
  ].join('\n')
}

function titleFromPrompt(prompt: string, fallbackTitle: string): string {
  const firstLine = prompt.trim().split(/\n/)[0]?.trim() || fallbackTitle
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}...` : firstLine
}

function pathBasename(path: string, fallback: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path || fallback
}

function sameProjectPath(a: string, b: string): boolean {
  return normalizeComparablePath(a) === normalizeComparablePath(b)
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function createInitialModelFormState(): InitialModelFormState {
  return {
    presetId: '',
    name: '',
    apiKeyUrl: '',
    authMode: 'apiKey',
    apiKey: '',
    baseUrl: '',
    model: '',
    modelSupportsImages: false,
    haikuModel: '',
    haikuSupportsImages: false,
    sonnetModel: '',
    sonnetSupportsImages: false,
    opusModel: '',
    opusSupportsImages: false,
  }
}

function hasInitialModelInput(form: InitialModelFormState): boolean {
  return [
    form.name,
    form.apiKey,
    form.baseUrl,
    form.model,
    form.haikuModel,
    form.sonnetModel,
    form.opusModel,
  ].some((value) => value.trim())
}

function buildInitialModelSummary(form: InitialModelFormState): string {
  return [form.name, form.sonnetModel || form.model || form.opusModel || form.haikuModel, form.baseUrl]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' · ')
}

function createInitialModelProvider(): ClaudeAgentModelProvider {
  return {
    id: createId('provider'),
    presetId: '',
    name: '',
    apiKeyUrl: '',
    authMode: 'apiKey',
    apiKey: '',
    authToken: '',
    baseUrl: '',
    model: '',
    modelSupportsImages: false,
    defaultHaikuModel: '',
    defaultHaikuSupportsImages: false,
    defaultOpusModel: '',
    defaultOpusSupportsImages: false,
    defaultSonnetModel: '',
    defaultSonnetSupportsImages: false,
  }
}

function selectInitialModelProvider(snapshot: ClaudeAgentSettingsSnapshot): ClaudeAgentModelProvider | undefined {
  return (
    snapshot.settings.providers.find((provider) => provider.id === snapshot.settings.activeProviderId) ??
    snapshot.settings.providers[0]
  )
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

function applyEyeComfortPreference(prefs: Pick<DesktopPreferences, 'eyeComfortMode'>) {
  document.documentElement.classList.toggle(EYE_COMFORT_CLASS, prefs.eyeComfortMode)
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

function isEmptyChatWorkspace(state: ChatWorkspaceState): boolean {
  return (
    state.activeProjectId === '' &&
    state.activeThreadId === '' &&
    state.projects.length === 0 &&
    state.threads.length === 0
  )
}
