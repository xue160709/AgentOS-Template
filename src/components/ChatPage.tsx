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
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type {
  AgentContextAgentItem,
  AgentContextCatalog,
  AgentContextSlashItem,
  AgentContextSource,
  ClaudeAgentModelProvider,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
  ClaudeChatEvent,
  ProjectFileSearchItem,
} from '../claude-chat-types'
import { IconInline } from '../icon-inline'
import type {
  ActivityStatus,
  ChatActivityItem,
  ChatMessageItem,
  ChatState,
  ChatThinkingItem,
  ChatToolItem,
  ToolStatus,
  TranscriptItem,
  WorkspaceProject,
  WorkspaceThread,
} from './types'

marked.setOptions({
  breaks: true,
  gfm: true,
})

const SETTINGS_CHANGED_EVENT = 'claude-agent-settings:changed'
const MAX_COMPOSER_SUGGESTIONS = 64

export type ChatPageHandle = {
  startNewThread: () => Promise<void>
  focusComposer: () => void
}

type ChatPageProps = {
  hidden: boolean
  activeProject: WorkspaceProject
  activeThread: WorkspaceThread
  projects: WorkspaceProject[]
  onStatusChange: (text: string) => void
  onNewThread: () => void
  onSelectProject: (projectId: string) => void
  onCreateProject: (mode: 'scratch' | 'existing') => void | Promise<void>
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
}

type ChatModelMenuRow = {
  pickKey: string
  providerId: string
  anthropicModelId: string
  useOverlayPick: boolean
  headline: string
  metaLine: string
}

type ComposerTrigger =
  | {
      kind: 'slash'
      query: string
      start: number
      end: number
    }
  | {
      kind: 'mention'
      query: string
      start: number
      end: number
    }

type ComposerSuggestion =
  | {
      id: string
      kind: 'slash'
      title: string
      subtitle: string
      insertText: string
      item: AgentContextSlashItem | BuiltInSlashCommand
    }
  | {
      id: string
      kind: 'file'
      title: string
      subtitle: string
      insertText: string
      item: ProjectFileSearchItem
    }
  | {
      id: string
      kind: 'agent'
      title: string
      subtitle: string
      insertText: string
      item: AgentContextAgentItem
    }

type BuiltInSlashCommand = {
  kind: 'built-in'
  command: string
  title: string
  description: string
  argumentHint: string
}

const BUILT_IN_SLASH_COMMANDS: BuiltInSlashCommand[] = [
  {
    kind: 'built-in',
    command: 'compact',
    title: '/compact',
    description: '压缩当前会话上下文，保留后续继续工作需要的信息。',
    argumentHint: '[instructions]',
  },
  {
    kind: 'built-in',
    command: 'status',
    title: '/status',
    description: '查看当前会话、模型、工具和上下文状态。',
    argumentHint: '',
  },
  {
    kind: 'built-in',
    command: 'help',
    title: '/help',
    description: '查看 Claude Agent 可用的会话命令。',
    argumentHint: '',
  },
]

function ChatMessage({ item }: { item: ChatMessageItem }) {
  const bodyHtml = useMemo(() => {
    if (item.role === 'assistant') {
      return renderMarkdown(item.content || (item.status === 'streaming' ? '' : ' '))
    }
    return `<p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>`
  }, [item.content, item.role, item.status])

  if (item.role === 'assistant' && !item.content.trim() && item.status === 'streaming') return null

  const suffix = item.role === 'assistant' && item.status === 'streaming' ? '<span class="typing-dot"></span>' : ''

  return (
    <article className={`chat-message chat-message--${item.role} chat-message--${item.status}`}>
      <div
        className="chat-message__bubble markdown-body"
        dangerouslySetInnerHTML={{ __html: bodyHtml + suffix }}
      />
    </article>
  )
}

function ToolRow({ item }: { item: ChatToolItem }) {
  const statusLabel: Record<ToolStatus, string> = {
    denied: '已拒绝',
    done: '已完成',
    error: '出错',
    running: '运行中',
  }
  const hasDetails = Boolean(item.detail || item.inputPreview)
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`tool-row tool-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="status-row__summary">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="tool-row__dot" />
        <span className="tool-row__name">{item.name}</span>
        <span className="tool-row__status">{statusLabel[item.status]}</span>
        {item.detail ? <span className="tool-row__detail">{item.detail}</span> : null}
      </summary>
      {hasDetails ? (
        <div className="status-row__body">
          {item.inputPreview ? <code>{item.inputPreview}</code> : null}
        </div>
      ) : null}
    </details>
  )
}

function ThinkingRow({ item }: { item: ChatThinkingItem }) {
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`thinking-row thinking-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="thinking-row__header">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="thinking-row__dot" />
        <span className="thinking-row__title">{item.title}</span>
        <span className="thinking-row__status">{item.status === 'running' ? '思考中' : '完成'}</span>
      </summary>
      {item.content ? <pre>{item.content}</pre> : null}
    </details>
  )
}

