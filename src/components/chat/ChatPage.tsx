/**
 * 对话页：Composer、模型/权限选择、Agent 事件流与线程状态同步。
 * Chat surface coordinating composer, model/permission pickers, Agent IPC stream, and per-thread state.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import type {
  AgentContextCatalog,
  AgentContextSource,
  ClaudeChatAttachment,
  ClaudeAgentModelProvider,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
  ClaudeChatEvent,
  ClaudeChatSubmitPayload,
  ClaudePermissionMode,
  ProjectFileSearchItem,
} from '../../claude-chat-types'
import type { HomePluginRunItem } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'
import type {
  ChatActivityItem,
  ChatFileDiffItem,
  ChatMessageAttachment,
  ChatMessageItem,
  ChatState,
  ChatThinkingItem,
  ChatToolItem,
  ThreadRunState,
  TranscriptItem,
  WorkspaceProject,
  WorkspaceThread,
} from '../types'
import { AgentInputPromptModal, type PendingUserInputPrompt, type UserInputDecision } from './AgentInputPromptModal'
import { ChatStartView } from './ChatStartView'
import { ChatThreadView } from './ChatThreadView'
import { Composer } from './Composer'
import type { BuiltInSlashCommand, ChatModelMenuRow, ComposerSuggestion, ComposerTrigger, PermissionModeRow } from './local-types'

const SETTINGS_CHANGED_EVENT = 'claude-agent-settings:changed'
const PROCESS_TRACE_TOGGLE_EVENT = 'chat-process-trace:toggle'
const MAX_COMPOSER_SUGGESTIONS = 64
const MAX_COMPOSER_ATTACHMENTS = 8

// --- Imperative handle / 命令式句柄 ---

export type ChatPageHandle = {
  startNewThread: () => Promise<void>
  focusComposer: () => void
  submitPromptInNewThread: (projectId: string, prompt: string) => Promise<boolean>
  submitPromptInThread: (
    projectId: string,
    threadId: string,
    prompt: string,
    promptMode?: ClaudeChatSubmitPayload['promptMode'],
  ) => Promise<boolean>
}

type ChatPageProps = {
  hidden: boolean
  activeProject: WorkspaceProject
  activeThread: WorkspaceThread | undefined
  /** 按 threadId 查找持久化 sessionId（重启后恢复 SDK）/ Threads list for resolving persisted session ids */
  threads: WorkspaceThread[]
  projects: WorkspaceProject[]
  threadRunStates: Record<string, ThreadRunState>
  onStatusChange: (text: string) => void
  onNewThread: (projectId?: string) => string | void
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
  onThreadRunStateChange: (threadId: string, state: ThreadRunState | null) => void
  agentModeEnabled: boolean
  todoEnabled: boolean
  agentModeLoading: boolean
  homeModeResetKey: number
  onCreateHomePluginCardThread: (projectId: string, initialPrompt: string) => string | void
  onEditHomePluginCard: (projectId: string, item: HomePluginRunItem) => void
}

// --- Internal helpers / 模块内辅助 ---

type SubmitPromptTarget = {
  threadId?: string
  project?: WorkspaceProject
  promptMode?: ClaudeChatSubmitPayload['promptMode']
  reuseUserMessageId?: string
  resetSession?: boolean
}

/** 内置 slash 命令清单 / Built-in slash commands backed by i18n strings */
function getBuiltInSlashCommands(t: (path: string, vars?: Record<string, string | number>) => string): BuiltInSlashCommand[] {
  return [
    {
      kind: 'built-in',
      command: 'compact',
      title: t('chat.slashCompactTitle'),
      description: t('chat.slashCompactDesc'),
      argumentHint: '[instructions]',
    },
    {
      kind: 'built-in',
      command: 'status',
      title: t('chat.slashStatusTitle'),
      description: t('chat.slashStatusDesc'),
      argumentHint: '',
    },
    {
      kind: 'built-in',
      command: 'help',
      title: t('chat.slashHelpTitle'),
      description: t('chat.slashHelpDesc'),
      argumentHint: '',
    },
  ]
}

/** 为「数据卡片」Home Plugin 起草阶段拼装的系统提示词 / System prompt for creating a single data-card Home Plugin */
function buildDataCardPrompt(userRequest: string, threadId: string): string {
  return [
    '请基于下面的需求，只创建一张独立的数据卡片 Home Plugin。',
    `当前专用 threadId：${threadId}`,
    '要求：选择合适的小/中/大尺寸，在 manifest.json 写入 preferredSize、kind: "data"、threadId、createdAt、updatedAt；不要一次生成多张卡片。',
    '',
    '用户需求：',
    userRequest,
  ].join('\n')
}

/** 将线程用途映射到 `claudeChat.submit` 的 `promptMode` / Map thread `purpose` to SDK `promptMode` */
function promptModeForThreadPurpose(purpose: WorkspaceThread['purpose']): ClaudeChatSubmitPayload['promptMode'] | undefined {
  if (purpose === 'home-plugin-customization' || purpose === 'home-plugin-card-customization') return purpose
  if (purpose === 'task-run') return 'home-plugin-task-run'
  return undefined
}

const PERMISSION_MODE_STORAGE_KEY = 'codex-ui-template:claude-permission-mode'

