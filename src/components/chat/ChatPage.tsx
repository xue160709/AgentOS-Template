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
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { IconInline } from '../../icon-inline'
import type {
  AgentContextCatalog,
  AgentContextSource,
  ChatModelPick,
  ClaudeChatAttachment,
  ClaudeChatAttachmentPickerResult,
  ClaudeAgentSettingsSnapshot,
  ClaudeChatEvent,
  ClaudeChatSubmitPayload,
  ClaudePermissionMode,
  ProjectFileSearchItem,
} from '../../claude-chat-types'
import { CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, OPEN_AGENT_STATUS_EVENT } from '../../app-events'
import type { HomePluginRunItem, SpeechRecognitionStatus } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'
import {
  buildModelPickRows,
  displayModelForPick,
  modelPickFromRow,
  modelPickKey,
  modelRowForPick,
  resolveEffectiveModelPick,
  sameModelPick,
  supportsImagesForPick,
} from '../../model-pick'
import type {
  ChatActivityItem,
  ChatFileDiffItem,
  ChatMessageAttachment,
  ChatMessageItem,
  ChatTaskItem,
  ChatTaskState,
  ChatState,
  ChatThinkingItem,
  ChatToolItem,
  FileTreeNode,
  AgentSettingsPanelId,
  ProjectSkillRunRequest,
  ThreadRunState,
  TranscriptItem,
  WorkspaceProject,
  WorkspaceThread,
} from '../types'
import { AgentInputPromptModal, type PendingUserInputPrompt, type UserInputDecision } from './AgentInputPromptModal'
import { ChatStartView } from './ChatStartView'
import { ChatThreadView } from './ChatThreadView'
import { writeClipboardText } from './clipboard'
import { Composer } from './Composer'
import { formatBytes } from './format'
import type { BuiltInSlashCommand, ChatModelMenuRow, ComposerSuggestion, ComposerTrigger, PermissionModeRow } from './local-types'
import type { WorkspaceAgentModeState } from '../useWorkspaceAgentMode'

const PROCESS_TRACE_TOGGLE_EVENT = 'chat-process-trace:toggle'
const MAX_COMPOSER_SUGGESTIONS = 64
const MAX_COMPOSER_ATTACHMENTS = 8
const COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES = 24 * 1024 * 1024
const COMPOSER_PASTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const COMPOSER_PASTE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const ACTIVE_SPEECH_RECOGNITION_STATUSES = new Set<SpeechRecognitionStatus>([
  'starting',
  'requesting_permission',
  'listening',
  'transcribing',
])

type SpeechDraftRange = {
  start: number
  end: number
  committedText: string
  liveText: string
}

function isCjkCharacter(value: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value)
}

function needsSpeechSeparator(left: string, right: string) {
  if (!left || !right) return false
  const last = left.trimEnd().at(-1)
  const first = right.trimStart().at(0)
  if (!last || !first) return false
  if (/^[,.;:!?，。！？；：、）)\]}]/u.test(first)) return false
  if (isCjkCharacter(last) || isCjkCharacter(first)) return false
  return true
}

function joinSpeechSegments(left: string, right: string) {
  const cleanLeft = left.trim()
  const cleanRight = right.trim()
  if (!cleanLeft) return cleanRight
  if (!cleanRight) return cleanLeft
  return `${cleanLeft}${needsSpeechSeparator(cleanLeft, cleanRight) ? ' ' : ''}${cleanRight}`
}

function commonPrefixLength(a: string, b: string) {
  const maxLength = Math.min(a.length, b.length)
  let length = 0
  while (length < maxLength && a[length] === b[length]) {
    length += 1
  }
  return length
}

function shouldStartNewSpeechSegment(previous: string, next: string) {
  if (!previous || !next || previous === next) return false
  if (next.startsWith(previous) || previous.startsWith(next)) return false
  const sharedPrefixLength = commonPrefixLength(previous, next)
  const shorterLength = Math.min(previous.length, next.length)
  if (shorterLength > 0 && sharedPrefixLength / shorterLength >= 0.6) return false
  return next.length + 1 < previous.length || sharedPrefixLength < Math.min(2, shorterLength)
}

function escapeCssAttributeValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getNativeFilePath(file: File): string {
  const maybeNativeFile = file as File & { path?: unknown }
  return typeof maybeNativeFile.path === 'string' ? maybeNativeFile.path : ''
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function imageExtensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取剪贴板图片'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板图片'))
    reader.readAsDataURL(file)
  })
}

function mergeComposerAttachments(
  current: ClaudeChatAttachment[],
  incoming: ClaudeChatAttachment[],
): { attachments: ClaudeChatAttachment[]; skipped: Array<{ name: string; reason: string }> } {
  const byPath = new Map(current.map((attachment) => [attachment.path, attachment]))
  const skipped: Array<{ name: string; reason: string }> = []

  for (const attachment of incoming) {
    const existing = byPath.get(attachment.path)
    const nextAttachments = existing
      ? [...byPath.values()].map((item) => (item.path === attachment.path ? attachment : item))
      : [...byPath.values(), attachment]

    if (!existing && byPath.size >= MAX_COMPOSER_ATTACHMENTS) {
      skipped.push({ name: attachment.name, reason: `一次最多添加 ${MAX_COMPOSER_ATTACHMENTS} 个文件` })
      continue
    }

    if (totalAttachmentBytes(nextAttachments) > COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES) {
      skipped.push({ name: attachment.name, reason: '附件总大小超过 24MB' })
      continue
    }

    byPath.set(attachment.path, attachment)
  }

  return { attachments: [...byPath.values()].slice(0, MAX_COMPOSER_ATTACHMENTS), skipped }
}

function totalAttachmentBytes(attachments: ClaudeChatAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + Math.max(0, attachment.size || 0), 0)
}

// --- Imperative handle / 命令式句柄 ---

export type ChatPageHandle = {
  startNewThread: () => Promise<void>
  focusComposer: () => void
  insertComposerText: (text: string) => void
  revealMessage: (messageId: string) => boolean
  submitPromptInNewThread: (projectId: string, prompt: string) => Promise<boolean>
  submitPromptInThread: (
    projectId: string,
    threadId: string,
    prompt: string,
    options?: ClaudeChatSubmitPayload['promptMode'] | SubmitPromptOptions,
  ) => Promise<boolean>
}

export type SubmitPromptOptions = {
  promptMode?: ClaudeChatSubmitPayload['promptMode']
  modelPick?: ChatModelPick
}