function ActivityRow({ item }: { item: ChatActivityItem }) {
  const statusLabel: Record<ActivityStatus, string> = {
    done: '完成',
    error: '出错',
    info: '状态',
    running: '进行中',
  }
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`activity-row activity-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="activity-row__main">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="activity-row__dot" />
        <span className="activity-row__title">{item.title}</span>
        <span className="activity-row__status">{statusLabel[item.status]}</span>
        {item.detail ? <span className="activity-row__detail">{item.detail}</span> : null}
      </summary>
      {item.preview ? <pre>{item.preview}</pre> : null}
    </details>
  )
}

export const ChatPage = forwardRef<ChatPageHandle, ChatPageProps>(function ChatPage(
  {
    hidden,
    activeProject,
    activeThread,
    projects,
    onStatusChange,
    onNewThread,
    onSelectProject,
    onCreateProject,
    onThreadChatStateChange,
    onThreadPromptSubmit,
  },
  ref,
) {
  const chatState = activeThread.chatState
  const [isRunning, setIsRunning] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [isComposingText, setIsComposingText] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [modelMenuRows, setModelMenuRows] = useState<ChatModelMenuRow[]>([])
  const [modelMenuSelectionKey, setModelMenuSelectionKey] = useState('')
  const [agentContext, setAgentContext] = useState<AgentContextCatalog | null>(null)
  const [agentContextLoading, setAgentContextLoading] = useState(false)
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 })
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState('')
  const [fileMentionResults, setFileMentionResults] = useState<ProjectFileSearchItem[]>([])
  const [composerSuggestionIndex, setComposerSuggestionIndex] = useState(0)
  /** 与 Electron claude-agent-settings 对齐，composer 仅展示此项 */
  const [globalDisplayModel, setGlobalDisplayModel] = useState('Claude Agent')

  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const projectPickerRef = useRef<HTMLDivElement>(null)
  const composerAutocompleteSurfaceRef = useRef<HTMLDivElement>(null)
  const projectPopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const projectPopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const modelPopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const modelPopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const activeThreadIdRef = useRef(activeThread.id)
  const requestThreadIdsRef = useRef(new Map<string, string>())

  /** fixed 锚定触发按钮，避免被 .chat-composer / .app-main-inner 裁切 */
  const [modelPopoverBox, setModelPopoverBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const [projectPopoverBox, setProjectPopoverBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const scrollIntentRef = useRef<'none' | 'force-bottom'>('none')
  const isFirstTranscriptLayoutRef = useRef(true)
  const isRunningRef = useRef(false)
  const activeRequestIdRef = useRef<string | undefined>(undefined)
  const activeAssistantMessageIdRef = useRef<string | undefined>(undefined)
  const globalDisplayModelRef = useRef(globalDisplayModel)

  const [composerAutocompleteBox, setComposerAutocompleteBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)

  const hasMessages = chatState.items.length > 0
  const setThreadChatState = useCallback(
    (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => {
      onThreadChatStateChange(threadId, update)
    },
    [onThreadChatStateChange],
  )

  const refreshAgentContext = useCallback(async () => {
    const listAgentContext = window.desktop?.listAgentContext
    if (!listAgentContext) {
      setAgentContext(null)
      return
    }

    setAgentContextLoading(true)
    try {
      const result = await listAgentContext(activeProject.path)
      setAgentContext(result.ok ? result : null)
    } catch {
      setAgentContext(null)
    } finally {
      setAgentContextLoading(false)
    }
  }, [activeProject.path])

  useEffect(() => {
    void refreshAgentContext()
  }, [refreshAgentContext])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    globalDisplayModelRef.current = globalDisplayModel
  }, [globalDisplayModel])

  const applyGlobalModelFromSettings = useCallback(
    (snapshot: ClaudeAgentSettingsSnapshot) => {
      const settings = snapshot.settings

      setModelMenuRows(buildChatModelMenuRows(settings.providers))
      setModelMenuSelectionKey(pickerSelectionKeyFromSettings(settings))

      const model = resolvedChatDisplayModel(settings)
      setGlobalDisplayModel(model)

      if (!isRunningRef.current) {
        onStatusChange(compactModelName(model))
      }
    },
    [onStatusChange],
  )

  useEffect(() => {
    activeThreadIdRef.current = activeThread.id
    isFirstTranscriptLayoutRef.current = true
    scrollIntentRef.current = 'force-bottom'
    setShowScrollButton(false)
    setModelPickerOpen(false)
    setProjectPickerOpen(false)

    window.claudeChat?.getSettings().then(applyGlobalModelFromSettings).catch(() => {
      /* Browser preview can run without the Electron bridge. */
    })
  }, [activeThread.id, applyGlobalModelFromSettings])

  useEffect(() => {
    window.claudeChat?.getSettings().then(applyGlobalModelFromSettings).catch(() => {
      /* Browser preview can run without the Electron bridge. */
    })

    const onSettingsChanged = (event: Event) => {
      applyGlobalModelFromSettings((event as CustomEvent<ClaudeAgentSettingsSnapshot>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
  }, [applyGlobalModelFromSettings])

  const activeComposerTrigger = useMemo(
    () => getComposerTrigger(inputValue, composerSelection.start, composerSelection.end),
    [composerSelection.end, composerSelection.start, inputValue],
  )
  const activeAutocompleteKey = activeComposerTrigger
    ? `${activeComposerTrigger.kind}:${activeComposerTrigger.start}:${activeComposerTrigger.query}`
    : ''
  const composerSuggestions = useMemo(
    () => buildComposerSuggestions(activeComposerTrigger, agentContext, fileMentionResults),
    [activeComposerTrigger, agentContext, fileMentionResults],
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
      /* ignore */
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
    if (!projectPickerOpen || !projectPopoverAnchorRef.current) {
      setProjectPopoverBox(null)
      return
    }
    const gap = 6
    const pad = 8
    const maxListPx = 360

    const sync = () => {
      const anchor = projectPopoverAnchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const spaceAbove = r.top - pad
      const maxH = Math.min(maxListPx, Math.max(120, spaceAbove))
      const width = Math.min(320, window.innerWidth - pad * 2)
      let left = r.left
      if (left + width > window.innerWidth - pad) left = window.innerWidth - pad - width
      if (left < pad) left = pad
      const bottom = window.innerHeight - r.top + gap
      setProjectPopoverBox({ left, bottom, width, maxHeight: maxH })
    }

    sync()
    window.addEventListener('resize', sync)
    document.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      document.removeEventListener('scroll', sync, true)
    }
  }, [projectPickerOpen, projects.length])

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
    if (!projectPickerOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const t = event.target as Node | null
      if (!t) return
      if (projectPickerRef.current?.contains(t)) return
      if (projectPopoverSurfaceRef.current?.contains(t)) return
      setProjectPickerOpen(false)
    }
    const onKeyDown = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') setProjectPickerOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [projectPickerOpen])

  const syncScrollButtonVisibility = useCallback(() => {
    const sr = scrollRegionRef.current
    if (!sr || sr.hidden) {
      setShowScrollButton(false)
      return
    }
    setShowScrollButton((prev) => shouldShowScrollToBottom(sr, prev))
  }, [])

  useLayoutEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr || !hasMessages) {
      isFirstTranscriptLayoutRef.current = false
      setShowScrollButton(false)
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
  }, [chatState, hasMessages, syncScrollButtonVisibility])

  useEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr) return
    const onScroll = () => {
      if (!chatState.items.length) return
      syncScrollButtonVisibility()
    }
    sr.addEventListener('scroll', onScroll, { passive: true })
    return () => sr.removeEventListener('scroll', onScroll)
  }, [chatState.items.length, syncScrollButtonVisibility])

  useEffect(() => {
    const sr = scrollRegionRef.current
    const transcript = sr?.querySelector('.chat-transcript')
    if (!sr || !transcript || !hasMessages) return

    const ro = new ResizeObserver(() => {
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

  const finishRequest = useCallback(
    (requestId: string, statusText: string) => {
      if (activeRequestIdRef.current && activeRequestIdRef.current !== requestId) return
      activeRequestIdRef.current = undefined
      activeAssistantMessageIdRef.current = undefined
      requestThreadIdsRef.current.delete(requestId)
      isRunningRef.current = false
      setIsRunning(false)
      onStatusChange(statusText)
    },
    [onStatusChange],
  )

  const handleClaudeEvent = useCallback(
    (event: ClaudeChatEvent) => {
      const eventThreadId = requestThreadIdsRef.current.get(event.requestId) ?? activeThreadIdRef.current
      if (event.type === 'session_start') {
        setThreadChatState(eventThreadId, (prev) => ({
          ...prev,
          sessionId: event.sessionId,
          model: event.model || globalDisplayModelRef.current,
          cwd: event.cwd,
        }))
        return
      }

      if (event.type === 'assistant_delta') {
        setThreadChatState(eventThreadId, (prev) => {
          const messageId = event.messageId
          let { items } = prev
          const idx = items.findIndex((it) => it.type === 'message' && it.id === messageId)
          if (idx >= 0) {
            const it = items[idx] as ChatMessageItem
            const next = [...items]
            next[idx] = { ...it, content: it.content + event.text, status: 'streaming' }
            activeAssistantMessageIdRef.current = messageId
            return { ...prev, items: next }
          }

          const pendingId = activeAssistantMessageIdRef.current
          const pIdx = items.findIndex((it) => it.type === 'message' && it.id === pendingId && it.role === 'assistant')
          if (pIdx >= 0) {
            const it = items[pIdx] as ChatMessageItem
            const next = [...items]
            next[pIdx] = { ...it, id: messageId, content: it.content + event.text, status: 'streaming' }
            activeAssistantMessageIdRef.current = messageId
            return { ...prev, items: next }
          }

          if (!event.text) {
            activeAssistantMessageIdRef.current = messageId
            return prev
          }

          const msg: ChatMessageItem = {
            type: 'message',
            id: messageId,
            role: 'assistant',
            content: event.text,
            status: 'streaming',
          }
          activeAssistantMessageIdRef.current = messageId
          return { ...prev, items: [...items, msg] }
        })
        return
      }

      if (event.type === 'thinking_start') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'thinking' && it.thinkingId === event.thinkingId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatThinkingItem
            next[idx] = { ...it, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatThinkingItem = {
            type: 'thinking',
            id: event.thinkingId,
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
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'thinking' && it.thinkingId === event.thinkingId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatThinkingItem
            next[idx] = { ...it, content: it.content + event.text, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatThinkingItem = {
            type: 'thinking',
            id: event.thinkingId,
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
          next[idx] = { ...it, status: 'done' }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'tool_start') {
        setThreadChatState(eventThreadId, (prev) => {
          const existingIdx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (existingIdx >= 0) {
            const next = [...prev.items]
            const it = next[existingIdx] as ChatToolItem
            next[existingIdx] = { ...it, inputPreview: event.inputPreview || it.inputPreview, status: 'running' }
            return { ...prev, items: next }
          }
          const row: ChatToolItem = {
            type: 'tool',
            id: `tool-${event.toolUseId}`,
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
          next[idx] = { ...it, status: event.status, detail: event.detail ?? it.detail }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'agent_activity') {
        setThreadChatState(eventThreadId, (prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'activity' && it.id === event.activityId)
          if (idx >= 0) {
            const next = [...prev.items]
            const it = next[idx] as ChatActivityItem
            next[idx] = {
              ...it,
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
            title: event.title,
            status: event.status,
            detail: event.detail,
            preview: event.preview,
          }
          return { ...prev, items: [...prev.items, row] }
        })
        return
      }

      if (event.type === 'result') {
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const expectedId = `assistant-${event.requestId}`
            const pendingId = activeAssistantMessageIdRef.current
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content =
                !item.content.trim() && event.result.trim() ? event.result : item.content
              return { ...item, content, status: 'done' }
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
                    },
                  ]
            return { ...prev, sessionId: event.sessionId, items }
          })
        })
        finishRequest(event.requestId, compactModelName(globalDisplayModelRef.current))
        return
      }

      if (event.type === 'error') {
        scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const pendingId = activeAssistantMessageIdRef.current
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content = !item.content.trim() ? event.message : item.content
              return { ...item, content, status: 'error' }
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
                  },
                ]
            return { ...prev, items: itemsOut }
          })
        })
        finishRequest(event.requestId, event.code === 'missing_api_key' ? '缺少 API Key' : '出错')
        return
      }

      if (event.type === 'cancelled') {
        scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        flushSync(() => {
          setThreadChatState(eventThreadId, (prev) => {
            const pendingId = activeAssistantMessageIdRef.current
            let found = false
            const mapped = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              found = true
              const content = !item.content.trim() ? '已停止。' : item.content
              return { ...item, content, status: 'cancelled' }
            })
            const items: TranscriptItem[] = found
              ? mapped
              : [
                  ...mapped,
                  {
                    type: 'message',
                    id: expectedId,
                    role: 'assistant',
                    content: '已停止。',
                    status: 'cancelled',
                  },
                ]
            return { ...prev, items }
          })
        })
        finishRequest(event.requestId, '已停止')
      }
    },
    [finishRequest, onStatusChange, setThreadChatState],
  )

  useEffect(() => {
    const unsub = window.claudeChat?.onEvent((ev) => handleClaudeEvent(ev))
    return () => {
      unsub?.()
    }
  }, [handleClaudeEvent])

  useImperativeHandle(ref, () => ({
    startNewThread: async () => {
      onNewThread()
      scrollIntentRef.current = 'force-bottom'
      isFirstTranscriptLayoutRef.current = true
      activeRequestIdRef.current = undefined
      activeAssistantMessageIdRef.current = undefined
      isRunningRef.current = false
      setIsRunning(false)
      onStatusChange(compactModelName(globalDisplayModelRef.current))
      setInputValue('')
      requestAnimationFrame(() => chatInputRef.current?.focus())
    },
    focusComposer: () => {
      requestAnimationFrame(() => chatInputRef.current?.focus())
    },
  }), [onNewThread, onStatusChange])

  const submitPrompt = async (rawText: string) => {
    const text = rawText.trim()
    if (!text || isRunningRef.current) return
    const submittingThreadId = activeThreadIdRef.current
    const projectForSubmit =
      projects.find((project) => project.id === activeThread.projectId) ?? activeProject

    const userMessage: ChatMessageItem = {
      type: 'message',
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      status: 'done',
    }

    scrollIntentRef.current = 'force-bottom'
    onThreadPromptSubmit(submittingThreadId, text)
    setThreadChatState(submittingThreadId, (prev) => ({
      ...prev,
      items: [...prev.items, userMessage],
    }))
    setInputValue('')
    setIsRunning(true)
    isRunningRef.current = true
    activeAssistantMessageIdRef.current = undefined
    onStatusChange('处理中')

    if (!window.claudeChat) {
      scrollIntentRef.current = 'force-bottom'
      setThreadChatState(submittingThreadId, (prev) => ({
        ...prev,
        items: [
          ...prev.items,
          {
            type: 'message',
            id: `assistant-error-${Date.now()}`,
            role: 'assistant',
            content: 'Claude bridge unavailable. 请在 Electron 环境中运行应用。',
            status: 'error',
          },
        ],
      }))
      setIsRunning(false)
      isRunningRef.current = false
      activeAssistantMessageIdRef.current = undefined
      onStatusChange('桥接不可用')
      return
    }

    try {
      const { requestId } = await window.claudeChat.submit({
        text,
        threadId: submittingThreadId,
        cwd: projectForSubmit.path,
      })
      requestThreadIdsRef.current.set(requestId, submittingThreadId)
      activeRequestIdRef.current = requestId
      activeAssistantMessageIdRef.current = `assistant-${requestId}`
    } catch (error) {
      scrollIntentRef.current = 'force-bottom'
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
          },
        ],
      }))
      setIsRunning(false)
      isRunningRef.current = false
      activeRequestIdRef.current = undefined
      activeAssistantMessageIdRef.current = undefined
      onStatusChange('发送失败')
    }
  }

  const cancelActiveRequest = async () => {
    if (!isRunningRef.current || !window.claudeChat) return
    await window.claudeChat.cancel(activeRequestIdRef.current)
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

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (isRunningRef.current) return
    void submitPrompt(inputValue)
  }

  const handleSendClick = (event: React.MouseEvent) => {
    if (!isRunningRef.current) return
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
    if (!isRunningRef.current) void submitPrompt(inputValue)
  }

  const hasSendText = inputValue.trim().length > 0

  return (
    <section
      className={`chat-page${hasMessages ? ' has-messages' : ''}`}
      id="panel-home"
      aria-label="Claude Agent 聊天"
      hidden={hidden}
      aria-hidden={hidden}
    >
      <div className="chat-empty-header" id="chat-empty-header" hidden={hasMessages}>
        <h1>我们该构建什么？</h1>
      </div>
      <div className="chat-scroll-region" id="chat-scroll-region" ref={scrollRegionRef} hidden={!hasMessages}>
        <div className="chat-transcript" id="chat-transcript" aria-live="polite">
          {chatState.items.map((item) => {
            if (item.type === 'tool') return <ToolRow key={item.id} item={item} />
            if (item.type === 'thinking') return <ThinkingRow key={item.id} item={item} />
            if (item.type === 'activity') return <ActivityRow key={item.id} item={item} />
            return <ChatMessage key={item.id} item={item} />
          })}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-scroll-bottom"
        id="btn-scroll-bottom"
        title="滚动到底部"
        aria-label="滚动到底部"
        hidden={!hasMessages}
        aria-hidden={!showScrollButton}
        tabIndex={showScrollButton ? 0 : -1}
        data-visible={showScrollButton || undefined}
        onClick={() => scrollToBottom('smooth')}
      >
        <IconInline name="arrowDown" />
      </button>
      <div className="chat-composer-wrap no-drag">
        <form className="chat-composer" id="chat-form" onSubmit={handleFormSubmit}>
          <textarea
            ref={chatInputRef}
            className="chat-input"
            id="chat-input"
            rows={1}
            placeholder="要求后续变更"
            autoComplete="off"
            spellCheck={false}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setComposerSelection({ start: e.target.selectionStart, end: e.target.selectionEnd })
              setDismissedAutocompleteKey('')
            }}
            onCompositionStart={() => setIsComposingText(true)}
            onCompositionEnd={() => setIsComposingText(false)}
            onKeyDown={handleInputKeydown}
            onKeyUp={syncComposerSelection}
            onClick={syncComposerSelection}
            onSelect={syncComposerSelection}
          />
          {composerAutocompleteOpen && composerAutocompleteBox
            ? createPortal(
                <div
                  ref={composerAutocompleteSurfaceRef}
                  className="composer-autocomplete-popover"
                  role="listbox"
                  aria-label={activeComposerTrigger?.kind === 'slash' ? 'Slash commands' : 'Mentions'}
                  style={{
                    position: 'fixed',
                    left: composerAutocompleteBox.left,
                    bottom: composerAutocompleteBox.bottom,
                    width: composerAutocompleteBox.width,
                    maxHeight: composerAutocompleteBox.maxHeight,
                  }}
                >
                  {composerSuggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      role="option"
                      aria-selected={index === composerSuggestionIndex}
                      className={`composer-autocomplete-option${index === composerSuggestionIndex ? ' is-selected' : ''}`}
                      onMouseEnter={() => setComposerSuggestionIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertComposerSuggestion(suggestion)}
                    >
                      <IconInline name={suggestion.kind === 'file' ? 'file' : suggestion.kind === 'agent' ? 'branch' : 'chip'} />
                      <span className="composer-autocomplete-option__copy">
                        <span>{suggestion.title}</span>
                        <span>{suggestion.subtitle}</span>
                      </span>
                    </button>
                  ))}
                </div>,
                document.body,
              )
            : null}
          <div className="composer-footer">
            <div className="composer-actions">
              {/* 关掉，需要再打开
              <button type="button" className="composer-icon-button" id="btn-attach" title="添加上下文" aria-label="添加上下文">
                <IconInline name="plus" />
              </button>
              <button type="button" className="composer-mode-button" title="权限模式：自动审查" aria-label="权限模式：自动审查">
                <IconInline name="shield" />
                <span>自动审查</span>
                <IconInline name="chevron" />
              </button>
              */}
            </div>
            <div className="composer-actions composer-actions--end">
              <span className={`composer-spinner${isRunning ? ' is-visible' : ''}`} id="composer-spinner" aria-hidden="true" />
              <div className="composer-model-picker" ref={modelPickerRef}>
                <button
                  ref={modelPopoverAnchorRef}
                  type="button"
                  className={`composer-model-button${modelPickerOpen ? ' is-open' : ''}`}
                  id="composer-model-trigger"
                  title="选择对话使用的模型配置"
                  aria-label="选择对话使用的模型配置"
                  aria-expanded={modelPickerOpen}
                  aria-haspopup="menu"
                  disabled={isRunning || modelMenuRows.length === 0}
                  onClick={() => {
                    if (isRunning || modelMenuRows.length === 0) return
                    setModelPickerOpen((open) => !open)
                  }}
                >
                  <span id="composer-model">{compactModelName(globalDisplayModel)}</span>
                  <IconInline name="chevron" />
                </button>
                {modelPickerOpen && modelMenuRows.length > 0 && modelPopoverBox
                  ? createPortal(
                      <div
                        ref={modelPopoverSurfaceRef}
                        className="composer-model-popover"
                        role="menu"
                        aria-label="模型配置条目"
                        style={{
                          position: 'fixed',
                          left: modelPopoverBox.left,
                          bottom: modelPopoverBox.bottom,
                          width: modelPopoverBox.width,
                          maxHeight: modelPopoverBox.maxHeight,
                        }}
                      >
                        {modelMenuRows.map((row) => {
                          const checked = row.pickKey === modelMenuSelectionKey
                          return (
                            <button
                              key={row.pickKey}
                              type="button"
                              role="menuitemradio"
                              className={`composer-model-option${checked ? ' is-selected' : ''}`}
                              aria-checked={checked}
                              title={row.metaLine || undefined}
                              onClick={() => void pickChatMenuRow(row)}
                            >
                              <span className="composer-model-option__label">{row.headline}</span>
                              <span className="composer-model-option__meta">{row.metaLine}</span>
                            </button>
                          )
                        })}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
              {/* 关掉，需要再打开
              <button type="button" className="composer-icon-button" id="btn-dictate" title="语音输入" aria-label="语音输入">
                <IconInline name="mic" />
              </button>
              */}
              <button
                type="submit"
                className="composer-send-button"
                id="btn-send"
                title={isRunning ? '停止' : '发送'}
                aria-label={isRunning ? '停止' : '发送'}
                disabled={!isRunning && !hasSendText}
                onClick={handleSendClick}
              >
                <IconInline name={isRunning ? 'stop' : 'send'} />
              </button>
            </div>
          </div>
        </form>

        <div className="chat-context-strip" aria-label="当前上下文">
          <div className="chat-project-picker" ref={projectPickerRef}>
            <button
              ref={projectPopoverAnchorRef}
              type="button"
              className={`chat-project-trigger${projectPickerOpen ? ' is-open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={projectPickerOpen}
              title="切换项目"
              onClick={() => setProjectPickerOpen((open) => !open)}
            >
              <IconInline name="folder" />
              <span>{activeProject.name}</span>
              <IconInline name="chevron" />
            </button>
            {projectPickerOpen && projectPopoverBox
              ? createPortal(
                  <div
                    ref={projectPopoverSurfaceRef}
                    className="chat-project-popover"
                    role="menu"
                    aria-label="项目"
                    style={{
                      position: 'fixed',
                      left: projectPopoverBox.left,
                      bottom: projectPopoverBox.bottom,
                      width: projectPopoverBox.width,
                      maxHeight: projectPopoverBox.maxHeight,
                    }}
                  >
                <div className="chat-project-popover-title">项目</div>
                <div className="chat-project-options">
                  {projects.map((project) => {
                    const selected = project.id === activeProject.id
                    return (
                      <button
                        key={project.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={`chat-project-option${selected ? ' is-selected' : ''}`}
                        onClick={() => {
                          onSelectProject(project.id)
                          setProjectPickerOpen(false)
                        }}
                      >
                        <IconInline name="folder" />
                        <span className="chat-project-option-copy">
                          <span>{project.name}</span>
                          <span>{project.path}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="chat-project-popover-title">新增项目</div>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-project-option"
                  onClick={() => {
                    setProjectPickerOpen(false)
                    void onCreateProject('existing')
                  }}
                >
                  <IconInline name="folder" />
                  <span className="chat-project-option-copy">
                    <span>使用已有文件夹</span>
                    <span>把文件夹加入项目列表</span>
                  </span>
                </button>
                  </div>,
                  document.body,
                )
              : null}
          </div>
          <button
            type="button"
            className="chat-context-action"
            title="刷新当前项目的 skills / agents"
            disabled={agentContextLoading}
            onClick={() => void refreshAgentContext()}
          >
            <IconInline name="chip" />
            <span>
              {agentContextLoading
                ? '扫描中'
                : `${agentContext?.skills.length ?? 0} skills / ${agentContext?.agents.length ?? 0} agents`}
            </span>
          </button>
        </div>
      </div>
    </section>
  )
})

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
): ComposerSuggestion[] {
  if (!trigger) return []
  if (trigger.kind === 'slash') return buildSlashSuggestions(trigger.query, catalog)
  return buildMentionSuggestions(trigger.query, catalog, fileResults)
}

function buildSlashSuggestions(query: string, catalog: AgentContextCatalog | null): ComposerSuggestion[] {
  const normalizedQuery = normalizeSuggestionQuery(query)
  const builtIns: ComposerSuggestion[] = BUILT_IN_SLASH_COMMANDS.map((command) => ({
    id: `slash-built-in-${command.command}`,
    kind: 'slash',
    title: `${command.title}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
    subtitle: `Built-in · ${command.description}`,
    insertText: `${command.title} `,
    item: command,
  }))

  const skills: ComposerSuggestion[] = (catalog?.skills ?? []).map((skill) => ({
    id: `slash-${skill.path}`,
    kind: 'slash',
    title: `${skill.title}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`,
    subtitle: `${formatContextScope(skill.scope)} · ${formatContextSource(skill.source)} · ${skill.description || skill.relativePath}`,
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
): ComposerSuggestion[] {
  const normalizedQuery = normalizeSuggestionQuery(query.replace(/^agent-/, ''))
  const files: ComposerSuggestion[] = fileResults.map((file) => ({
    id: `file-${file.path}`,
    kind: 'file',
    title: file.relativePath,
    subtitle: file.type === 'directory' ? 'Directory' : 'File',
    insertText: `${formatFileMention(file.relativePath)} `,
    item: file,
  }))

  const agents: ComposerSuggestion[] = (catalog?.agents ?? []).map((agent) => ({
    id: `agent-${agent.path}`,
    kind: 'agent',
    title: `@agent-${agent.name}`,
    subtitle: `${formatContextScope(agent.scope)} · ${formatContextSource(agent.source)} · ${agent.description || agent.relativePath}`,
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

function formatFileMention(relativePath: string): string {
  if (!/[\s"']/u.test(relativePath)) return `@${relativePath}`
  return `@"${relativePath.replace(/"/g, '\\"')}"`
}

function formatContextScope(scope: 'user' | 'project'): string {
  return scope === 'user' ? 'User' : 'Project'
}

function formatContextSource(source: AgentContextSource): string {
  if (source === 'claude') return '.claude'
  if (source === 'agent') return '.agent'
  if (source === 'agents') return '.agents'
  return '.cursor'
}

function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    USE_PROFILES: { html: true },
  })
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

function resolvedChatDisplayModel(settings: ClaudeAgentSettings): string {
  const provider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  if (!provider) return 'Claude Agent'
  const overlay = settings.activeAnthropicModel?.trim() ?? ''
  if (overlay && providerAcceptsAnthropicId(provider, overlay)) return overlay
  return provider.model.trim() || provider.name.trim() || 'Claude Agent'
}

function pickerSelectionKeyFromSettings(settings: ClaudeAgentSettings): string {
  const provider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  const idModel = resolvedChatDisplayModel(settings)
  if (!provider) return `:${idModel}`
  return `${provider.id}:${idModel}`
}

function buildChatModelMenuRows(providers: ClaudeAgentModelProvider[]): ChatModelMenuRow[] {
  const rows: ChatModelMenuRow[] = []
  for (const p of providers) {
    const seen = new Set<string>()
    const base = providerMenuSubtitle(p)

    const add = (raw: string, slotLabel: string, useOverlayPick: boolean) => {
      const mid = raw.trim()
      if (!mid || seen.has(mid)) return
      seen.add(mid)
      rows.push({
        pickKey: `${p.id}:${mid}`,
        providerId: p.id,
        anthropicModelId: mid,
        useOverlayPick,
        headline: compactModelName(mid),
        metaLine: [base || null, slotLabel].filter(Boolean).join(' · '),
      })
    }

    add(p.model, '主模型', false)
    add(p.defaultHaikuModel, 'Haiku', true)
    add(p.defaultSonnetModel, 'Sonnet', true)
    add(p.defaultOpusModel, 'Opus', true)
  }

  return rows
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

function compactModelName(model: string): string {
  if (!/^claude-/i.test(model)) return model || 'Claude Agent'

  return model
    .replace(/^claude-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b(\w)/g, (letter) => letter.toUpperCase())
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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