/** 主聊天路由组件（forwardRef 暴露托盘动作）/ Primary chat route exposing imperative methods */
export const ChatPage = forwardRef<ChatPageHandle, ChatPageProps>(function ChatPage(
  {
    hidden,
    activeProject,
    activeThread,
    threads,
    projects,
    threadRunStates,
    onStatusChange,
    onNewThread,
    onThreadChatStateChange,
    onThreadPromptSubmit,
    onThreadRunStateChange,
    agentModeEnabled,
    todoEnabled,
    agentModeLoading,
    homeModeResetKey,
    onCreateHomePluginCardThread,
    onEditHomePluginCard,
  },
  ref,
) {
  // --- Local state & refs / 组件状态与引用 ---

  const { t } = useI18n()
  const chatItems = activeThread?.chatState.items ?? []
  const activeRunState = activeThread ? threadRunStates[activeThread.id] : undefined
  const isRunning = Boolean(activeRunState)
  const [inputValue, setInputValue] = useState('')
  const [isComposingText, setIsComposingText] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelMenuRows, setModelMenuRows] = useState<ChatModelMenuRow[]>([])
  const [modelMenuSelectionKey, setModelMenuSelectionKey] = useState('')
  const [activeModelSupportsImages, setActiveModelSupportsImages] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<ClaudeChatAttachment[]>([])
  const [agentContext, setAgentContext] = useState<AgentContextCatalog | null>(null)
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>(() => readStoredPermissionMode())
  const [permissionModeOpen, setPermissionModeOpen] = useState(false)
  const [pendingUserInputPrompts, setPendingUserInputPrompts] = useState<PendingUserInputPrompt[]>([])
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 })
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState('')
  const [fileMentionResults, setFileMentionResults] = useState<ProjectFileSearchItem[]>([])
  const [composerSuggestionIndex, setComposerSuggestionIndex] = useState(0)
  /** 与 Electron Claude 设置对齐；Composer 展示此标签 / Mirrors Electron agent settings label shown in composer */
  const [globalDisplayModel, setGlobalDisplayModel] = useState('Claude Agent')
  const [homeComposerMode, setHomeComposerMode] = useState<'normal' | 'data-card-draft'>('normal')

  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const permissionModePickerRef = useRef<HTMLDivElement>(null)
  const composerAutocompleteSurfaceRef = useRef<HTMLDivElement>(null)
  const modelPopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const modelPopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const permissionModePopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const permissionModePopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const activeThreadIdRef = useRef(activeThread?.id ?? '')
  const threadRunStatesRef = useRef<Record<string, ThreadRunState>>(threadRunStates)
  const requestThreadIdsRef = useRef(new Map<string, string>())
  const requestAssistantMessageIdsRef = useRef(new Map<string, string>())
  const requestStartedAtRef = useRef(new Map<string, number>())
  const finishedRequestIdsRef = useRef(new Set<string>())

  /** Popover anchor avoids clipping by `.chat-composer` / fixed positioning avoids composer clipping */
  const [modelPopoverBox, setModelPopoverBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const [permissionModePopoverBox, setPermissionModePopoverBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const scrollIntentRef = useRef<'none' | 'force-bottom'>('none')
  /** 取消 / Esc 关闭编辑时抑制贴底，避免 ResizeObserver 误判 isNearBottom 把视口滚到底 */
  const suppressTranscriptResizeStickRef = useRef(false)
  const suppressTranscriptResizeStickTimerRef = useRef<number | null>(null)
  const isFirstTranscriptLayoutRef = useRef(true)
  const isRunningRef = useRef(false)
  const globalDisplayModelRef = useRef(globalDisplayModel)

  const [composerAutocompleteBox, setComposerAutocompleteBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)

  const hasMessages = chatItems.length > 0
  const activeUserInputPrompt = pendingUserInputPrompts[0] ?? null
  const permissionModeRows = useMemo(() => getPermissionModeRows(t), [t])
  const permissionModeLabel = permissionModeRows.find((row) => row.mode === permissionMode)?.label ?? t('chat.permissionModeAuto')
  const setThreadChatState = useCallback(
    (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => {
      onThreadChatStateChange(threadId, update)
    },
    [onThreadChatStateChange],
  )

  // --- Agent context catalog (skills/agents for slash & @) / Agent 上下文目录（斜杠与 @ 联想数据来源） ---

  const refreshAgentContext = useCallback(async () => {
    const listAgentContext = window.desktop?.listAgentContext
    if (!listAgentContext) {
      setAgentContext(null)
      return
    }

    try {
      const result = await listAgentContext(activeProject.path)
      setAgentContext(result.ok ? result : null)
    } catch {
      setAgentContext(null)
    }
  }, [activeProject.path])

  // --- Effects: desktop IPC & settings sync / 副作用：桌面 IPC 与设置 ---

  useEffect(() => {
    void refreshAgentContext()
  }, [refreshAgentContext])

  useEffect(() => {
    threadRunStatesRef.current = threadRunStates
  }, [threadRunStates])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode)
  }, [permissionMode])

  useEffect(() => {
    globalDisplayModelRef.current = globalDisplayModel
  }, [globalDisplayModel])

  useEffect(() => {
    if (!activeRunState) return
    onStatusChange(activeRunState.status === 'waiting' ? t('chat.waitingForPermission') : t('chat.statusProcessing'))
  }, [activeRunState, onStatusChange, t])

  const applyGlobalModelFromSettings = useCallback(
    (snapshot: ClaudeAgentSettingsSnapshot) => {
      const settings = snapshot.settings
      const slots = {
        primary: t('chat.modelSlotPrimary'),
        haiku: t('chat.modelSlotHaiku'),
        sonnet: t('chat.modelSlotSonnet'),
        opus: t('chat.modelSlotOpus'),
      }

      setModelMenuRows(buildChatModelMenuRows(settings.providers, slots, t))
      setModelMenuSelectionKey(pickerSelectionKeyFromSettings(settings, t))

      const model = resolvedChatDisplayModel(settings, t)
      setGlobalDisplayModel(model)
      setActiveModelSupportsImages(resolvedChatSupportsImages(snapshot))

      if (!isRunningRef.current) {
        onStatusChange(compactModelName(model, t))
      }
    },
    [onStatusChange, t],
  )

  useEffect(() => {
    activeThreadIdRef.current = activeThread?.id ?? ''
    isFirstTranscriptLayoutRef.current = true
    scrollIntentRef.current = 'force-bottom'
    setShowScrollButton(false)
    setModelPickerOpen(false)
    setPendingAttachments([])

    window.claudeChat?.getSettings().then(applyGlobalModelFromSettings).catch(() => {
      /* 浏览器独立预览可能没有 Electron 桥接 / Browser preview may run without the Electron bridge */
    })
  }, [activeThread?.id, activeProject.id, applyGlobalModelFromSettings])

  useEffect(() => {
    setHomeComposerMode('normal')
  }, [homeModeResetKey])

  useEffect(() => {
    window.claudeChat?.getSettings().then(applyGlobalModelFromSettings).catch(() => {
      /* 浏览器独立预览可能没有 Electron 桥接 / Browser preview may run without the Electron bridge */
    })

    const onSettingsChanged = (event: Event) => {
      applyGlobalModelFromSettings((event as CustomEvent<ClaudeAgentSettingsSnapshot>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
  }, [applyGlobalModelFromSettings])

  // --- Composer autocomplete: slash commands, @mentions, debounced file search / 输入框联想：斜杠、@ 与防抖文件搜索 ---

  const activeComposerTrigger = useMemo(
    () => getComposerTrigger(inputValue, composerSelection.start, composerSelection.end),
    [composerSelection.end, composerSelection.start, inputValue],
  )
  const activeAutocompleteKey = activeComposerTrigger
    ? `${activeComposerTrigger.kind}:${activeComposerTrigger.start}:${activeComposerTrigger.query}`
    : ''
  const composerSuggestions = useMemo(
    () => buildComposerSuggestions(activeComposerTrigger, agentContext, fileMentionResults, t),
    [activeComposerTrigger, agentContext, fileMentionResults, t],
  )
  const composerAutocompleteOpen =
    Boolean(activeComposerTrigger) &&
    activeAutocompleteKey !== dismissedAutocompleteKey &&
    composerSuggestions.length > 0

  useEffect(() => {
    setComposerSuggestionIndex(0)
  }, [activeAutocompleteKey])

  useEffect(() => {
    if (activeComposerTrigger?.kind !== 'mention') {
      setFileMentionResults([])
      return
    }

    const searchProjectFiles = window.desktop?.searchProjectFiles
    if (!searchProjectFiles) {
      setFileMentionResults([])
      return
    }

    const query = activeComposerTrigger.query
    const timer = window.setTimeout(() => {
      searchProjectFiles(activeProject.path, query)
        .then((result) => setFileMentionResults(result.ok ? result.items : []))
        .catch(() => setFileMentionResults([]))
    }, 90)

    return () => window.clearTimeout(timer)
  }, [activeComposerTrigger, activeProject.path])

  useLayoutEffect(() => {
    if (!composerAutocompleteOpen || !chatInputRef.current) {
      setComposerAutocompleteBox(null)
      return
    }

    const gap = 8
    const pad = 8
    const maxListPx = 320

    const sync = () => {
      const input = chatInputRef.current
      if (!input) return
      const composer = input.closest('.chat-composer') ?? input
      const r = composer.getBoundingClientRect()
      const width = Math.min(Math.max(r.width, 280), window.innerWidth - pad * 2)
      let left = r.left
      if (left + width > window.innerWidth - pad) left = window.innerWidth - pad - width
      if (left < pad) left = pad
      const bottom = window.innerHeight - r.top + gap
      const maxHeight = Math.min(maxListPx, Math.max(120, r.top - pad - gap))
      setComposerAutocompleteBox({ left, bottom, width, maxHeight })
    }

    sync()
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      document.removeEventListener('scroll', sync, true)
    }
  }, [composerAutocompleteOpen, composerSuggestions.length])

  useEffect(() => {
    if (!composerAutocompleteOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const t = event.target as Node | null
      if (!t) return
      if (chatInputRef.current?.contains(t)) return
      if (composerAutocompleteSurfaceRef.current?.contains(t)) return
      setDismissedAutocompleteKey(activeAutocompleteKey)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [activeAutocompleteKey, composerAutocompleteOpen])

  // --- Model & permission pickers: floating position + click-outside / 模型与权限选择器：浮层定位与点击外部关闭 ---

  const pickChatMenuRow = useCallback(async (row: ChatModelMenuRow) => {
    if (!window.claudeChat || isRunningRef.current) return
    try {
      const snapshot = await window.claudeChat.setActiveChatPick({
        providerId: row.providerId,
        anthropicModel: row.useOverlayPick ? row.anthropicModelId : undefined,
      })
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: snapshot }))
      setModelPickerOpen(false)
    } catch {
      /* 设置写入失败时静默 / Ignore settings write failures */
    }
  }, [])

  useLayoutEffect(() => {
    if (!modelPickerOpen || !modelPopoverAnchorRef.current) {
      setModelPopoverBox(null)
      return
    }
    const gap = 6
    const pad = 8
    const maxListPx = 280

    const sync = () => {
      const anchor = modelPopoverAnchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const spaceAbove = r.top - pad
      const maxH = Math.min(maxListPx, Math.max(100, spaceAbove))
      const minWidth = Math.max(r.width, 248)
      const vw = window.innerWidth
      let width = Math.min(Math.max(minWidth, 260), vw - pad * 2)
      /** 右上角与按钮右上角对齐（面板右边贴按钮右边），再水平夹紧避免出屏 */
      let left = r.right - width
      if (left < pad) left = pad
      if (left + width > vw - pad) left = vw - pad - width
      const bottom = window.innerHeight - r.top + gap
      setModelPopoverBox({ left, bottom, width, maxHeight: maxH })
    }

    sync()
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      document.removeEventListener('scroll', sync, true)
    }
  }, [modelPickerOpen, modelMenuRows.length])

  useLayoutEffect(() => {
    if (!permissionModeOpen || !permissionModePopoverAnchorRef.current) {
      setPermissionModePopoverBox(null)
      return
    }
    const gap = 6
    const pad = 8
    const maxListPx = 260

    const sync = () => {
      const anchor = permissionModePopoverAnchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const spaceAbove = r.top - pad
      const maxH = Math.min(maxListPx, Math.max(120, spaceAbove))
      const minWidth = Math.max(r.width, 248)
      const vw = window.innerWidth
      let width = Math.min(Math.max(minWidth, 280), vw - pad * 2)
      let left = r.left
      if (left + width > vw - pad) left = vw - pad - width
      if (left < pad) left = pad
      const bottom = window.innerHeight - r.top + gap
      setPermissionModePopoverBox({ left, bottom, width, maxHeight: maxH })
    }

    sync()
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      document.removeEventListener('scroll', sync, true)
    }
  }, [permissionModeOpen, permissionModeRows.length])

  useEffect(() => {
    if (!modelPickerOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const t = event.target as Node | null
      if (!t) return
      if (modelPickerRef.current?.contains(t)) return
      if (modelPopoverSurfaceRef.current?.contains(t)) return
      setModelPickerOpen(false)
    }
    const onKeyDown = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') setModelPickerOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [modelPickerOpen])

  useEffect(() => {
    if (!permissionModeOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const t = event.target as Node | null
      if (!t) return
      if (permissionModePickerRef.current?.contains(t)) return
      if (permissionModePopoverSurfaceRef.current?.contains(t)) return
      setPermissionModeOpen(false)
    }
    const onKeyDown = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') setPermissionModeOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [permissionModeOpen])

  // --- Transcript region: stick to bottom, resize observer, “scroll to latest” chip / 会话区：吸底、ResizeObserver、回到底部按钮 ---

  const syncScrollButtonVisibility = useCallback(() => {
    const sr = scrollRegionRef.current
    if (!sr || sr.hidden) {
      setShowScrollButton(false)
      return
    }
    setShowScrollButton((prev) => shouldShowScrollToBottom(sr, prev))
  }, [])

  const suppressTranscriptResizeStick = useCallback((durationMs = 320) => {
    suppressTranscriptResizeStickRef.current = true
    if (suppressTranscriptResizeStickTimerRef.current !== null) {
      window.clearTimeout(suppressTranscriptResizeStickTimerRef.current)
    }
    suppressTranscriptResizeStickTimerRef.current = window.setTimeout(() => {
      suppressTranscriptResizeStickRef.current = false
      suppressTranscriptResizeStickTimerRef.current = null
    }, durationMs)
  }, [])

  const notifyUserMessageEditDismissed = useCallback(() => {
    suppressTranscriptResizeStick(280)
  }, [suppressTranscriptResizeStick])

  useEffect(() => {
    const onProcessTraceToggle = () => suppressTranscriptResizeStick(360)
    window.addEventListener(PROCESS_TRACE_TOGGLE_EVENT, onProcessTraceToggle)
    return () => window.removeEventListener(PROCESS_TRACE_TOGGLE_EVENT, onProcessTraceToggle)
  }, [suppressTranscriptResizeStick])

  useEffect(() => {
    return () => {
      if (suppressTranscriptResizeStickTimerRef.current !== null) {
        window.clearTimeout(suppressTranscriptResizeStickTimerRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr || !hasMessages) {
      isFirstTranscriptLayoutRef.current = false
      setShowScrollButton(false)
      return
    }
    const transcriptEl = sr.querySelector('.chat-transcript')
    if (transcriptEl?.querySelector('.chat-message-edit')) {
      scrollIntentRef.current = 'none'
      syncScrollButtonVisibility()
      return
    }
    if (suppressTranscriptResizeStickRef.current) {
      scrollIntentRef.current = 'none'
      syncScrollButtonVisibility()
      return
    }
    let stick = scrollIntentRef.current === 'force-bottom' || isNearBottom(sr)
    if (isFirstTranscriptLayoutRef.current) {
      stick = true
      isFirstTranscriptLayoutRef.current = false
    }
    scrollIntentRef.current = 'none'
    if (stick) {
      sr.scrollTo({ top: sr.scrollHeight, behavior: 'auto' })
      setShowScrollButton(false)
    } else {
      syncScrollButtonVisibility()
    }
  }, [activeThread?.chatState, hasMessages, syncScrollButtonVisibility])

  useEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr) return
    const onScroll = () => {
      if (!chatItems.length) return
      syncScrollButtonVisibility()
    }
    sr.addEventListener('scroll', onScroll, { passive: true })
    return () => sr.removeEventListener('scroll', onScroll)
  }, [chatItems.length, syncScrollButtonVisibility])

  useEffect(() => {
    const sr = scrollRegionRef.current
    const transcript = sr?.querySelector('.chat-transcript')
    if (!sr || !transcript || !hasMessages) return

    const ro = new ResizeObserver(() => {
      if (transcript.querySelector('.chat-message-edit')) {
        syncScrollButtonVisibility()
        return
      }
      if (suppressTranscriptResizeStickRef.current) {
        syncScrollButtonVisibility()
        return
      }
      if (scrollIntentRef.current === 'force-bottom' || isNearBottom(sr)) {
        sr.scrollTo({ top: sr.scrollHeight, behavior: 'auto' })
        setShowScrollButton(false)
        return
      }
      syncScrollButtonVisibility()
    })
    ro.observe(transcript)
    return () => ro.disconnect()
  }, [hasMessages, syncScrollButtonVisibility])

  // --- Composer `<textarea>` auto height (cap 180px) / 输入框自适应高度（上限 180px）---

  const resizeComposer = useCallback(() => {
    const ta = chatInputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
  }, [])

  useLayoutEffect(() => {
    resizeComposer()
  }, [inputValue, resizeComposer])

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const sr = scrollRegionRef.current
    if (!sr) return
    sr.scrollTo({ top: sr.scrollHeight, behavior })
    setShowScrollButton(false)
  }, [])

  // --- Submit target + run state bookkeeping (request id maps, finish/cleanup) / 提交目标与运行态簿记（requestId 映射、结束清理）---

  const getActiveSubmitTarget = useCallback((): SubmitPromptTarget | undefined => {
    if (!activeThread) return undefined
    const projectForThread = projects.find((project) => project.id === activeThread.projectId) ?? activeProject
    return {
      threadId: activeThread.id,
      project: projectForThread,
      promptMode: promptModeForThreadPurpose(activeThread.purpose),
    }
  }, [activeProject, activeThread, projects])

  const setThreadRunState = useCallback(
    (threadId: string, state: ThreadRunState | null) => {
      if (state) {
        threadRunStatesRef.current = { ...threadRunStatesRef.current, [threadId]: state }
      } else if (threadRunStatesRef.current[threadId]) {
        const next = { ...threadRunStatesRef.current }
        delete next[threadId]
        threadRunStatesRef.current = next
      }
      onThreadRunStateChange(threadId, state)
    },
    [onThreadRunStateChange],
  )

  const markRequestRunning = useCallback(
    (threadId: string, requestId: string, status: ThreadRunState['status'] = 'running') => {
      requestThreadIdsRef.current.set(requestId, threadId)
      const current = threadRunStatesRef.current[threadId]
      if (current && current.requestId !== requestId && !isPendingRequestId(current.requestId)) return
      if (current?.requestId === requestId && current.status === status) return
      const startedAt = current?.startedAt ?? requestStartedAtRef.current.get(requestId) ?? Date.now()
      requestStartedAtRef.current.set(requestId, startedAt)
      setThreadRunState(threadId, { requestId, status, startedAt, updatedAt: Date.now() })
    },
    [setThreadRunState],
  )

  const finishRequest = useCallback(
    (requestId: string, statusText: string, notify = false, clearPendingRun = false) => {
      let threadId = requestThreadIdsRef.current.get(requestId)
      if (!threadId) {
        for (const [candidateThreadId, runState] of Object.entries(threadRunStatesRef.current)) {
          if (runState.requestId === requestId) {
            threadId = candidateThreadId
            break
          }
        }
      }

      finishedRequestIdsRef.current.add(requestId)
      window.setTimeout(() => finishedRequestIdsRef.current.delete(requestId), 30_000)
      requestAssistantMessageIdsRef.current.delete(requestId)
      requestStartedAtRef.current.delete(requestId)
      requestThreadIdsRef.current.delete(requestId)
      setPendingUserInputPrompts((prev) => prev.filter((item) => item.requestId !== requestId))

      if (threadId) {
        const runState = threadRunStatesRef.current[threadId]
        if (!runState || runState.requestId === requestId || (clearPendingRun && isPendingRequestId(runState.requestId))) {
          setThreadRunState(threadId, null)
        }
      }

      if (!threadId || activeThreadIdRef.current === threadId) {
        onStatusChange(statusText)
      }
      if (notify) playAgentDoneSound()
    },
    [onStatusChange, setThreadRunState],
  )

  // --- Map every `ClaudeChatEvent` into `ChatState.items` / 将每条 SDK 事件折叠进对话时间线 items ---

  const handleClaudeEvent = useCallback(
    (event: ClaudeChatEvent) => {
      const knownRequestBeforeEvent = requestThreadIdsRef.current.has(event.requestId)
      const eventThreadId = event.threadId ?? requestThreadIdsRef.current.get(event.requestId) ?? activeThreadIdRef.current
      requestThreadIdsRef.current.set(event.requestId, eventThreadId)
      if (event.type === 'session_start') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => ({
          ...prev,
          sessionId: event.sessionId,
          model: event.model || globalDisplayModelRef.current,
          cwd: event.cwd,
        }))
        return
      }

      if (event.type === 'assistant_delta') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const messageId = event.messageId
          const startedAt = requestStartedAtRef.current.get(event.requestId) ?? Date.now()
          let { items } = prev
          const idx = items.findIndex((it) => it.type === 'message' && it.id === messageId)
          if (idx >= 0) {
            const it = items[idx] as ChatMessageItem
            const next = [...items]
            next[idx] = { ...it, content: it.content + event.text, status: 'streaming', startedAt: it.startedAt ?? startedAt }
            requestAssistantMessageIdsRef.current.set(event.requestId, messageId)
            return { ...prev, items: next }
          }

          const pendingId = requestAssistantMessageIdsRef.current.get(event.requestId)
          const pIdx = items.findIndex((it) => it.type === 'message' && it.id === pendingId && it.role === 'assistant')
          if (pIdx >= 0) {
            const it = items[pIdx] as ChatMessageItem
            const next = [...items]
            next[pIdx] = { ...it, id: messageId, content: it.content + event.text, status: 'streaming', startedAt: it.startedAt ?? startedAt }
            requestAssistantMessageIdsRef.current.set(event.requestId, messageId)
            return { ...prev, items: next }
          }

          if (!event.text) {
            requestAssistantMessageIdsRef.current.set(event.requestId, messageId)
            return prev
          }

          const msg: ChatMessageItem = {
            type: 'message',
            id: messageId,
            role: 'assistant',
            content: event.text,
            status: 'streaming',
            createdAt: startedAt,
            startedAt,
          }
          requestAssistantMessageIdsRef.current.set(event.requestId, messageId)
          return { ...prev, items: [...items, msg] }
        })
        return
      }

      if (event.type === 'thinking_start') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'thinking' && it.thinkingId === event.thinkingId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatThinkingItem
            next[idx] = { ...it, requestId: it.requestId ?? event.requestId, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatThinkingItem = {
            type: 'thinking',
            id: event.thinkingId,
            requestId: event.requestId,
            thinkingId: event.thinkingId,
            title: event.title,
            content: '',
            status: 'running',
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'thinking_delta') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'thinking' && it.thinkingId === event.thinkingId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatThinkingItem
            next[idx] = { ...it, requestId: it.requestId ?? event.requestId, content: it.content + event.text, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatThinkingItem = {
            type: 'thinking',
            id: event.thinkingId,
            requestId: event.requestId,
            thinkingId: event.thinkingId,
            title: 'Think',
            content: event.text,
            status: 'running',
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'thinking_done') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'thinking' && it.thinkingId === event.thinkingId)
          if (idx < 0) return prev
          const next = [...prev.items]
          const it = next[idx] as ChatThinkingItem
          next[idx] = { ...it, requestId: it.requestId ?? event.requestId, status: 'done' }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'tool_start') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const existingIdx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (existingIdx >= 0) {
            const next = [...prev.items]
            const it = next[existingIdx] as ChatToolItem
            next[existingIdx] = { ...it, requestId: it.requestId ?? event.requestId, inputPreview: event.inputPreview || it.inputPreview, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatToolItem = {
            type: 'tool',
            id: `tool-${event.toolUseId}`,
            requestId: event.requestId,
            toolUseId: event.toolUseId,
            name: event.name,
            inputPreview: event.inputPreview,
            status: 'running',
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'tool_update') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (idx < 0) return prev
          const next = [...prev.items]
          const it = next[idx] as ChatToolItem
          next[idx] = {
            ...it,
            requestId: it.requestId ?? event.requestId,
            inputPreview: event.inputPreview ?? it.inputPreview,
            detail: event.detail ?? it.detail,
          }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'tool_done') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (idx < 0) return prev
          const next = [...prev.items]
          const it = next[idx] as ChatToolItem
          next[idx] = { ...it, requestId: it.requestId ?? event.requestId, status: event.status, detail: event.detail ?? it.detail }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'ask_user_question' || event.type === 'permission_request') {
        markRequestRunning(eventThreadId, event.requestId, 'waiting')
        setPendingUserInputPrompts((prev) =>
          prev.some((item) => item.permissionRequestId === event.permissionRequestId) ? prev : [...prev, event],
        )
        if (activeThreadIdRef.current === eventThreadId) {
          onStatusChange(event.type === 'ask_user_question' ? t('chat.waitingForAnswer') : t('chat.waitingForPermission'))
        }
        return
      }

      if (event.type === 'agent_activity') {
        if (event.status === 'running') markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'activity' && it.id === event.activityId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatActivityItem
            next[idx] = {
              ...it,
              requestId: it.requestId ?? event.requestId,
              title: event.title,
              status: event.status,
              detail: event.detail,
              preview: event.preview,
            }
            return { ...prev, items: next }
          }
          const row: ChatActivityItem = {
            type: 'activity',
            id: event.activityId,
            requestId: event.requestId,
            title: event.title,
            status: event.status,
            detail: event.detail,
            preview: event.preview,
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'file_diff') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'file_diff' && it.changeSetId === event.changeSetId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatFileDiffItem
            next[idx] = {
              ...it,
              checkpointId: event.checkpointId ?? it.checkpointId,
              files: mergeDiffFiles(it.files, event.files),
              status: it.status === 'reverted' ? it.status : 'captured',
              detail: undefined,
            }
            return { ...prev, items: next }
          }
          const row: ChatFileDiffItem = {
            type: 'file_diff',
            id: event.changeSetId,
            requestId: event.requestId,
            changeSetId: event.changeSetId,
            checkpointId: event.checkpointId,
            files: event.files,
            status: 'captured',
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'file_rewind_result') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex(
            (it) => it.type === 'file_diff' && (!event.changeSetId || it.changeSetId === event.changeSetId),
          )
          if (idx < 0) return prev
          const next = [...prev.items]
          const it = next[idx] as ChatFileDiffItem
          next[idx] = { ...it, status: event.status === 'reverted' ? 'reverted' : 'error', detail: event.detail ?? it.detail }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'result') {
        const completedAt = Date.now()
        const requestStartedAt = requestStartedAtRef.current.get(event.requestId) ?? completedAt
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const expectedId = `assistant-${event.requestId}`
            const pendingId = requestAssistantMessageIdsRef.current.get(event.requestId)
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content =
                !item.content.trim() && event.result.trim() ? event.result : item.content
              const startedAt = item.startedAt ?? requestStartedAt
              return {
                ...item,
                content,
                status: 'done',
                startedAt,
                completedAt,
                durationMs: Math.max(0, completedAt - startedAt),
              }
            })
            const items: TranscriptItem[] =
              found || !event.result.trim()
                ? mapped
                : [
                    ...mapped,
                    {
                      type: 'message',
                      id: expectedId,
                      role: 'assistant',
                      content: event.result,
                      status: 'done',
                      createdAt: requestStartedAt,
                      startedAt: requestStartedAt,
                      completedAt,
                      durationMs: Math.max(0, completedAt - requestStartedAt),
                    },
                  ]
            return { ...prev, sessionId: event.sessionId, items }
          })
        })
        finishRequest(event.requestId, compactModelName(globalDisplayModelRef.current, t), true, !knownRequestBeforeEvent)
        return
      }

      if (event.type === 'error') {
        const completedAt = Date.now()
        const requestStartedAt = requestStartedAtRef.current.get(event.requestId) ?? completedAt
        if (activeThreadIdRef.current === eventThreadId) scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const pendingId = requestAssistantMessageIdsRef.current.get(event.requestId)
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content = !item.content.trim() ? event.message : item.content
              const startedAt = item.startedAt ?? requestStartedAt
              return {
                ...item,
                content,
                status: 'error',
                startedAt,
                completedAt,
                durationMs: Math.max(0, completedAt - startedAt),
              }
            })
            const itemsOut: TranscriptItem[] = found
              ? mapped
              : [
                  ...mapped,
                  {
                    type: 'message',
                    id: expectedId,
                    role: 'assistant',
                    content: event.message,
                    status: 'error',
                    createdAt: requestStartedAt,
                    startedAt: requestStartedAt,
                    completedAt,
                    durationMs: Math.max(0, completedAt - requestStartedAt),
                  },
                ]
            return { ...prev, items: itemsOut }
          })
        })
        finishRequest(
          event.requestId,
          event.code === 'missing_api_key' ? t('chat.missingApiKey') : t('chat.errorGeneric'),
          true,
          !knownRequestBeforeEvent,
        )
        return
      }

      if (event.type === 'cancelled') {
        const completedAt = Date.now()
        const requestStartedAt = requestStartedAtRef.current.get(event.requestId) ?? completedAt
        if (activeThreadIdRef.current === eventThreadId) scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const pendingId = requestAssistantMessageIdsRef.current.get(event.requestId)
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content = !item.content.trim() ? t('chat.stoppedBody') : item.content
              const startedAt = item.startedAt ?? requestStartedAt
              return {
                ...item,
                content,
                status: 'cancelled',
                startedAt,
                completedAt,
                durationMs: Math.max(0, completedAt - startedAt),
              }
            })
            const items: TranscriptItem[] = found
              ? mapped
              : [
                  ...mapped,
                  {
                    type: 'message',
                    id: expectedId,
                    role: 'assistant',
                    content: t('chat.stoppedBody'),
                    status: 'cancelled',
                    createdAt: requestStartedAt,
                    startedAt: requestStartedAt,
                    completedAt,
                    durationMs: Math.max(0, completedAt - requestStartedAt),
                  },
                ]
            return { ...prev, items }
          })
        })
        finishRequest(event.requestId, t('chat.stoppedStatus'), false, !knownRequestBeforeEvent)
      }
    },
    [finishRequest, markRequestRunning, onStatusChange, setThreadChatState, t],
  )

  useEffect(() => {
    const unsub = window.claudeChat?.onEvent((ev) => handleClaudeEvent(ev))
    return () => {
      unsub?.()
    }
  }, [handleClaudeEvent])

  // --- `submitPrompt`: optimistic user row, pending id → real `requestId`, bridge errors / 发送：乐观用户消息、pending id 对齐真实 requestId、桥接错误处理 ---

  const submitPrompt = async (
    rawText: string,
    target?: SubmitPromptTarget,
    attachmentsForSubmit: ClaudeChatAttachment[] = [],
  ) => {
    const text = rawText.trim()
    if (!text && attachmentsForSubmit.length === 0) return
    const projectForSubmit =
      target?.project ?? (activeThread ? projects.find((project) => project.id === activeThread.projectId) : undefined) ?? activeProject
    if (projectForSubmit.pathMissing) {
      onStatusChange(t('shell.projectPathMissingSubmitBlocked'))
      return
    }
    if (attachmentsForSubmit.some((attachment) => attachment.kind === 'image') && !activeModelSupportsImages) {
      onStatusChange(t('chat.imageInputDisabledStatus'))
      return
    }
    let submittingThreadId = target?.threadId ?? activeThreadIdRef.current
    if (!submittingThreadId) {
      const createdThreadId = onNewThread(projectForSubmit.id)
      if (!createdThreadId) return
      submittingThreadId = createdThreadId
      activeThreadIdRef.current = createdThreadId
      isFirstTranscriptLayoutRef.current = true
      scrollIntentRef.current = 'force-bottom'
    }
    if (threadRunStatesRef.current[submittingThreadId]) return

    const requestStartedAt = Date.now()
    const resumeSessionId = target?.resetSession
      ? undefined
      : threads.find((th) => th.id === submittingThreadId)?.chatState.sessionId

    const userMessage: ChatMessageItem = {
      type: 'message',
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      status: 'done',
      createdAt: requestStartedAt,
      completedAt: requestStartedAt,
      attachments: attachmentsForSubmit.map(toChatMessageAttachment),
    }

    if (activeThreadIdRef.current === submittingThreadId) scrollIntentRef.current = 'force-bottom'
    onThreadPromptSubmit(submittingThreadId, text)
    if (!target?.reuseUserMessageId) {
      setThreadChatState(submittingThreadId, (prev) => ({
        ...prev,
        items: [...prev.items, userMessage],
      }))
    }
    setInputValue('')
    if (!target?.threadId) setPendingAttachments([])
    const pendingRequestId = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    requestStartedAtRef.current.set(pendingRequestId, requestStartedAt)
    setThreadRunState(submittingThreadId, {
      requestId: pendingRequestId,
      status: 'running',
      startedAt: requestStartedAt,
      updatedAt: Date.now(),
    })
    onStatusChange(t('chat.statusProcessing'))

    if (!window.claudeChat) {
      if (activeThreadIdRef.current === submittingThreadId) scrollIntentRef.current = 'force-bottom'
      setThreadChatState(submittingThreadId, (prev) => ({
        ...prev,
        items: [
          ...prev.items,
          {
            type: 'message',
            id: `assistant-error-${Date.now()}`,
            role: 'assistant',
            content: t('chat.bridgeErrorBody'),
            status: 'error',
            createdAt: requestStartedAt,
            startedAt: requestStartedAt,
            completedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - requestStartedAt),
          },
        ],
      }))
      setThreadRunState(submittingThreadId, null)
      onStatusChange(t('chat.bridgeUnavailableStatus'))
      return
    }

    try {
      const submittingThread = threads.find((thread) => thread.id === submittingThreadId)
      const promptMode = target?.promptMode ?? promptModeForThreadPurpose(submittingThread?.purpose)
      const { requestId } = await window.claudeChat.submit({
        text,
        attachments: attachmentsForSubmit,
        threadId: submittingThreadId,
        promptMode,
        sessionId: resumeSessionId,
        cwd: projectForSubmit.path,
        permissionMode,
      })
      if (finishedRequestIdsRef.current.delete(requestId)) {
        requestThreadIdsRef.current.delete(requestId)
        requestAssistantMessageIdsRef.current.delete(requestId)
        requestStartedAtRef.current.delete(requestId)
        requestStartedAtRef.current.delete(pendingRequestId)
        const current = threadRunStatesRef.current[submittingThreadId] as ThreadRunState | undefined
        if (current && (current.requestId === requestId || current.requestId === pendingRequestId)) {
          setThreadRunState(submittingThreadId, null)
        }
        return
      }
      requestStartedAtRef.current.delete(pendingRequestId)
      requestStartedAtRef.current.set(requestId, requestStartedAt)
      requestThreadIdsRef.current.set(requestId, submittingThreadId)
      requestAssistantMessageIdsRef.current.set(requestId, `assistant-${requestId}`)
      setThreadRunState(submittingThreadId, { requestId, status: 'running', startedAt: requestStartedAt, updatedAt: Date.now() })
    } catch (error) {
      requestStartedAtRef.current.delete(pendingRequestId)
      if (activeThreadIdRef.current === submittingThreadId) scrollIntentRef.current = 'force-bottom'
      setThreadChatState(submittingThreadId, (prev) => ({
        ...prev,
        items: [
          ...prev.items,
          {
            type: 'message',
            id: `assistant-error-${Date.now()}`,
            role: 'assistant',
            content: error instanceof Error ? error.message : String(error),
            status: 'error',
            createdAt: requestStartedAt,
            startedAt: requestStartedAt,
            completedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - requestStartedAt),
          },
        ],
      }))
      setThreadRunState(submittingThreadId, null)
      onStatusChange(t('chat.sendFailedStatus'))
    }
  }

  // --- Generative UI can dispatch follow-up user text / 生成式 UI 可派发后续用户文案 ---

  useEffect(() => {
    const submitWidgetMessage = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text
      if (typeof text !== 'string' || !text.trim()) return
      void submitPrompt(text)
    }
    window.addEventListener('generative-ui:send-message', submitWidgetMessage)
    return () => window.removeEventListener('generative-ui:send-message', submitWidgetMessage)
  })

  // --- Transcript actions: clipboard + edit user message (branch & resubmit) / 消息区：剪贴板与编辑用户消息后重发 ---

  const copyMessage = useCallback(
    async (text: string) => {
      const ok = await writeClipboardText(text)
      onStatusChange(ok ? t('chat.copiedMessage') : t('chat.copyFailed'))
    },
    [onStatusChange, t],
  )

  const editUserMessage = (messageId: string, text: string) => {
    if (isRunningRef.current) return
    const nextText = text.trim()
    if (!nextText) return

    const threadId = activeThreadIdRef.current
    if (!threadId) return

    const projectForSubmit =
      activeThread ? projects.find((project) => project.id === activeThread.projectId) ?? activeProject : activeProject

    const currentItems = threads.find((thread) => thread.id === threadId)?.chatState.items ?? activeThread?.chatState.items ?? []
    if (!currentItems.some((item) => item.type === 'message' && item.role === 'user' && item.id === messageId)) return

    const editedAt = Date.now()
    setThreadChatState(threadId, (prev) => {
      const idx = prev.items.findIndex((item) => item.type === 'message' && item.role === 'user' && item.id === messageId)
      if (idx < 0) return prev
      const item = prev.items[idx] as ChatMessageItem
      const nextItems = prev.items.slice(0, idx + 1)
      nextItems[idx] = {
        ...item,
        content: nextText,
        status: 'done',
        createdAt: item.createdAt ?? editedAt,
        completedAt: editedAt,
      }
      return {
        ...prev,
        sessionId: undefined,
        items: nextItems,
      }
    })

    scrollIntentRef.current = 'force-bottom'
    void (async () => {
      await window.claudeChat?.newThread(threadId)
      await submitPrompt(nextText, {
        threadId,
        project: projectForSubmit,
        reuseUserMessageId: messageId,
        resetSession: true,
      })
    })()
  }

  // --- `forwardRef`: tray / shell entrypoints call into here / `forwardRef`：托盘等外部入口调用的命令式 API ---

  useImperativeHandle(
    ref,
    () => ({
      startNewThread: async () => {
        const threadId = onNewThread()
        if (threadId) activeThreadIdRef.current = threadId
        scrollIntentRef.current = 'force-bottom'
        isFirstTranscriptLayoutRef.current = true
        onStatusChange(compactModelName(globalDisplayModelRef.current, t))
        setInputValue('')
        requestAnimationFrame(() => chatInputRef.current?.focus())
      },
      focusComposer: () => {
        requestAnimationFrame(() => chatInputRef.current?.focus())
      },
      submitPromptInNewThread: async (projectId: string, prompt: string) => {
        const projectForSubmit = projects.find((project) => project.id === projectId)
        if (!projectForSubmit) return false
        const threadId = onNewThread(projectId)
        if (!threadId) return false

        activeThreadIdRef.current = threadId
        isFirstTranscriptLayoutRef.current = true
        scrollIntentRef.current = 'force-bottom'
        await submitPrompt(prompt, { threadId, project: projectForSubmit })
        requestAnimationFrame(() => chatInputRef.current?.focus())
        return true
      },
      submitPromptInThread: async (
        projectId: string,
        threadId: string,
        prompt: string,
        promptMode?: ClaudeChatSubmitPayload['promptMode'],
      ) => {
        const projectForSubmit = projects.find((project) => project.id === projectId)
        if (!projectForSubmit) return false

        activeThreadIdRef.current = threadId
        isFirstTranscriptLayoutRef.current = true
        scrollIntentRef.current = 'force-bottom'
        await submitPrompt(prompt, { threadId, project: projectForSubmit, promptMode })
        requestAnimationFrame(() => chatInputRef.current?.focus())
        return true
      },
    }),
    [onNewThread, onStatusChange, projects, setThreadRunState, t],
  )

  // --- Cancel streaming + answer permission / tool questions from modal / 停止生成；在弹窗中应答权限或工具提问 ---

  const cancelActiveRequest = async () => {
    const requestId = threadRunStatesRef.current[activeThread?.id ?? activeThreadIdRef.current]?.requestId
    if (!requestId || isPendingRequestId(requestId) || !window.claudeChat) return
    await window.claudeChat.cancel(requestId)
  }

  const resolveActiveUserInputPrompt = async (decision: UserInputDecision) => {
    const prompt = activeUserInputPrompt
    if (!prompt) return

    setPendingUserInputPrompts((prev) => prev.filter((item) => item.permissionRequestId !== prompt.permissionRequestId))
    if (!window.claudeChat) return
    await window.claudeChat.answerPermissionRequest({
      permissionRequestId: prompt.permissionRequestId,
      ...decision,
    })
  }

  // --- Composer attachments via native file picker (Electron) / 通过系统文件选择器添加附件（Electron）---

  const addComposerAttachments = async () => {
    const pickChatAttachments = window.desktop?.pickChatAttachments
    if (!pickChatAttachments || isRunningRef.current) {
      if (!pickChatAttachments) onStatusChange(t('chat.attachmentPickerUnavailable'))
      return
    }

    const result = await pickChatAttachments({ allowImages: activeModelSupportsImages })
    if (!result.ok) {
      onStatusChange(result.message)
      return
    }

    if (result.attachments.length > 0) {
      setPendingAttachments((current) => {
        const byPath = new Map(current.map((attachment) => [attachment.path, attachment]))
        for (const attachment of result.attachments) {
          if (byPath.size >= MAX_COMPOSER_ATTACHMENTS && !byPath.has(attachment.path)) break
          byPath.set(attachment.path, attachment)
        }
        return [...byPath.values()].slice(0, MAX_COMPOSER_ATTACHMENTS)
      })
    }

    if (result.skipped.length > 0) {
      const first = result.skipped[0]
      onStatusChange(t('chat.attachmentSkipped', { name: first.name, reason: first.reason }))
    }
  }

  const removeComposerAttachment = (attachmentId: string) => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  const syncComposerSelection = useCallback(() => {
    const input = chatInputRef.current
    if (!input) return
    setComposerSelection({ start: input.selectionStart, end: input.selectionEnd })
  }, [])

  const insertComposerSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      if (!activeComposerTrigger) return
      const before = inputValue.slice(0, activeComposerTrigger.start)
      const after = inputValue.slice(activeComposerTrigger.end)
      const nextValue = `${before}${suggestion.insertText}${after}`
      const nextCursor = before.length + suggestion.insertText.length
      setInputValue(nextValue)
      setDismissedAutocompleteKey('')
      setComposerSelection({ start: nextCursor, end: nextCursor })
      requestAnimationFrame(() => {
        const input = chatInputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [activeComposerTrigger, inputValue],
  )

  // --- Home “data card” draft → dedicated customization thread / 首页「数据卡片」草稿 → 专用定制线程 ---

  const submitDataCardDraft = async () => {
    const text = inputValue.trim()
    if (!text) return
    const threadId = onCreateHomePluginCardThread(activeProject.id, text)
    if (!threadId) return
    activeThreadIdRef.current = threadId
    isFirstTranscriptLayoutRef.current = true
    scrollIntentRef.current = 'force-bottom'
    setHomeComposerMode('normal')
    await window.claudeChat?.newThread(threadId)
    await submitPrompt(buildDataCardPrompt(text, threadId), {
      threadId,
      project: activeProject,
      promptMode: 'home-plugin-card-customization',
    })
  }

  // --- Composer form + keyboard routing (autocomplete vs send) / 表单提交与键盘路由（联想优先于发送）---

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (homeComposerMode === 'data-card-draft' && !hasMessages && !activeThread) {
      void submitDataCardDraft()
      return
    }
    void submitPrompt(inputValue, getActiveSubmitTarget(), pendingAttachments)
  }

  const handleSendClick = (event: React.MouseEvent) => {
    if (!isRunning) return
    event.preventDefault()
    void cancelActiveRequest()
  }

  const handleInputKeydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composerAutocompleteOpen && composerSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setComposerSuggestionIndex((index) => (index + 1) % composerSuggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setComposerSuggestionIndex((index) => (index - 1 + composerSuggestions.length) % composerSuggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertComposerSuggestion(composerSuggestions[composerSuggestionIndex] ?? composerSuggestions[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedAutocompleteKey(activeAutocompleteKey)
        return
      }
    }

    if (event.key !== 'Enter' || event.shiftKey || isComposingText) return
    event.preventDefault()
    if (homeComposerMode === 'data-card-draft' && !hasMessages && !activeThread) {
      void submitDataCardDraft()
      return
    }
    void submitPrompt(inputValue, getActiveSubmitTarget(), pendingAttachments)
  }

  // --- File diff UX: mark reviewed + optional rewind via SDK / 文件 diff：标记已读与可选 SDK 回滚 ---

  const reviewFileChanges = useCallback(
    (changeSetId: string) => {
      const threadId = activeThreadIdRef.current
      setThreadChatState(threadId, (prev) => {
        const idx = prev.items.findIndex((it) => it.type === 'file_diff' && it.changeSetId === changeSetId)
        if (idx < 0) return prev
        const next = [...prev.items]
        const it = next[idx] as ChatFileDiffItem
        next[idx] = { ...it, status: 'reviewed', detail: undefined }
        return { ...prev, items: next }
      })
    },
    [setThreadChatState],
  )

  const rewindFileChanges = useCallback(
    async (item: ChatFileDiffItem) => {
      const threadId = activeThreadIdRef.current
      if (!item.checkpointId || !window.claudeChat?.rewindFiles) {
        setThreadChatState(threadId, (prev) => updateFileDiffStatus(prev, item.changeSetId, 'error', t('chat.fileDiffUnavailable')))
        return
      }

      setThreadChatState(threadId, (prev) => updateFileDiffStatus(prev, item.changeSetId, 'captured', t('chat.fileDiffReverting')))
      const result = await window.claudeChat.rewindFiles({
        threadId,
        requestId: item.requestId,
        changeSetId: item.changeSetId,
        checkpointId: item.checkpointId,
        cwd: activeProject.path,
      })
      if (!result.ok) {
        setThreadChatState(threadId, (prev) => updateFileDiffStatus(prev, item.changeSetId, 'error', result.message || t('chat.fileDiffUnavailable')))
      }
    },
    [activeProject.path, setThreadChatState, t],
  )

  // --- Composer subtree (props-only; layout lives in `Composer.tsx`) / Composer 子树（仅传参；布局在 Composer 组件内）---

  const composer = (
    <Composer
      inputValue={inputValue}
      isRunning={isRunning}
      activeModelSupportsImages={activeModelSupportsImages}
      pendingAttachments={pendingAttachments}
      permissionMode={permissionMode}
      permissionModeLabel={permissionModeLabel}
      permissionModeRows={permissionModeRows}
      permissionModeOpen={permissionModeOpen}
      permissionModePopoverBox={permissionModePopoverBox}
      modelPickerOpen={modelPickerOpen}
      modelMenuRows={modelMenuRows}
      modelMenuSelectionKey={modelMenuSelectionKey}
      modelPopoverBox={modelPopoverBox}
      displayModelName={compactModelName(globalDisplayModel, t)}
      composerAutocompleteOpen={composerAutocompleteOpen}
      composerAutocompleteBox={composerAutocompleteBox}
      activeComposerTrigger={activeComposerTrigger}
      composerSuggestions={composerSuggestions}
      composerSuggestionIndex={composerSuggestionIndex}
      chatInputRef={chatInputRef}
      composerAutocompleteSurfaceRef={composerAutocompleteSurfaceRef}
      permissionModePickerRef={permissionModePickerRef}
      permissionModePopoverAnchorRef={permissionModePopoverAnchorRef}
      permissionModePopoverSurfaceRef={permissionModePopoverSurfaceRef}
      modelPickerRef={modelPickerRef}
      modelPopoverAnchorRef={modelPopoverAnchorRef}
      modelPopoverSurfaceRef={modelPopoverSurfaceRef}
      setPermissionMode={setPermissionMode}
      setPermissionModeOpen={setPermissionModeOpen}
      setModelPickerOpen={setModelPickerOpen}
      setComposerSuggestionIndex={setComposerSuggestionIndex}
      onInputChange={(value, selectionStart, selectionEnd) => {
        setInputValue(value)
        setComposerSelection({ start: selectionStart, end: selectionEnd })
        setDismissedAutocompleteKey('')
      }}
      onCompositionStart={() => setIsComposingText(true)}
      onCompositionEnd={() => setIsComposingText(false)}
      onInputKeyDown={handleInputKeydown}
      onSyncComposerSelection={syncComposerSelection}
      onFormSubmit={handleFormSubmit}
      onSendClick={handleSendClick}
      onAddComposerAttachments={() => void addComposerAttachments()}
      onRemoveComposerAttachment={removeComposerAttachment}
      onInsertComposerSuggestion={insertComposerSuggestion}
      onPickChatMenuRow={(row) => void pickChatMenuRow(row)}
    />
  )

  // --- Main render: active thread transcript vs empty “start” surface / 主渲染：有消息走会话轨，否则走起始视图 ---

  const showThreadView =
    hasMessages ||
    activeThread?.purpose === 'home-plugin-customization' ||
    activeThread?.purpose === 'home-plugin-card-customization' ||
    activeThread?.purpose === 'task-run'

  return (
    <section
      className={`chat-page${showThreadView ? ' has-messages' : ''}`}
      id="panel-home"
      aria-label={t('chat.ariaPage')}
      hidden={hidden}
      aria-hidden={hidden}
    >
      {showThreadView ? (
        <ChatThreadView
          items={chatItems}
          isRunning={isRunning}
          composer={composer}
          scrollRegionRef={scrollRegionRef}
          showScrollButton={showScrollButton}
          onScrollToBottom={scrollToBottom}
          onCopyMessage={(text) => void copyMessage(text)}
          onEditUserMessage={editUserMessage}
          onUserMessageEditDismissed={notifyUserMessageEditDismissed}
          onReviewFileChanges={reviewFileChanges}
          onRewindFileChanges={rewindFileChanges}
        />
      ) : (
        <ChatStartView
          project={activeProject}
          composer={composer}
          agentModeEnabled={agentModeEnabled}
          todoEnabled={todoEnabled}
          agentModeLoading={agentModeLoading}
          heading={homeComposerMode === 'data-card-draft' ? t('chat.dataCardDraftHeading') : undefined}
          onStartDataCardDraft={() => {
            setHomeComposerMode('data-card-draft')
            requestAnimationFrame(() => chatInputRef.current?.focus())
          }}
          onEditHomePluginCard={(item) => onEditHomePluginCard(activeProject.id, item)}
        />
      )}
      {activeUserInputPrompt
        ? createPortal(
            <AgentInputPromptModal prompt={activeUserInputPrompt} onResolve={(decision) => void resolveActiveUserInputPrompt(decision)} />,
            document.body,
          )
        : null}
    </section>
  )
})

