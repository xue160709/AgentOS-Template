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
import { flushSync } from 'react-dom'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { ClaudeChatEvent } from '../claude-chat-types'
import { IconInline } from '../icon-inline'

marked.setOptions({
  breaks: true,
  gfm: true,
})

type MessageStatus = 'done' | 'streaming' | 'error' | 'cancelled'
type ToolStatus = 'running' | 'done' | 'error' | 'denied'

type ChatMessageItem = {
  type: 'message'
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
}

type ChatToolItem = {
  type: 'tool'
  id: string
  toolUseId: string
  name: string
  inputPreview: string
  status: ToolStatus
}

type TranscriptItem = ChatMessageItem | ChatToolItem

type ChatState = {
  sessionId?: string
  model: string
  cwd?: string
  items: TranscriptItem[]
}

const CHAT_STATE_STORAGE_KEY = 'CodeX-UI-Template-chat-state-v1'

const SUGGESTIONS = [
  'Replace electron-builder placeholders before the first packaged build ships wrong metadata',
  'Make the 文档 tab render codex-ui-framework-notes.md instead of an empty placeholder',
  '审查我最近的提交记录是否存在正确性风险和可维护性隐患',
  '将你常用的应用连接到 Codex',
] as const

export type ChatPageHandle = {
  startNewThread: () => Promise<void>
}

type ChatPageProps = {
  hidden: boolean
  onStatusChange: (text: string) => void
}

function ChatMessage({ item }: { item: ChatMessageItem }) {
  const bodyHtml = useMemo(() => {
    if (item.role === 'assistant') {
      return renderMarkdown(item.content || (item.status === 'streaming' ? '' : ' '))
    }
    return `<p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>`
  }, [item.content, item.role, item.status])

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
  return (
    <div className={`tool-row tool-row--${item.status}`}>
      <span className="tool-row__dot" />
      <span className="tool-row__name">{item.name}</span>
      <span className="tool-row__status">{statusLabel[item.status]}</span>
      {item.inputPreview ? <code>{item.inputPreview}</code> : null}
    </div>
  )
}