type ChatPageProps = {
  hidden: boolean
  activeProject: WorkspaceProject
  activeThread: WorkspaceThread | undefined
  projectDefaultModelPick?: ChatModelPick
  projectHomeModelPick?: ChatModelPick
  /** 按 threadId 查找持久化 sessionId（重启后恢复 SDK）/ Threads list for resolving persisted session ids */
  threads: WorkspaceThread[]
  projects: WorkspaceProject[]
  projectOrderIds: readonly string[]
  threadRunStates: Record<string, ThreadRunState>
  onStatusChange: (text: string) => void
  onNewThread: (projectId?: string) => string | void
  onCreateProject: (mode: 'scratch' | 'existing') => void | Promise<void>
  onSelectProject: (projectId: string) => void
  onThreadChatStateChange: (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => void
  onThreadPromptSubmit: (threadId: string, prompt: string) => void
  onThreadRunStateChange: (threadId: string, state: ThreadRunState | null) => void
  onThreadCompletionStateChange: (threadId: string, completedAt: number | null) => void
  onProjectHomeModelPickChange: (projectId: string, pick: ChatModelPick | undefined) => void
  agentMode: WorkspaceAgentModeState
  agentModeEnabled: boolean
  todoEnabled: boolean
  agentModeLoading: boolean
  agentSettingsOpen: boolean
  agentSettingsPanel: AgentSettingsPanelId
  onOpenAgentSettings: (panel: AgentSettingsPanelId) => void
  onAgentSettingsPanelChange: (panel: AgentSettingsPanelId) => void
  onCloseAgentSettings: () => void
  homeModeResetKey: number
  hiddenSkillPaths: string[]
  onCreateHomePluginCardThread: (projectId: string, initialPrompt: string) => string | void
  onEditHomePluginCard: (projectId: string, item: HomePluginRunItem) => void
  onOpenProjectFile: (node: FileTreeNode) => void
  onRunProjectSkill: (projectId: string, skill: ProjectSkillRunRequest) => void
  onStopProjectSkillRun: (projectId: string, skillPath: string) => void
}

// --- Internal helpers / 模块内辅助 ---

type SubmitPromptTarget = {
  threadId?: string
  project?: WorkspaceProject
  promptMode?: ClaudeChatSubmitPayload['promptMode']
  modelPick?: ChatModelPick
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
    projectDefaultModelPick,
    projectHomeModelPick,
    threads,
    projects,
    projectOrderIds,
    threadRunStates,
    onStatusChange,
    onNewThread,
    onCreateProject,
    onSelectProject,
    onThreadChatStateChange,
    onThreadPromptSubmit,
    onThreadRunStateChange,
    onThreadCompletionStateChange,
    onProjectHomeModelPickChange,
    agentMode,
    agentModeEnabled,
    todoEnabled,
    agentModeLoading,
    agentSettingsOpen,
    agentSettingsPanel,
    onOpenAgentSettings,
    onAgentSettingsPanelChange,
    onCloseAgentSettings,
    homeModeResetKey,
    hiddenSkillPaths,
    onCreateHomePluginCardThread,
    onEditHomePluginCard,
    onOpenProjectFile,
    onRunProjectSkill,
    onStopProjectSkillRun,
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
  const [claudeSettingsSnapshot, setClaudeSettingsSnapshot] = useState<ClaudeAgentSettingsSnapshot | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<ClaudeChatAttachment[]>([])
  const pendingAttachmentsRef = useRef<ClaudeChatAttachment[]>([])
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
  const [speechRecognitionStatus, setSpeechRecognitionStatus] = useState<SpeechRecognitionStatus>(
    window.desktop?.platform === 'darwin' ? 'idle' : 'unsupported',
  )

  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const permissionModePickerRef = useRef<HTMLDivElement>(null)
  const composerAutocompleteSurfaceRef = useRef<HTMLDivElement>(null)
  const modelPopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const modelPopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const permissionModePopoverAnchorRef = useRef<HTMLButtonElement>(null)
  const permissionModePopoverSurfaceRef = useRef<HTMLDivElement>(null)
  const todoButtonRef = useRef<HTMLButtonElement>(null)
  const todoPanelRef = useRef<HTMLDivElement>(null)
  const activeThreadIdRef = useRef(activeThread?.id ?? '')
  const threadScrollTopRef = useRef(new Map<string, number>())
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
  const newThreadModelPick = projectHomeModelPick ?? projectDefaultModelPick
  const scrollIntentRef = useRef<'none' | 'force-bottom'>('none')
  /** 取消 / Esc 关闭编辑时抑制贴底，避免 ResizeObserver 误判 isNearBottom 把视口滚到底 */
  const suppressTranscriptResizeStickRef = useRef(false)
  const suppressTranscriptResizeStickTimerRef = useRef<number | null>(null)
  const searchHighlightTimerRef = useRef<number | null>(null)
  const isFirstTranscriptLayoutRef = useRef(true)
  const isRunningRef = useRef(false)
  const globalDisplayModelRef = useRef(globalDisplayModel)
  const currentModelPickRef = useRef<ChatModelPick | undefined>(undefined)
  const inputValueRef = useRef(inputValue)
  const composerSelectionRef = useRef(composerSelection)
  const speechDraftRangeRef = useRef<SpeechDraftRange | null>(null)
  const lastSpeechAppliedValueRef = useRef<string | null>(null)
  const ignoreSpeechRecognitionTextRef = useRef(false)
  const speechRestartAfterEditRef = useRef(false)

  const [composerAutocompleteBox, setComposerAutocompleteBox] = useState<{
    left: number
    bottom: number
    width: number
    maxHeight: number
  } | null>(null)
  const [todoPanelOpen, setTodoPanelOpen] = useState(false)

  const hasMessages = chatItems.length > 0
  const activeTaskState = activeThread?.chatState.tasks
  const visibleTaskItems = useMemo(
    () => (activeTaskState?.items ?? []).filter((task) => task.status !== 'deleted'),
    [activeTaskState?.items],
  )
  const hasVisibleTasks = visibleTaskItems.length > 0
  const activeUserInputPrompt = useMemo(() => {
    const activeThreadId = activeThread?.id ?? activeThreadIdRef.current
    if (!activeThreadId) return null
    return (
      pendingUserInputPrompts.find((prompt) => {
        const promptThreadId = prompt.threadId ?? requestThreadIdsRef.current.get(prompt.requestId)
        return promptThreadId === activeThreadId
      }) ?? null
    )
  }, [activeThread?.id, pendingUserInputPrompts])
  const permissionModeRows = useMemo(() => getPermissionModeRows(t), [t])
  const permissionModeLabel = permissionModeRows.find((row) => row.mode === permissionMode)?.label ?? t('chat.permissionModeAuto')
  const speechRecognitionSupported =
    window.desktop?.platform === 'darwin' &&
    Boolean(
      window.desktop?.startSpeechRecognition &&
        window.desktop?.stopSpeechRecognition &&
        window.desktop?.cancelSpeechRecognition &&
        window.desktop?.onSpeechRecognitionEvent,
    )
  const setThreadChatState = useCallback(
    (threadId: string, update: ChatState | ((prev: ChatState) => ChatState)) => {
      onThreadChatStateChange(threadId, update)
    },
    [onThreadChatStateChange],
  )
  const beginSpeechDraft = useCallback(() => {
    const currentInput = inputValueRef.current
    const selection = composerSelectionRef.current
    const selectionStart = Math.max(0, Math.min(selection.start, currentInput.length))
    const selectionEnd = Math.max(selectionStart, Math.min(selection.end, currentInput.length))
    lastSpeechAppliedValueRef.current = currentInput
    speechDraftRangeRef.current = {
      start: selectionStart,
      end: selectionEnd,
      committedText: '',
      liveText: '',
    }
  }, [])
  const clearSpeechDraft = useCallback(() => {
    speechDraftRangeRef.current = null
    lastSpeechAppliedValueRef.current = null
  }, [])
  const replaceSpeechDraftText = useCallback((text: string) => {
    const cleanText = text.trim()
    const currentInput = inputValueRef.current

    if (!speechDraftRangeRef.current) {
      beginSpeechDraft()
    }

    const draftRange = speechDraftRangeRef.current
    if (!draftRange) return false

    let committedText = draftRange.committedText
    let liveText = draftRange.liveText
    if (committedText && (cleanText.startsWith(committedText) || cleanText.includes(committedText))) {
      committedText = ''
      liveText = cleanText
    } else if (shouldStartNewSpeechSegment(liveText, cleanText)) {
      committedText = joinSpeechSegments(committedText, liveText)
      liveText = cleanText
    } else {
      liveText = cleanText
    }

    const draftText = joinSpeechSegments(committedText, liveText)

    const replacementStart = Math.max(0, Math.min(draftRange.start, currentInput.length))
    const replacementEnd = Math.max(replacementStart, Math.min(draftRange.end, currentInput.length))
    const before = currentInput.slice(0, replacementStart)
    const after = currentInput.slice(replacementEnd)
    const leadingSpace = needsSpeechSeparator(before, draftText) ? ' ' : ''
    const trailingSpace = needsSpeechSeparator(draftText, after) ? ' ' : ''
    const insertion = draftText ? `${leadingSpace}${draftText}${trailingSpace}` : ''
    const nextValue = `${before}${insertion}${after}`
    const nextCursor = before.length + insertion.length

    speechDraftRangeRef.current = {
      start: replacementStart,
      end: nextCursor,
      committedText,
      liveText,
    }
    inputValueRef.current = nextValue
    composerSelectionRef.current = { start: nextCursor, end: nextCursor }
    lastSpeechAppliedValueRef.current = nextValue
    setInputValue(nextValue)
    setComposerSelection({ start: nextCursor, end: nextCursor })
    requestAnimationFrame(() => {
      chatInputRef.current?.focus()
      chatInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
    return draftText.length > 0
  }, [beginSpeechDraft])
  const speechRecognitionErrorMessage = useCallback(
    (code: string, fallback: string) => {
      if (code === 'speech_denied') return t('chat.voiceSpeechDenied')
      if (code === 'microphone_denied') return t('chat.voiceMicrophoneDenied')
      if (code === 'on_device_unavailable') return t('chat.voiceOnDeviceUnavailable')
      if (code === 'helper_start_failed') return t('chat.voiceHelperStartFailed')
      return fallback || t('chat.voiceError')
    },
    [t],
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
    inputValueRef.current = inputValue
  }, [inputValue])

  useEffect(() => {
    composerSelectionRef.current = composerSelection
  }, [composerSelection])

  useEffect(() => {
    window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, permissionMode)
  }, [permissionMode])

  useEffect(() => {
    globalDisplayModelRef.current = globalDisplayModel
  }, [globalDisplayModel])

  useEffect(() => {
    setTodoPanelOpen(false)
  }, [activeThread?.id])

  useEffect(() => {
    if (!hasVisibleTasks) setTodoPanelOpen(false)
  }, [hasVisibleTasks])

  useEffect(() => {
    if (!todoPanelOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (todoPanelRef.current?.contains(target) || todoButtonRef.current?.contains(target)) return
      setTodoPanelOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setTodoPanelOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [todoPanelOpen])

  useEffect(() => {
    if (!activeRunState) return
    onStatusChange(
      activeRunState.status === 'asking'
        ? t('chat.waitingForAnswer')
        : activeRunState.status === 'waiting'
          ? t('chat.waitingForPermission')
          : t('chat.statusProcessing'),
    )
  }, [activeRunState, onStatusChange, t])

  useEffect(() => {
    if (!speechRecognitionSupported) {
      setSpeechRecognitionStatus('unsupported')
      return
    }

    let disposed = false
    window.desktop?.getSpeechRecognitionStatus?.()
      .then((snapshot) => {
        if (!disposed) setSpeechRecognitionStatus(snapshot.status)
      })
      .catch(() => {
        if (!disposed) setSpeechRecognitionStatus('error')
      })

    const unsubscribe = window.desktop?.onSpeechRecognitionEvent?.((event) => {
      if (event.type === 'status') {
        setSpeechRecognitionStatus(event.status)
        if (event.status === 'requesting_permission') {
          onStatusChange(t('chat.voiceRequestingPermission'))
        } else if (event.status === 'listening') {
          ignoreSpeechRecognitionTextRef.current = false
          onStatusChange(t('chat.voiceListening'))
        } else if (event.status === 'transcribing') {
          onStatusChange(t('chat.voiceTranscribing'))
        }
        return
      }

      if (event.type === 'partial') {
        if (ignoreSpeechRecognitionTextRef.current) return
        replaceSpeechDraftText(event.text)
        return
      }

      if (event.type === 'final') {
        if (ignoreSpeechRecognitionTextRef.current) return
        if (event.text.trim()) {
          replaceSpeechDraftText(event.text)
          clearSpeechDraft()
          onStatusChange(t('chat.voiceInserted'))
        } else if (speechDraftRangeRef.current?.committedText || speechDraftRangeRef.current?.liveText) {
          clearSpeechDraft()
          onStatusChange(t('chat.voiceInserted'))
        } else {
          clearSpeechDraft()
          onStatusChange(t('chat.voiceNoSpeech'))
        }
        return
      }

      const message = speechRecognitionErrorMessage(event.code, event.message)
      ignoreSpeechRecognitionTextRef.current = false
      clearSpeechDraft()
      setSpeechRecognitionStatus('error')
      onStatusChange(message)
    })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [clearSpeechDraft, onStatusChange, replaceSpeechDraftText, speechRecognitionErrorMessage, speechRecognitionSupported, t])

  const applyGlobalModelFromSettings = useCallback(
    (snapshot: ClaudeAgentSettingsSnapshot) => {
      const settings = snapshot.settings
      const slots = {
        primary: t('chat.modelSlotPrimary'),
        haiku: t('chat.modelSlotHaiku'),
        sonnet: t('chat.modelSlotSonnet'),
        opus: t('chat.modelSlotOpus'),
      }

      setClaudeSettingsSnapshot(snapshot)
      setModelMenuRows(buildModelPickRows(settings.providers, slots, t('chat.modelFallback')))
    },
    [t],
  )

  useEffect(() => {
    if (!claudeSettingsSnapshot) return
    const settings = claudeSettingsSnapshot.settings
    const requestedPick = activeThread?.id ? activeThread.chatState.modelPick : newThreadModelPick
    const effectivePick = resolveEffectiveModelPick(settings, requestedPick)
    const row = modelRowForPick(modelMenuRows, effectivePick)
    const displayModel = row?.anthropicModelId ?? displayModelForPick(settings, effectivePick, t('chat.modelFallback'))
    const supportsImages = supportsImagesForPick(settings, effectivePick, false)
    currentModelPickRef.current = effectivePick
    setModelMenuSelectionKey(effectivePick ? modelPickKey(effectivePick) : '')
    setGlobalDisplayModel(displayModel)
    setActiveModelSupportsImages(supportsImages)
    if (!isRunningRef.current) {
      onStatusChange(compactModelName(displayModel, t))
    }
  }, [activeThread?.chatState.modelPick, activeThread?.id, claudeSettingsSnapshot, modelMenuRows, newThreadModelPick, onStatusChange, t])

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
    window.addEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => window.removeEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, onSettingsChanged)
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
    if (isRunningRef.current) return
    const pick = modelPickFromRow(row)
    if (activeThread?.id) {
      currentModelPickRef.current = pick
      setThreadChatState(activeThread.id, (prev) => {
        const changed = !sameModelPick(prev.modelPick, pick)
        return {
          ...prev,
          model: pick.anthropicModel,
          modelPick: pick,
          sessionId: changed ? undefined : prev.sessionId,
        }
      })
      setModelMenuSelectionKey(row.pickKey)
      setGlobalDisplayModel(pick.anthropicModel)
      setActiveModelSupportsImages(row.supportsImages)
      setModelPickerOpen(false)
      return
    }

    onProjectHomeModelPickChange(activeProject.id, pick)
    currentModelPickRef.current = pick
    setModelMenuSelectionKey(row.pickKey)
    setGlobalDisplayModel(pick.anthropicModel)
    setActiveModelSupportsImages(row.supportsImages)
    setModelPickerOpen(false)
  }, [activeProject.id, activeThread?.id, onProjectHomeModelPickChange, setThreadChatState])

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

  const saveActiveThreadScrollTop = useCallback(() => {
    const threadId = activeThreadIdRef.current
    const sr = scrollRegionRef.current
    if (!threadId || !sr) return
    threadScrollTopRef.current.set(threadId, sr.scrollTop)
  }, [])

  const restoreThreadScrollTop = useCallback(
    (threadId: string) => {
      const sr = scrollRegionRef.current
      const savedTop = threadScrollTopRef.current.get(threadId)
      if (!sr || savedTop === undefined) return false
      const maxTop = Math.max(0, sr.scrollHeight - sr.clientHeight)
      const previousScrollBehavior = sr.style.scrollBehavior
      sr.style.scrollBehavior = 'auto'
      sr.scrollTop = Math.min(savedTop, maxTop)
      sr.style.scrollBehavior = previousScrollBehavior
      syncScrollButtonVisibility()
      return true
    },
    [syncScrollButtonVisibility],
  )

  useLayoutEffect(() => {
    return () => saveActiveThreadScrollTop()
  }, [activeThread?.id, saveActiveThreadScrollTop])

  useEffect(() => {
    const nextThreadId = activeThread?.id ?? ''
    const hasSavedScrollTop = nextThreadId ? threadScrollTopRef.current.has(nextThreadId) : false
    activeThreadIdRef.current = nextThreadId
    isFirstTranscriptLayoutRef.current = true
    scrollIntentRef.current = hasSavedScrollTop ? 'none' : 'force-bottom'
    setShowScrollButton(false)
    setModelPickerOpen(false)
    pendingAttachmentsRef.current = []
    setPendingAttachments([])

    let frame = 0
    if (hasSavedScrollTop) {
      frame = window.requestAnimationFrame(() => {
        restoreThreadScrollTop(nextThreadId)
      })
    }

    window.claudeChat?.getSettings().then(applyGlobalModelFromSettings).catch(() => {
      /* 浏览器独立预览可能没有 Electron 桥接 / Browser preview may run without the Electron bridge */
    })
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [activeThread?.id, activeProject.id, applyGlobalModelFromSettings, restoreThreadScrollTop])

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
      if (searchHighlightTimerRef.current !== null) {
        window.clearTimeout(searchHighlightTimerRef.current)
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
    const activeThreadId = activeThread?.id ?? ''
    const hasSavedScrollTop = activeThreadId ? threadScrollTopRef.current.has(activeThreadId) : false
    let stick = scrollIntentRef.current === 'force-bottom' || isNearBottom(sr)
    if (isFirstTranscriptLayoutRef.current) {
      if (hasSavedScrollTop && restoreThreadScrollTop(activeThreadId)) {
        scrollIntentRef.current = 'none'
        isFirstTranscriptLayoutRef.current = false
        return
      }
      stick = true
      isFirstTranscriptLayoutRef.current = false
    }
    scrollIntentRef.current = 'none'
    if (stick) {
      sr.scrollTo({ top: sr.scrollHeight, behavior: 'auto' })
      saveActiveThreadScrollTop()
      setShowScrollButton(false)
    } else {
      syncScrollButtonVisibility()
    }
  }, [activeThread?.chatState, activeThread?.id, hasMessages, restoreThreadScrollTop, saveActiveThreadScrollTop, syncScrollButtonVisibility])

  useEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr) return
    const onScroll = () => {
      if (!chatItems.length) return
      saveActiveThreadScrollTop()
      syncScrollButtonVisibility()
    }
    sr.addEventListener('scroll', onScroll, { passive: true })
    return () => sr.removeEventListener('scroll', onScroll)
  }, [chatItems.length, saveActiveThreadScrollTop, syncScrollButtonVisibility])

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
    const threadId = activeThreadIdRef.current
    const targetTop = Math.max(0, sr.scrollHeight - sr.clientHeight)
    sr.scrollTo({ top: sr.scrollHeight, behavior })
    if (threadId) threadScrollTopRef.current.set(threadId, targetTop)
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
      onThreadCompletionStateChange(threadId, null)
      requestThreadIdsRef.current.set(requestId, threadId)
      const current = threadRunStatesRef.current[threadId]
      if (current && current.requestId !== requestId && !isPendingRequestId(current.requestId)) return
      if (current?.requestId === requestId && current.status === 'asking' && status === 'running') return
      if (current?.requestId === requestId && current.status === status) return
      const startedAt = current?.startedAt ?? requestStartedAtRef.current.get(requestId) ?? Date.now()
      requestStartedAtRef.current.set(requestId, startedAt)
      setThreadRunState(threadId, { requestId, status, startedAt, updatedAt: Date.now() })
    },
    [onThreadCompletionStateChange, setThreadRunState],
  )

  const finishRequest = useCallback(
    (requestId: string, statusText: string, notify = false, clearPendingRun = false, markCompleted = false) => {
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
        if (markCompleted) {
          onThreadCompletionStateChange(threadId, activeThreadIdRef.current === threadId ? null : Date.now())
        }
      }

      if (!threadId || activeThreadIdRef.current === threadId) {
        onStatusChange(statusText)
      }
      if (notify) playAgentDoneSound()
    },
    [onStatusChange, onThreadCompletionStateChange, setThreadRunState],
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

      if (event.type === 'task_create') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => applyTaskCreateEvent(prev, event))
        return
      }

      if (event.type === 'task_update') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => applyTaskUpdateEvent(prev, event))
        return
      }

      if (event.type === 'task_list') {
        markRequestRunning(eventThreadId, event.requestId)
        setThreadChatState(eventThreadId, (prev) => applyTaskListEvent(prev, event))
        return
      }

      if (event.type === 'ask_user_question' || event.type === 'permission_request') {
        markRequestRunning(eventThreadId, event.requestId, event.type === 'ask_user_question' ? 'asking' : 'waiting')
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
        finishRequest(event.requestId, compactModelName(globalDisplayModelRef.current, t), true, !knownRequestBeforeEvent, true)
        return
      }

      if (event.type === 'error') {
        const completedAt = Date.now()
        const requestStartedAt = requestStartedAtRef.current.get(event.requestId) ?? completedAt
        if (activeThreadIdRef.current === eventThreadId) scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        const shouldClearSession =
          event.code === 'sdk_error' && event.message.includes('No conversation found with session ID')
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
            return { ...prev, sessionId: shouldClearSession ? undefined : prev.sessionId, items: itemsOut }
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
    if (text.toLowerCase() === '/status' && attachmentsForSubmit.length === 0) {
      inputValueRef.current = ''
      setInputValue('')
      setComposerSelection({ start: 0, end: 0 })
      window.dispatchEvent(new CustomEvent(OPEN_AGENT_STATUS_EVENT, { detail: { refresh: true } }))
      onStatusChange(t('chat.statusPanelOpened'))
      return
    }
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
    let createdThreadModelPick: ChatModelPick | undefined
    if (!submittingThreadId) {
      const createdThreadId = onNewThread(projectForSubmit.id)
      if (!createdThreadId) return
      submittingThreadId = createdThreadId
      createdThreadModelPick = newThreadModelPick
      activeThreadIdRef.current = createdThreadId
      isFirstTranscriptLayoutRef.current = true
      scrollIntentRef.current = 'force-bottom'
    }
    if (threadRunStatesRef.current[submittingThreadId]) return

    const requestStartedAt = Date.now()
    const submittingThread = threads.find((thread) => thread.id === submittingThreadId)
    const settings = claudeSettingsSnapshot?.settings
    const modelPickForSubmit =
      target?.modelPick ??
      (settings
        ? resolveEffectiveModelPick(settings, submittingThread?.chatState.modelPick ?? createdThreadModelPick ?? currentModelPickRef.current)
        : currentModelPickRef.current)
    const modelPickChanged = !sameModelPick(submittingThread?.chatState.modelPick, modelPickForSubmit)
    const resumeSessionId = target?.resetSession || modelPickChanged
      ? undefined
      : submittingThread?.chatState.sessionId
    const handoffContext =
      !resumeSessionId && submittingThread?.chatState.items.length
        ? buildHandoffContext(submittingThread.chatState.items)
        : undefined

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
        model: modelPickForSubmit?.anthropicModel ?? prev.model,
        modelPick: modelPickForSubmit ?? prev.modelPick,
        sessionId: modelPickChanged ? undefined : prev.sessionId,
        items: [...prev.items, userMessage],
      }))
    } else if (modelPickForSubmit) {
      setThreadChatState(submittingThreadId, (prev) => ({
        ...prev,
        model: modelPickForSubmit.anthropicModel,
        modelPick: modelPickForSubmit,
        sessionId: modelPickChanged ? undefined : prev.sessionId,
      }))
    }
    setInputValue('')
    if (attachmentsForSubmit.length > 0 || !target?.threadId) {
      pendingAttachmentsRef.current = []
      setPendingAttachments([])
    }
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
      const promptMode = target?.promptMode ?? promptModeForThreadPurpose(submittingThread?.purpose)
      const { requestId } = await window.claudeChat.submit({
        text,
        attachments: attachmentsForSubmit,
        threadId: submittingThreadId,
        modelPick: modelPickForSubmit,
        handoffContext,
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
      if (
        error instanceof Error &&
        error.message.includes('No conversation found with session ID')
      ) {
        setThreadChatState(submittingThreadId, (prev) => ({
          ...prev,
          sessionId: undefined,
        }))
      }
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

  const revealMessage = useCallback(
    (messageId: string) => {
      const sr = scrollRegionRef.current
      if (!sr || !messageId) return false
      const node = sr.querySelector<HTMLElement>(`[data-transcript-item-id="${escapeCssAttributeValue(messageId)}"]`)
      if (!node) return false

      suppressTranscriptResizeStick(1400)
      scrollIntentRef.current = 'none'
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      node.classList.remove('is-search-highlight')
      void node.offsetWidth
      node.classList.add('is-search-highlight')

      if (searchHighlightTimerRef.current !== null) {
        window.clearTimeout(searchHighlightTimerRef.current)
      }
      searchHighlightTimerRef.current = window.setTimeout(() => {
        node.classList.remove('is-search-highlight')
        searchHighlightTimerRef.current = null
        syncScrollButtonVisibility()
      }, 1800)
      window.setTimeout(syncScrollButtonVisibility, 320)
      return true
    },
    [suppressTranscriptResizeStick, syncScrollButtonVisibility],
  )

  // --- `forwardRef`: tray / shell entrypoints call into here / `forwardRef`：托盘等外部入口调用的命令式 API ---

  useImperativeHandle(
    ref,
    () => ({
      startNewThread: async () => {
        const threadId = onNewThread()
        if (threadId) activeThreadIdRef.current = threadId
        const modelPick = newThreadModelPick ?? projectDefaultModelPick ?? currentModelPickRef.current
        if (threadId && modelPick) {
          setThreadChatState(threadId, (prev) => ({
            ...prev,
            model: modelPick.anthropicModel,
            modelPick,
          }))
        }
        scrollIntentRef.current = 'force-bottom'
        isFirstTranscriptLayoutRef.current = true
        onStatusChange(compactModelName(globalDisplayModelRef.current, t))
        setInputValue('')
        requestAnimationFrame(() => chatInputRef.current?.focus())
      },
      focusComposer: () => {
        requestAnimationFrame(() => chatInputRef.current?.focus())
      },
      insertComposerText: (text: string) => {
        const next = text.trim()
        if (!next) return
        setInputValue((current) => {
          const separator = current.trim().length > 0 && !current.endsWith('\n') ? '\n' : ''
          return `${current}${separator}${next}`
        })
        requestAnimationFrame(() => chatInputRef.current?.focus())
      },
      revealMessage,
      submitPromptInNewThread: async (projectId: string, prompt: string) => {
        const projectForSubmit = projects.find((project) => project.id === projectId)
        if (!projectForSubmit) return false
        const threadId = onNewThread(projectId)
        if (!threadId) return false

        activeThreadIdRef.current = threadId
        isFirstTranscriptLayoutRef.current = true
        scrollIntentRef.current = 'force-bottom'
        const modelPick = newThreadModelPick ?? projectDefaultModelPick ?? currentModelPickRef.current
        if (modelPick) {
          setThreadChatState(threadId, (prev) => ({ ...prev, model: modelPick.anthropicModel, modelPick }))
        }
        await submitPrompt(prompt, { threadId, project: projectForSubmit, modelPick })
        requestAnimationFrame(() => chatInputRef.current?.focus())
        return true
      },
      submitPromptInThread: async (
        projectId: string,
        threadId: string,
        prompt: string,
        options?: ClaudeChatSubmitPayload['promptMode'] | SubmitPromptOptions,
      ) => {
        const projectForSubmit = projects.find((project) => project.id === projectId)
        if (!projectForSubmit) return false

        const resolvedOptions: SubmitPromptOptions =
          typeof options === 'string' ? { promptMode: options } : options ?? {}
        activeThreadIdRef.current = threadId
        isFirstTranscriptLayoutRef.current = true
        scrollIntentRef.current = 'force-bottom'
        if (resolvedOptions.modelPick) {
          setThreadChatState(threadId, (prev) => ({
            ...prev,
            model: resolvedOptions.modelPick?.anthropicModel ?? prev.model,
            modelPick: resolvedOptions.modelPick,
            sessionId: sameModelPick(prev.modelPick, resolvedOptions.modelPick) ? prev.sessionId : undefined,
          }))
        }
        await submitPrompt(prompt, { threadId, project: projectForSubmit, ...resolvedOptions })
        requestAnimationFrame(() => chatInputRef.current?.focus())
        return true
      },
    }),
    [newThreadModelPick, onNewThread, onStatusChange, projectDefaultModelPick, projects, revealMessage, setThreadChatState, t],
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
    const promptThreadId = prompt.threadId ?? requestThreadIdsRef.current.get(prompt.requestId) ?? activeThreadIdRef.current
    const promptRunState = threadRunStatesRef.current[promptThreadId]
    if (promptRunState?.requestId === prompt.requestId && promptRunState.status === 'asking') {
      setThreadRunState(promptThreadId, {
        ...promptRunState,
        status: 'running',
        updatedAt: Date.now(),
      })
    }
    if (!window.claudeChat) return
    await window.claudeChat.answerPermissionRequest({
      permissionRequestId: prompt.permissionRequestId,
      ...decision,
    })
  }

  // --- Composer attachments via picker, paste, and drag/drop / 通过选择、粘贴、拖拽添加附件 ---

  const applyComposerAttachmentResult = (result: ClaudeChatAttachmentPickerResult) => {
    if (!result.ok) {
      onStatusChange(result.message)
      return
    }

    if (result.attachments.length > 0) {
      const merged = mergeComposerAttachments(pendingAttachmentsRef.current, result.attachments)
      pendingAttachmentsRef.current = merged.attachments
      setPendingAttachments(merged.attachments)
      const first = result.skipped[0] ?? merged.skipped[0]
      if (first) {
        onStatusChange(t('chat.attachmentSkipped', { name: first.name, reason: first.reason }))
      }
      return
    }

    const first = result.skipped[0]
    if (first) {
      onStatusChange(t('chat.attachmentSkipped', { name: first.name, reason: first.reason }))
    }
  }

  const addComposerAttachments = async () => {
    const pickChatAttachments = window.desktop?.pickChatAttachments
    if (!pickChatAttachments || isRunningRef.current) {
      if (!pickChatAttachments) onStatusChange(t('chat.attachmentPickerUnavailable'))
      return
    }

    applyComposerAttachmentResult(await pickChatAttachments({ allowImages: activeModelSupportsImages }))
  }

  const addComposerAttachmentPaths = async (filePaths: string[]) => {
    const readChatAttachments = window.desktop?.readChatAttachments
    if (!readChatAttachments || isRunningRef.current || filePaths.length === 0) {
      if (!readChatAttachments) onStatusChange(t('chat.attachmentPickerUnavailable'))
      return
    }

    applyComposerAttachmentResult(await readChatAttachments(filePaths, { allowImages: activeModelSupportsImages }))
  }

  const addComposerClipboardImages = async (files: File[]) => {
    if (isRunningRef.current || files.length === 0) return

    if (!activeModelSupportsImages) {
      onStatusChange(t('chat.imageInputDisabledStatus'))
      return
    }

    const attachments: ClaudeChatAttachment[] = []
    const skipped: Array<{ name: string; path: string; reason: string }> = []
    for (const [index, file] of files.slice(0, MAX_COMPOSER_ATTACHMENTS).entries()) {
      const name = file.name || `pasted-image-${Date.now()}-${index + 1}.${imageExtensionForMimeType(file.type)}`
      if (!COMPOSER_PASTE_IMAGE_MIME_TYPES.has(file.type)) {
        skipped.push({ name, path: name, reason: '仅支持 PNG、JPG、GIF、WEBP' })
        continue
      }
      if (file.size > COMPOSER_PASTE_IMAGE_MAX_BYTES) {
        skipped.push({ name, path: name, reason: '图片超过 5MB' })
        continue
      }
      if (totalAttachmentBytes(attachments) + file.size > COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES) {
        skipped.push({ name, path: name, reason: '附件总大小超过 24MB' })
        continue
      }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const base64 = dataUrl.split(',', 2)[1] ?? ''
        attachments.push({
          id: `attachment-${Date.now()}-${index}`,
          kind: 'image',
          name,
          path: `clipboard://${name}`,
          mimeType: file.type,
          size: file.size,
          base64,
          dataUrl,
          preview: formatBytes(file.size),
        })
      } catch (error) {
        skipped.push({ name, path: name, reason: error instanceof Error ? error.message : '读取失败' })
      }
    }
    if (files.length > MAX_COMPOSER_ATTACHMENTS) {
      for (const file of files.slice(MAX_COMPOSER_ATTACHMENTS)) {
        skipped.push({
          name: file.name || 'clipboard image',
          path: file.name || 'clipboard image',
          reason: `一次最多添加 ${MAX_COMPOSER_ATTACHMENTS} 个文件`,
        })
      }
    }

    applyComposerAttachmentResult({ ok: true, attachments, skipped })
  }

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    const files = dedupeFiles([...Array.from(event.clipboardData.files), ...itemFiles]).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    void addComposerClipboardImages(files)
  }

  const handleComposerDrop = (event: DragEvent<HTMLFormElement>) => {
    const filePaths = Array.from(event.dataTransfer.files)
      .map((file) => getNativeFilePath(file))
      .filter((filePath): filePath is string => Boolean(filePath))
    if (filePaths.length === 0) return
    void addComposerAttachmentPaths(filePaths)
  }

  const removeComposerAttachment = (attachmentId: string) => {
    const next = pendingAttachmentsRef.current.filter((attachment) => attachment.id !== attachmentId)
    pendingAttachmentsRef.current = next
    setPendingAttachments(next)
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

  const restartSpeechRecognitionAfterManualEdit = useCallback(() => {
    if (
      !speechRecognitionSupported ||
      speechRecognitionStatus !== 'listening' ||
      speechRestartAfterEditRef.current
    ) {
      return
    }

    speechRestartAfterEditRef.current = true
    ignoreSpeechRecognitionTextRef.current = true
    setSpeechRecognitionStatus('starting')
    onStatusChange(t('chat.voiceStarting'))

    void (async () => {
      try {
        await window.desktop?.cancelSpeechRecognition?.()
        clearSpeechDraft()
        beginSpeechDraft()
        const result = await window.desktop?.startSpeechRecognition?.({ requiresOnDevice: true })
        if (result && !result.ok) {
          ignoreSpeechRecognitionTextRef.current = false
          clearSpeechDraft()
          setSpeechRecognitionStatus(result.status)
          onStatusChange(result.message)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t('chat.voiceError')
        ignoreSpeechRecognitionTextRef.current = false
        clearSpeechDraft()
        setSpeechRecognitionStatus('error')
        onStatusChange(message)
      } finally {
        speechRestartAfterEditRef.current = false
      }
    })()
  }, [
    beginSpeechDraft,
    clearSpeechDraft,
    onStatusChange,
    speechRecognitionStatus,
    speechRecognitionSupported,
    t,
  ])

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
        const suggestion = composerSuggestions[composerSuggestionIndex] ?? composerSuggestions[0]
        if (event.key === 'Enter' && activeComposerTrigger && isComposerSuggestionAlreadyApplied(inputValue, activeComposerTrigger, suggestion)) {
          setDismissedAutocompleteKey(activeAutocompleteKey)
        } else {
          event.preventDefault()
          insertComposerSuggestion(suggestion)
          return
        }
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

  const toggleSpeechRecognition = useCallback(async () => {
    if (!speechRecognitionSupported) {
      onStatusChange(t('chat.voiceUnavailable'))
      return
    }

    const isActive = ACTIVE_SPEECH_RECOGNITION_STATUSES.has(speechRecognitionStatus)
    try {
      if (isActive) {
        if (speechRecognitionStatus === 'listening') {
          setSpeechRecognitionStatus('transcribing')
          onStatusChange(t('chat.voiceTranscribing'))
          const result = await window.desktop?.stopSpeechRecognition?.()
          if (result && !result.ok) {
            setSpeechRecognitionStatus(result.status)
            onStatusChange(result.message)
          }
          return
        }

        const result = await window.desktop?.cancelSpeechRecognition?.()
        clearSpeechDraft()
        if (result && !result.ok) {
          setSpeechRecognitionStatus(result.status)
          onStatusChange(result.message)
        }
        return
      }

      setSpeechRecognitionStatus('starting')
      beginSpeechDraft()
      onStatusChange(t('chat.voiceStarting'))
      const result = await window.desktop?.startSpeechRecognition?.({ requiresOnDevice: true })
      if (result && !result.ok) {
        clearSpeechDraft()
        setSpeechRecognitionStatus(result.status)
        onStatusChange(result.message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('chat.voiceError')
      clearSpeechDraft()
      setSpeechRecognitionStatus('error')
      onStatusChange(message)
    }
  }, [beginSpeechDraft, clearSpeechDraft, onStatusChange, speechRecognitionStatus, speechRecognitionSupported, t])

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
        modelPick: activeThread?.chatState.modelPick ?? currentModelPickRef.current,
        changeSetId: item.changeSetId,
        checkpointId: item.checkpointId,
        cwd: activeProject.path,
      })
      if (!result.ok) {
        setThreadChatState(threadId, (prev) => updateFileDiffStatus(prev, item.changeSetId, 'error', result.message || t('chat.fileDiffUnavailable')))
      }
    },
    [activeProject.path, activeThread?.chatState.modelPick, setThreadChatState, t],
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
      speechRecognitionSupported={speechRecognitionSupported}
      speechRecognitionStatus={speechRecognitionStatus}
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
        inputValueRef.current = value
        composerSelectionRef.current = { start: selectionStart, end: selectionEnd }
        if (speechDraftRangeRef.current && value !== lastSpeechAppliedValueRef.current) {
          clearSpeechDraft()
          restartSpeechRecognitionAfterManualEdit()
        }
        setInputValue(value)
        setComposerSelection({ start: selectionStart, end: selectionEnd })
        setDismissedAutocompleteKey('')
      }}
      onCompositionStart={() => setIsComposingText(true)}
      onCompositionEnd={() => setIsComposingText(false)}
      onInputKeyDown={handleInputKeydown}
      onInputPaste={handleComposerPaste}
      onSyncComposerSelection={syncComposerSelection}
      onFormSubmit={handleFormSubmit}
      onDropComposerFiles={handleComposerDrop}
      onSendClick={handleSendClick}
      onToggleSpeechRecognition={() => void toggleSpeechRecognition()}
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
    activeThread?.purpose === 'task-run' ||
    activeThread?.purpose === 'skill-run'

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
          activeRunState={activeRunState}
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
          projects={projects}
          projectOrderIds={projectOrderIds}
          composer={composer}
          agentMode={agentMode}
          agentModeEnabled={agentModeEnabled}
          todoEnabled={todoEnabled}
          agentModeLoading={agentModeLoading}
          agentSettingsOpen={agentSettingsOpen}
          agentSettingsPanel={agentSettingsPanel}
          onOpenAgentSettings={onOpenAgentSettings}
          onAgentSettingsPanelChange={onAgentSettingsPanelChange}
          onCloseAgentSettings={onCloseAgentSettings}
          threads={threads.filter((thread) => thread.projectId === activeProject.id)}
          threadRunStates={threadRunStates}
          hiddenSkillPaths={hiddenSkillPaths}
          heading={homeComposerMode === 'data-card-draft' ? t('chat.dataCardDraftHeading') : undefined}
          onStartDataCardDraft={() => {
            setHomeComposerMode('data-card-draft')
            requestAnimationFrame(() => chatInputRef.current?.focus())
          }}
          onCreateProject={onCreateProject}
          onSelectProject={onSelectProject}
          onEditHomePluginCard={(item) => onEditHomePluginCard(activeProject.id, item)}
          onOpenProjectFile={onOpenProjectFile}
          onRunProjectSkill={onRunProjectSkill}
          onStopProjectSkillRun={onStopProjectSkillRun}
        />
      )}
      {showThreadView && hasVisibleTasks ? (
        <ThreadTodoFloatingPanel
          taskState={activeTaskState}
          buttonRef={todoButtonRef}
          panelRef={todoPanelRef}
          open={todoPanelOpen}
          onOpenChange={setTodoPanelOpen}
        />
      ) : null}
      {activeUserInputPrompt ? (
        <AgentInputPromptModal prompt={activeUserInputPrompt} onResolve={(decision) => void resolveActiveUserInputPrompt(decision)} />
      ) : null}
    </section>
  )
})