// --- Module-level pure helpers (no React) / 模块级纯函数（无 React 依赖）---

function getComposerTrigger(value: string, selectionStart: number, selectionEnd: number): ComposerTrigger | null {
  if (selectionStart !== selectionEnd) return null
  const beforeCursor = value.slice(0, selectionStart)
  const currentLineStart = beforeCursor.lastIndexOf('\n') + 1
  const currentLine = beforeCursor.slice(currentLineStart)
  const slashMatch = /^(\s*)\/([A-Za-z0-9_-]*)$/.exec(currentLine)
  if (slashMatch) {
    const slashOffset = currentLine.indexOf('/')
    return {
      kind: 'slash',
      query: slashMatch[2] ?? '',
      start: currentLineStart + slashOffset,
      end: selectionStart,
    }
  }

  const mentionMatch = /(^|[\s([{])@([^\s@]*)$/.exec(beforeCursor)
  if (!mentionMatch) return null
  return {
    kind: 'mention',
    query: mentionMatch[2] ?? '',
    start: selectionStart - (mentionMatch[2]?.length ?? 0) - 1,
    end: selectionStart,
  }
}

function buildComposerSuggestions(
  trigger: ComposerTrigger | null,
  catalog: AgentContextCatalog | null,
  fileResults: ProjectFileSearchItem[],
  t: (path: string, vars?: Record<string, string | number>) => string,
): ComposerSuggestion[] {
  if (!trigger) return []
  if (trigger.kind === 'slash') return buildSlashSuggestions(trigger.query, catalog, t)
  return buildMentionSuggestions(trigger.query, catalog, fileResults, t)
}

function buildSlashSuggestions(query: string, catalog: AgentContextCatalog | null, t: (path: string, vars?: Record<string, string | number>) => string): ComposerSuggestion[] {
  const normalizedQuery = normalizeSuggestionQuery(query)
  const builtIns: ComposerSuggestion[] = getBuiltInSlashCommands(t).map((command) => ({
    id: `slash-built-in-${command.command}`,
    kind: 'slash',
    title: `${command.title}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
    subtitle: `${t('chat.slashBuiltInPrefix')}${command.description}`,
    insertText: `${command.title} `,
    item: command,
  }))

  const skills: ComposerSuggestion[] = (catalog?.skills ?? []).map((skill) => ({
    id: `slash-${skill.path}`,
    kind: 'slash',
    title: `${skill.title}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`,
    subtitle: `${formatContextScope(skill.scope, t)} · ${formatContextSource(skill.source)} · ${skill.description || skill.relativePath}`,
    insertText: `${skill.title} `,
    item: skill,
  }))

  return builtIns
    .concat(skills)
    .filter((suggestion) =>
      matchesSuggestion(normalizedQuery, suggestion.title, suggestion.subtitle, suggestion.insertText),
    )
    .slice(0, MAX_COMPOSER_SUGGESTIONS)
}

function buildMentionSuggestions(
  query: string,
  catalog: AgentContextCatalog | null,
  fileResults: ProjectFileSearchItem[],
  t: (path: string, vars?: Record<string, string | number>) => string,
): ComposerSuggestion[] {
  const normalizedQuery = normalizeSuggestionQuery(query.replace(/^agent-/, ''))
  const files: ComposerSuggestion[] = fileResults.map((file) => ({
    id: `file-${file.path}`,
    kind: 'file',
    title: file.type === 'directory' ? `${file.relativePath}/` : file.relativePath,
    subtitle: file.type === 'directory' ? t('chat.mentionFileTypeDir') : t('chat.mentionFileTypeFile'),
    insertText: `${formatFileMention(file.relativePath, file.type)} `,
    item: file,
  }))

  const agents: ComposerSuggestion[] = (catalog?.agents ?? []).map((agent) => ({
    id: `agent-${agent.path}`,
    kind: 'agent',
    title: `@agent-${agent.name}`,
    subtitle: `${formatContextScope(agent.scope, t)} · ${formatContextSource(agent.source)} · ${agent.description || agent.relativePath}`,
    insertText: `@agent-${agent.name} `,
    item: agent,
  }))

  return files
    .concat(agents)
    .filter((suggestion) =>
      matchesSuggestion(normalizedQuery, suggestion.title, suggestion.subtitle, suggestion.insertText),
    )
    .slice(0, MAX_COMPOSER_SUGGESTIONS)
}

function matchesSuggestion(query: string, ...values: string[]): boolean {
  if (!query) return true
  return values.some((value) => normalizeSuggestionQuery(value).includes(query))
}

function normalizeSuggestionQuery(value: string): string {
  return value.trim().toLowerCase()
}

function formatFileMention(relativePath: string, type: ProjectFileSearchItem['type']): string {
  const mentionPath = type === 'directory' ? `${relativePath.replace(/\/+$/u, '')}/` : relativePath
  if (!/[\s"']/u.test(mentionPath)) return `@${mentionPath}`
  return `@"${mentionPath.replace(/"/g, '\\"')}"`
}

function toChatMessageAttachment(attachment: ClaudeChatAttachment): ChatMessageAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    size: attachment.size,
    preview: attachment.preview,
    dataUrl: attachment.dataUrl,
  }
}

function mergeDiffFiles(existing: ChatFileDiffItem['files'], incoming: ChatFileDiffItem['files']): ChatFileDiffItem['files'] {
  const next = [...existing]
  for (const file of incoming) {
    const idx = next.findIndex((candidate) => candidate.path === file.path)
    if (idx < 0) {
      next.push(file)
      continue
    }
    const previous = next[idx]
    next[idx] = {
      ...previous,
      status: previous.status === 'added' ? previous.status : file.status,
      additions: previous.additions + file.additions,
      deletions: previous.deletions + file.deletions,
      hunks: [...previous.hunks, ...file.hunks],
      truncated: previous.truncated || file.truncated || undefined,
    }
  }
  return next
}

function updateFileDiffStatus(
  state: ChatState,
  changeSetId: string,
  status: ChatFileDiffItem['status'],
  detail?: string,
): ChatState {
  const idx = state.items.findIndex((it) => it.type === 'file_diff' && it.changeSetId === changeSetId)
  if (idx < 0) return state
  const next = [...state.items]
  const it = next[idx] as ChatFileDiffItem
  next[idx] = { ...it, status, detail }
  return { ...state, items: next }
}

function formatContextScope(scope: 'user' | 'project', t: (path: string, vars?: Record<string, string | number>) => string): string {
  return scope === 'user' ? t('chat.scopeUser') : t('chat.scopeProject')
}

function formatContextSource(source: AgentContextSource): string {
  if (source === 'claude') return '.claude'
  if (source === 'agent') return '.agent'
  if (source === 'agents') return '.agents'
  return '.cursor'
}

function readStoredPermissionMode(): ClaudePermissionMode {
  const stored = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY)
  return isClaudePermissionMode(stored) ? stored : 'auto'
}

async function writeClipboardText(text: string): Promise<boolean> {
  if (!text.trim()) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      textarea.remove()
    }
  }
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return value === 'plan' || value === 'auto' || value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions'
}