export const ChatPage = forwardRef<ChatPageHandle, ChatPageProps>(function ChatPage(
  { hidden, onStatusChange },
  ref,
) {
  const [chatState, setChatState] = useState<ChatState>(() => loadChatState())
  const [isRunning, setIsRunning] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [isComposingText, setIsComposingText] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const scrollIntentRef = useRef<'none' | 'force-bottom'>('none')
  const isFirstTranscriptLayoutRef = useRef(true)
  const isRunningRef = useRef(false)
  const activeRequestIdRef = useRef<string | undefined>(undefined)
  const activeAssistantMessageIdRef = useRef<string | undefined>(undefined)

  const hasMessages = chatState.items.length > 0

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STATE_STORAGE_KEY, JSON.stringify(chatState))
    } catch {
      /* ignore */
    }
  }, [chatState])

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
      setShowScrollButton(!isNearBottom(sr))
    }
  }, [chatState, hasMessages])

  useEffect(() => {
    const sr = scrollRegionRef.current
    if (!sr) return
    const onScroll = () => {
      if (!chatState.items.length) return
      setShowScrollButton(!isNearBottom(sr))
    }
    sr.addEventListener('scroll', onScroll)
    return () => sr.removeEventListener('scroll', onScroll)
  }, [chatState.items.length])

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
      isRunningRef.current = false
      setIsRunning(false)
      onStatusChange(statusText)
    },
    [onStatusChange],
  )

  const handleClaudeEvent = useCallback(
    (event: ClaudeChatEvent) => {
      if (event.type === 'session_start') {
        setChatState((prev) => ({
          ...prev,
          sessionId: event.sessionId,
          model: event.model || 'Claude Agent',
          cwd: event.cwd,
        }))
        onStatusChange(compactModelName(event.model || 'Claude Agent'))
        return
      }

      if (event.type === 'assistant_delta') {
        setChatState((prev) => {
          const messageId = event.messageId
          let { items } = prev
          const idx = items.findIndex((it) => it.type === 'message' && it.id === messageId)
          if (idx >= 0) {
            const it = items[idx] as ChatMessageItem
            const next = [...items]
            next[idx] = { ...it, content: it.content + event.text, status: 'streaming' }
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

          const msg: ChatMessageItem = {
            type: 'message',
            id: messageId,
            role: 'assistant',
            content: event.text,
            status: 'streaming',
          }
          return { ...prev, items: [...items, msg] }
        })
        return
      }

      if (event.type === 'tool_start') {
        setChatState((prev) => {
          const existingIdx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (existingIdx >= 0) {
            const next = [...prev.items]
            const it = next[existingIdx] as ChatToolItem
            next[existingIdx] = { ...it, status: 'running' }
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

      if (event.type === 'tool_done') {
        setChatState((prev) => {
          const idx = prev.items.findIndex((it) => it.type === 'tool' && it.toolUseId === event.toolUseId)
          if (idx < 0) return prev
          const next = [...prev.items]
          const it = next[idx] as ChatToolItem
          next[idx] = { ...it, status: event.status }
          return { ...prev, items: next }
        })
        return
      }

      if (event.type === 'result') {
        let modelLabel = 'Claude Agent'
        flushSync(() => {
          setChatState((prev) => {
            const expectedId = `assistant-${event.requestId}`
            const pendingId = activeAssistantMessageIdRef.current
            const items = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              const content =
                !item.content.trim() && event.result.trim() ? event.result : item.content
              return { ...item, content, status: 'done' }
            })
            const next = { ...prev, sessionId: event.sessionId, items }
            modelLabel = next.model
            return next
          })
        })
        finishRequest(event.requestId, compactModelName(modelLabel))
        return
      }

      if (event.type === 'error') {
        scrollIntentRef.current = 'force-bottom'
        const expectedId = `assistant-${event.requestId}`
        flushSync(() => {
          setChatState((prev) => {
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
          setChatState((prev) => {
            const pendingId = activeAssistantMessageIdRef.current
            const items = prev.items.map((item): TranscriptItem => {
              if (item.type !== 'message' || item.role !== 'assistant') return item
              if (item.id !== expectedId && item.id !== pendingId) return item
              const content = !item.content.trim() ? '已停止。' : item.content
              return { ...item, content, status: 'cancelled' }
            })
            return { ...prev, items }
          })
        })
        finishRequest(event.requestId, '已停止')
      }
    },
    [finishRequest, onStatusChange],
  )

  useEffect(() => {
    const unsub = window.claudeChat?.onEvent((ev) => handleClaudeEvent(ev))
    return () => {
      unsub?.()
    }
  }, [handleClaudeEvent])

  useImperativeHandle(ref, () => ({
    startNewThread: async () => {
      if (window.claudeChat) {
        await window.claudeChat.newThread()
      }
      scrollIntentRef.current = 'force-bottom'
      isFirstTranscriptLayoutRef.current = true
      activeRequestIdRef.current = undefined
      activeAssistantMessageIdRef.current = undefined
      isRunningRef.current = false
      setIsRunning(false)
      setChatState({ model: 'Claude Agent', items: [] })
      onStatusChange('Claude Agent')
      setInputValue('')
      requestAnimationFrame(() => chatInputRef.current?.focus())
    },
  }))

  const submitPrompt = async (rawText: string) => {
    const text = rawText.trim()
    if (!text || isRunningRef.current) return

    const optimisticAssistantId = `assistant-pending-${Date.now()}`
    const userMessage: ChatMessageItem = {
      type: 'message',
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      status: 'done',
    }
    const assistantMessage: ChatMessageItem = {
      type: 'message',
      id: optimisticAssistantId,
      role: 'assistant',
      content: '',
      status: 'streaming',
    }

    scrollIntentRef.current = 'force-bottom'
    setChatState((prev) => ({
      ...prev,
      items: [...prev.items, userMessage, assistantMessage],
    }))
    setInputValue('')
    setIsRunning(true)
    isRunningRef.current = true
    activeAssistantMessageIdRef.current = optimisticAssistantId
    onStatusChange('处理中')

    if (!window.claudeChat) {
      scrollIntentRef.current = 'force-bottom'
      setChatState((prev) => ({
        ...prev,
        items: prev.items.map((item) => {
          if (item.type === 'message' && item.id === optimisticAssistantId) {
            return {
              ...item,
              status: 'error',
              content: 'Claude bridge unavailable. 请在 Electron 环境中运行应用。',
            }
          }
          return item
        }),
      }))
      setIsRunning(false)
      isRunningRef.current = false
      activeAssistantMessageIdRef.current = undefined
      onStatusChange('桥接不可用')
      return
    }

    try {
      const { requestId } = await window.claudeChat.submit({ text })
      const newAssistantId = `assistant-${requestId}`
      scrollIntentRef.current = 'force-bottom'
      setChatState((prev) => ({
        ...prev,
        items: prev.items.map((item) => {
          if (item.type === 'message' && item.id === optimisticAssistantId) {
            return { ...item, id: newAssistantId }
          }
          return item
        }),
      }))
      activeRequestIdRef.current = requestId
      activeAssistantMessageIdRef.current = newAssistantId
    } catch (error) {
      scrollIntentRef.current = 'force-bottom'
      setChatState((prev) => ({
        ...prev,
        items: prev.items.map((item) => {
          if (item.type === 'message' && item.id === optimisticAssistantId) {
            return {
              ...item,
              status: 'error',
              content: error instanceof Error ? error.message : String(error),
            }
          }
          return item
        }),
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
          {chatState.items.map((item) =>
            item.type === 'tool' ? <ToolRow key={item.id} item={item} /> : <ChatMessage key={item.id} item={item} />,
          )}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-scroll-bottom"
        id="btn-scroll-bottom"
        title="滚动到底部"
        aria-label="滚动到底部"
        hidden={!hasMessages || !showScrollButton}
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
            onChange={(e) => setInputValue(e.target.value)}
            onCompositionStart={() => setIsComposingText(true)}
            onCompositionEnd={() => setIsComposingText(false)}
            onKeyDown={handleInputKeydown}
          />
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
              <button type="button" className="composer-model-button" title="模型" aria-label="模型">
                <span id="composer-model">{compactModelName(chatState.model)}</span>
                <IconInline name="chevron" />
              </button>
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

        {/* 关掉，需要再打开
        <div className="chat-context-strip" aria-label="当前上下文">
          <span>
            <IconInline name="folder" />
            <span>CodeX-UI-Template</span>
            <IconInline name="chevron" />
          </span>
          <span>
            <IconInline name="laptop" />
            <span>本地模式</span>
            <IconInline name="chevron" />
          </span>
          <span>
            <IconInline name="branch" />
            <span>main</span>
            <IconInline name="chevron" />
          </span>
        </div>
        */}
      </div>
      <div className="chat-suggestions" id="chat-suggestions" aria-label="建议提示" hidden={hasMessages}>
        {SUGGESTIONS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            data-prompt={prompt}
            onClick={() => {
              setInputValue(prompt)
              requestAnimationFrame(() => {
                chatInputRef.current?.focus()
                resizeComposer()
              })
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
})

function loadChatState(): ChatState {
  try {
    const raw = localStorage.getItem(CHAT_STATE_STORAGE_KEY)
    if (!raw) return { model: 'Claude Agent', items: [] }
    const parsed = JSON.parse(raw) as Partial<ChatState>
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : 'Claude Agent',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      items: Array.isArray(parsed.items) ? normalizeTranscriptItems(parsed.items) : [],
    }
  } catch {
    return { model: 'Claude Agent', items: [] }
  }
}

function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    USE_PROFILES: { html: true },
  })
}

function normalizeTranscriptItems(items: unknown[]): TranscriptItem[] {
  const normalized: TranscriptItem[] = []

  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.type !== 'string') continue

    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
      normalized.push({
        type: 'message',
        id: item.id,
        role: item.role,
        content: typeof item.content === 'string' ? item.content : '',
        status: item.status === 'error' || item.status === 'cancelled' ? item.status : 'done',
      })
      continue
    }

    if (item.type === 'tool' && typeof item.toolUseId === 'string' && typeof item.name === 'string') {
      normalized.push({
        type: 'tool',
        id: item.id,
        toolUseId: item.toolUseId,
        name: item.name,
        inputPreview: typeof item.inputPreview === 'string' ? item.inputPreview : '',
        status: item.status === 'error' || item.status === 'denied' ? item.status : 'done',
      })
    }
  }

  return normalized
}

function compactModelName(model: string): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNearBottom(scrollRegion: HTMLElement): boolean {
  if (scrollRegion.hidden) return true
  const remaining = scrollRegion.scrollHeight - scrollRegion.scrollTop - scrollRegion.clientHeight
  return remaining < 96
}