function ThreadTodoFloatingPanel({
  taskState,
  buttonRef,
  panelRef,
  open,
  onOpenChange,
}: {
  taskState: ChatTaskState | undefined
  buttonRef: RefObject<HTMLButtonElement | null>
  panelRef: RefObject<HTMLDivElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const tasks = useMemo(() => (taskState?.items ?? []).filter((task) => task.status !== 'deleted'), [taskState?.items])
  if (tasks.length === 0) return null

  const completed = tasks.filter((task) => task.status === 'completed').length
  const activeTask = tasks.find((task) => task.status === 'in_progress')
  const progress = Math.round((completed / Math.max(1, tasks.length)) * 100)
  const buttonLabel = t('chat.todoPanelButton', { completed, total: tasks.length })

  return (
    <div className="thread-todo-floating">
      <button
        ref={buttonRef}
        type="button"
        className={`thread-todo-trigger${open ? ' is-open' : ''}${activeTask ? ' has-active-task' : ''}`}
        title={buttonLabel}
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-controls="thread-todo-panel"
        onClick={() => onOpenChange(!open)}
      >
        <IconInline name="checklist" />
        <span>{completed}/{tasks.length}</span>
      </button>
      {open ? (
        <section
          ref={panelRef}
          id="thread-todo-panel"
          className="thread-todo-panel"
          aria-label={t('chat.todoPanelTitle')}
        >
          <header className="thread-todo-panel__header">
            <div className="thread-todo-panel__title">
              <IconInline name="checklist" />
              <span>{t('chat.todoPanelTitle')}</span>
            </div>
            <span className="thread-todo-panel__count">{completed}/{tasks.length}</span>
          </header>
          <div className="thread-todo-panel__progress" aria-label={t('chat.todoPanelProgress', { completed, total: tasks.length })}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="thread-todo-panel__body">
            {tasks.map((task) => (
              <article key={task.id} className={`thread-todo-item thread-todo-item--${task.status}`}>
                <span className="thread-todo-item__marker" aria-hidden="true">
                  {task.status === 'completed' ? <IconInline name="check" /> : null}
                </span>
                <div className="thread-todo-item__copy">
                  <h3>{task.subject}</h3>
                  {task.status === 'in_progress' && task.activeForm ? <p>{task.activeForm}</p> : task.description ? <p>{task.description}</p> : null}
                </div>
                <span className="thread-todo-item__status">{taskStatusLabel(task.status, t)}</span>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

// --- Module-level pure helpers (no React) / 模块级纯函数（无 React 依赖）---

function taskStatusLabel(status: ChatTaskItem['status'], t: (path: string, vars?: Record<string, string | number>) => string): string {
  if (status === 'in_progress') return t('chat.todoStatusInProgress')
  if (status === 'completed') return t('chat.todoStatusCompleted')
  return t('chat.todoStatusPending')
}

function emptyTaskState(requestId: string, now = Date.now()): ChatTaskState {
  return { requestId, updatedAt: now, items: [] }
}

function taskStateForRequest(prev: ChatState, requestId: string, resetOnNewRequest: boolean): ChatTaskState {
  if (!prev.tasks) return emptyTaskState(requestId)
  if (resetOnNewRequest && prev.tasks.requestId && prev.tasks.requestId !== requestId) {
    return emptyTaskState(requestId)
  }
  return { ...prev.tasks, requestId, items: [...prev.tasks.items] }
}

function applyTaskCreateEvent(prev: ChatState, event: Extract<ClaudeChatEvent, { type: 'task_create' }>): ChatState {
  const now = Date.now()
  const tasks = taskStateForRequest(prev, event.requestId, true)
  const taskId = event.taskId || `pending:${event.toolUseId}`
  const idx = tasks.items.findIndex((task) => task.id === taskId || task.toolUseId === event.toolUseId)
  const current = idx >= 0 ? tasks.items[idx] : undefined
  const nextTask: ChatTaskItem = {
    id: taskId,
    toolUseId: event.toolUseId,
    subject: event.subject || current?.subject || taskId,
    description: event.description ?? current?.description,
    activeForm: event.activeForm ?? current?.activeForm,
    status: current?.status ?? 'pending',
    owner: current?.owner,
    blocks: current?.blocks,
    blockedBy: current?.blockedBy,
    metadata: event.metadata ?? current?.metadata,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    order: current?.order ?? tasks.items.length,
  }

  const items = idx >= 0 ? replaceAt(tasks.items, idx, nextTask) : [...tasks.items, nextTask]
  return { ...prev, tasks: { ...tasks, updatedAt: now, items: sortTasks(items) } }
}

function applyTaskUpdateEvent(prev: ChatState, event: Extract<ClaudeChatEvent, { type: 'task_update' }>): ChatState {
  const now = Date.now()
  const tasks = taskStateForRequest(prev, event.requestId, false)
  const idx = tasks.items.findIndex((task) => task.id === event.taskId)
  const current = idx >= 0 ? tasks.items[idx] : undefined
  const nextTask: ChatTaskItem = {
    id: event.taskId,
    toolUseId: current?.toolUseId ?? event.toolUseId,
    subject: event.subject ?? current?.subject ?? event.taskId,
    description: event.description ?? current?.description,
    activeForm: event.activeForm ?? current?.activeForm,
    status: event.status ?? current?.status ?? 'pending',
    owner: event.owner ?? current?.owner,
    blocks: mergeStringLists(current?.blocks, event.blocks),
    blockedBy: mergeStringLists(current?.blockedBy, event.blockedBy),
    metadata: event.metadata ?? current?.metadata,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    order: current?.order ?? tasks.items.length,
  }

  const items = idx >= 0 ? replaceAt(tasks.items, idx, nextTask) : [...tasks.items, nextTask]
  return { ...prev, tasks: { ...tasks, updatedAt: now, items: sortTasks(items) } }
}

function applyTaskListEvent(prev: ChatState, event: Extract<ClaudeChatEvent, { type: 'task_list' }>): ChatState {
  const now = Date.now()
  const existing = prev.tasks?.requestId === event.requestId ? prev.tasks.items : []
  const existingById = new Map(existing.map((task) => [task.id, task]))
  const items = event.tasks.map((task, index): ChatTaskItem => {
    const current = existingById.get(task.taskId)
    return {
      id: task.taskId,
      toolUseId: current?.toolUseId,
      subject: task.subject,
      description: task.description ?? current?.description,
      activeForm: task.activeForm ?? current?.activeForm,
      status: task.status ?? current?.status ?? 'pending',
      owner: task.owner ?? current?.owner,
      blocks: task.blocks ?? current?.blocks,
      blockedBy: task.blockedBy ?? current?.blockedBy,
      metadata: task.metadata ?? current?.metadata,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      order: current?.order ?? index,
    }
  })
  return { ...prev, tasks: { requestId: event.requestId, updatedAt: now, items: sortTasks(items) } }
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  const next = [...items]
  next[index] = item
  return next
}

function mergeStringLists(current: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!incoming || incoming.length === 0) return current
  return [...new Set([...(current ?? []), ...incoming])]
}

function sortTasks(items: ChatTaskItem[]): ChatTaskItem[] {
  return [...items].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
}

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

function isComposerSuggestionAlreadyApplied(
  value: string,
  trigger: ComposerTrigger,
  suggestion: ComposerSuggestion,
): boolean {
  const currentToken = value.slice(trigger.start, trigger.end).trim()
  const insertedToken = suggestion.insertText.trim()
  return currentToken.length > 0 && currentToken === insertedToken
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

const HANDOFF_MAX_MESSAGES = 18
const HANDOFF_MAX_CHARS = 12_000

function buildHandoffContext(items: TranscriptItem[]): string | undefined {
  const messages = items
    .filter((item): item is ChatMessageItem => item.type === 'message' && Boolean(item.content.trim()))
    .slice(-HANDOFF_MAX_MESSAGES)
  if (!messages.length) return undefined

  const lines = messages.map((message) => {
    const attachments = message.attachments?.length
      ? `\n附件：${message.attachments.map((item) => `${item.name} (${item.kind})`).join(', ')}`
      : ''
    return `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim()}${attachments}`
  })
  const omitted = messages.length < items.filter((item) => item.type === 'message').length
    ? ['较早的对话内容已省略。', '']
    : []
  const text = ['以下是当前 thread 的精简历史上下文，用于在新模型 session 中延续对话。', '', ...omitted, ...lines].join('\n')
  return text.length > HANDOFF_MAX_CHARS
    ? `${text.slice(-HANDOFF_MAX_CHARS)}\n\n（历史上下文已按长度截断。）`
    : text
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