function getPermissionModeRows(t: (path: string, vars?: Record<string, string | number>) => string): PermissionModeRow[] {
  return [
    {
      mode: 'default',
      label: t('chat.permissionModeDefault'),
      description: t('chat.permissionModeDefaultDesc'),
    },
    {
      mode: 'auto',
      label: t('chat.permissionModeAuto'),
      description: t('chat.permissionModeAutoDesc'),
    },
    {
      mode: 'acceptEdits',
      label: t('chat.permissionModeAcceptEdits'),
      description: t('chat.permissionModeAcceptEditsDesc'),
    },
    {
      mode: 'plan',
      label: t('chat.permissionModePlan'),
      description: t('chat.permissionModePlanDesc'),
    },
    {
      mode: 'bypassPermissions',
      label: t('chat.permissionModeFull'),
      description: t('chat.permissionModeFullDesc'),
    },
  ]
}

function providerAcceptsAnthropicId(provider: ClaudeAgentModelProvider, modelId: string): boolean {
  const m = modelId.trim()
  if (!m) return false
  return [
    provider.model,
    provider.defaultHaikuModel,
    provider.defaultSonnetModel,
    provider.defaultOpusModel,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(m)
}

function resolvedChatDisplayModel(
  settings: ClaudeAgentSettings,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string {
  const provider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  if (!provider) return t('chat.modelFallback')
  const overlay = settings.activeAnthropicModel?.trim() ?? ''
  if (overlay && providerAcceptsAnthropicId(provider, overlay)) return overlay
  return provider.model.trim() || provider.name.trim() || t('chat.modelFallback')
}

function resolvedChatSupportsImages(snapshot: ClaudeAgentSettingsSnapshot): boolean {
  const settings = snapshot.settings
  if (settings.configSource === 'env') return snapshot.env.supportsImages
  const provider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  if (!provider) return false
  const overlay = settings.activeAnthropicModel?.trim() ?? ''
  const primary = provider.model.trim()
  const model = overlay && providerAcceptsAnthropicId(provider, overlay) ? overlay : primary || snapshot.env.model
  return providerSupportsImagesForModel(provider, model, snapshot.env.supportsImages)
}

function pickerSelectionKeyFromSettings(
  settings: ClaudeAgentSettings,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string {
  const provider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  const idModel = resolvedChatDisplayModel(settings, t)
  if (!provider) return `:${idModel}`
  return `${provider.id}:${idModel}`
}

function buildChatModelMenuRows(
  providers: ClaudeAgentModelProvider[],
  slots: { primary: string; haiku: string; sonnet: string; opus: string },
  t: (path: string, vars?: Record<string, string | number>) => string,
): ChatModelMenuRow[] {
  const rows: ChatModelMenuRow[] = []
  for (const p of providers) {
    const seen = new Set<string>()
    const base = providerMenuSubtitle(p)

    const add = (raw: string, slotLabel: string, useOverlayPick: boolean, supportsImages: boolean) => {
      const mid = raw.trim()
      if (!mid || seen.has(mid)) return
      seen.add(mid)
      rows.push({
        pickKey: `${p.id}:${mid}`,
        providerId: p.id,
        anthropicModelId: mid,
        useOverlayPick,
        supportsImages,
        headline: compactModelName(mid, t),
        metaLine: [base || null, slotLabel].filter(Boolean).join(' · '),
      })
    }

    add(p.model, slots.primary, false, providerSupportsImagesForModel(p, p.model, false))
    add(p.defaultHaikuModel, slots.haiku, true, providerSupportsImagesForModel(p, p.defaultHaikuModel, false))
    add(p.defaultSonnetModel, slots.sonnet, true, providerSupportsImagesForModel(p, p.defaultSonnetModel, false))
    add(p.defaultOpusModel, slots.opus, true, providerSupportsImagesForModel(p, p.defaultOpusModel, false))
  }

  return rows
}

function providerSupportsImagesForModel(
  provider: ClaudeAgentModelProvider,
  modelId: string,
  fallback: boolean,
): boolean {
  const m = modelId.trim()
  if (!m) return fallback
  const matches = [
    { model: provider.model, supportsImages: provider.modelSupportsImages },
    { model: provider.defaultHaikuModel, supportsImages: provider.defaultHaikuSupportsImages },
    { model: provider.defaultSonnetModel, supportsImages: provider.defaultSonnetSupportsImages },
    { model: provider.defaultOpusModel, supportsImages: provider.defaultOpusSupportsImages },
  ].filter((row) => row.model.trim() === m)
  if (!matches.length) return fallback
  return matches.some((row) => row.supportsImages)
}

function providerMenuSubtitle(entry: ClaudeAgentModelProvider): string {
  const parts = [
    entry.name?.trim() && entry.model?.trim() && entry.name.trim() !== entry.model.trim()
      ? entry.name.trim()
      : '',
    entry.baseUrl?.trim() || '',
  ].filter(Boolean)
  return parts.join(' · ')
}

function compactModelName(model: string, t: (path: string, vars?: Record<string, string | number>) => string): string {
  if (!/^claude-/i.test(model)) return model || t('chat.modelFallback')

  return model
    .replace(/^claude-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b(\w)/g, (letter) => letter.toUpperCase())
}

function isPendingRequestId(requestId: string): boolean {
  return requestId.startsWith('pending-')
}

function playAgentDoneSound(): void {
  if (typeof window === 'undefined') return
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return

  try {
    const ctx = new AudioContextCtor()
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const notes = [660, 880]

    notes.forEach((frequency, index) => {
      const start = now + index * 0.11
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.2)
    })

    window.setTimeout(() => void ctx.close(), 700)
  } catch {
    /* Some systems block Web Audio until the next user gesture. */
  }
}

/** 贴底跟随：距底部小于此值视为在底部 */
const SCROLL_STICK_THRESHOLD_PX = 96
/** 滞后显示：向上滚过此距离后才出现按钮，避免临界抖动 */
const SCROLL_SHOW_BUTTON_PX = 120
/** 滞后隐藏：回到距底部此距离内才隐藏 */
const SCROLL_HIDE_BUTTON_PX = 48
/** 内容至少高出可视区这么多才视为可滚动 */
const SCROLL_OVERFLOW_MIN_PX = 8

function getScrollMetrics(scrollRegion: HTMLElement) {
  const overflow = scrollRegion.scrollHeight - scrollRegion.clientHeight
  const remaining = scrollRegion.scrollHeight - scrollRegion.scrollTop - scrollRegion.clientHeight
  return { overflow, remaining }
}

function isScrollable(scrollRegion: HTMLElement): boolean {
  if (scrollRegion.hidden) return false
  return getScrollMetrics(scrollRegion).overflow > SCROLL_OVERFLOW_MIN_PX
}

function isNearBottom(
  scrollRegion: HTMLElement,
  threshold = SCROLL_STICK_THRESHOLD_PX,
): boolean {
  if (scrollRegion.hidden) return true
  if (!isScrollable(scrollRegion)) return true
  return getScrollMetrics(scrollRegion).remaining < threshold
}

function shouldShowScrollToBottom(scrollRegion: HTMLElement, currentlyShown: boolean): boolean {
  if (scrollRegion.hidden || !isScrollable(scrollRegion)) return false
  const { remaining } = getScrollMetrics(scrollRegion)
  if (currentlyShown) return remaining > SCROLL_HIDE_BUTTON_PX
  return remaining > SCROLL_SHOW_BUTTON_PX
}
