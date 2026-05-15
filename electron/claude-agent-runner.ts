import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeAgentResolvedConfig,
  ClaudeChatEvent,
  ClaudeChatSubmitPayload,
  ClaudeChatSubmitResult,
} from '../src/claude-chat-types'

export const CLAUDE_CHAT_EVENT_CHANNEL = 'claude-chat:event'

type ActiveRequest = {
  requestId: string
  assistantMessageId: string
  threadId: string
  abortController: AbortController
  query?: Query
  cancelled: boolean
  didEmitText: boolean
  seenToolUseIds: Set<string>
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep']

type ThreadRuntimeState = {
  sessionId?: string
  model: string
  configSignature?: string
}

export class ClaudeAgentRunner {
  private activeRequest?: ActiveRequest
  private readonly defaultThreadId = 'default'
  private readonly threadRuntimeStates = new Map<string, ThreadRuntimeState>()

  constructor(
    private readonly webContents: WebContents,
    private readonly cwd: string,
    private readonly resolveConfig: () => ClaudeAgentResolvedConfig,
  ) {}

  submit(payload: ClaudeChatSubmitPayload): ClaudeChatSubmitResult {
    const text = payload.text.trim()
    const requestId = randomUUID()
    const threadId = this.normalizeThreadId(payload.threadId)

    if (!text) {
      this.emit({
        type: 'error',
        requestId,
        code: 'empty_prompt',
        message: '请输入要发送给 Claude 的内容。',
      })
      return { requestId }
    }

    if (this.activeRequest) {
      this.cancel(this.activeRequest.requestId)
    }

    const activeRequest: ActiveRequest = {
      requestId,
      assistantMessageId: `assistant-${requestId}`,
      threadId,
      abortController: new AbortController(),
      cancelled: false,
      didEmitText: false,
      seenToolUseIds: new Set(),
    }

    this.activeRequest = activeRequest
    void this.run(text, activeRequest)

    return { requestId }
  }

  async cancel(requestId?: string): Promise<void> {
    const activeRequest = this.activeRequest
    if (!activeRequest) return
    if (requestId && requestId !== activeRequest.requestId) return

    activeRequest.cancelled = true
    activeRequest.abortController.abort()
    activeRequest.query?.close()

    this.emit({
      type: 'cancelled',
      requestId: activeRequest.requestId,
    })
  }

  async newThread(threadId?: string): Promise<void> {
    const normalizedThreadId = this.normalizeThreadId(threadId)
    if (!threadId || this.activeRequest?.threadId === normalizedThreadId) {
      await this.cancel()
    }
    this.threadRuntimeStates.delete(normalizedThreadId)
  }

  private async run(prompt: string, activeRequest: ActiveRequest): Promise<void> {
    const config = this.resolveConfig()
    const threadState = this.getThreadRuntimeState(activeRequest.threadId)
    const nextConfigSignature = getConfigSignature(config)
    if (threadState.configSignature && threadState.configSignature !== nextConfigSignature) {
      threadState.sessionId = undefined
    }
    threadState.configSignature = nextConfigSignature

    if (!config.apiKey && !config.authToken) {
      this.emit({
        type: 'error',
        requestId: activeRequest.requestId,
        code: 'missing_api_key',
        message:
          config.configSource === 'env'
            ? '缺少 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。请在项目根目录 .env.local 或系统环境变量中设置后重启应用。'
            : '缺少 Claude API Key。请在设置页填写 API Key，或切换为环境变量模式。',
      })
      this.finish(activeRequest)
      return
    }

    try {
      const response = query({
        prompt,
        options: {
          abortController: activeRequest.abortController,
          allowedTools: READ_ONLY_TOOLS,
          cwd: this.cwd,
          env: this.buildSdkEnv(config),
          includePartialMessages: true,
          model: config.model || undefined,
          permissionMode: 'dontAsk',
          resume: threadState.sessionId,
          settingSources: [],
          tools: READ_ONLY_TOOLS,
        },
      })

      activeRequest.query = response

      for await (const message of response) {
        if (activeRequest.cancelled) break
        this.handleSdkMessage(message, activeRequest)
      }
    } catch (error) {
      if (!activeRequest.cancelled) {
        this.emit({
          type: 'error',
          requestId: activeRequest.requestId,
          code: 'sdk_error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      this.finish(activeRequest)
    }
  }

  private finish(activeRequest: ActiveRequest): void {
    if (this.activeRequest?.requestId === activeRequest.requestId) {
      this.activeRequest = undefined
    }
  }

  private handleSdkMessage(message: SDKMessage, activeRequest: ActiveRequest): void {
    if (message.type === 'system') {
      this.handleSystemMessage(message, activeRequest)
      return
    }

    if (message.type === 'stream_event') {
      this.handleStreamEvent(message, activeRequest)
      return
    }

    if (message.type === 'assistant') {
      this.handleAssistantMessage(message, activeRequest)
      return
    }

    if (message.type === 'user') {
      this.handleUserMessage(message, activeRequest)
      return
    }

    if (message.type === 'result') {
      const threadState = this.getThreadRuntimeState(activeRequest.threadId)
      threadState.sessionId = message.session_id
      const result = 'result' in message ? message.result : message.errors.join('\n')
      if (result && !activeRequest.didEmitText) {
        this.emitAssistantDelta(activeRequest, result)
      }
      this.emit({
        type: 'result',
        requestId: activeRequest.requestId,
        sessionId: message.session_id,
        result,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
      })
    }
  }

  private handleSystemMessage(message: Extract<SDKMessage, { type: 'system' }>, activeRequest: ActiveRequest): void {
    if (message.subtype === 'init') {
      const threadState = this.getThreadRuntimeState(activeRequest.threadId)
      threadState.sessionId = message.session_id
      threadState.model = message.model || 'Claude Agent'
      this.emit({
        type: 'session_start',
        requestId: activeRequest.requestId,
        sessionId: message.session_id,
        model: threadState.model,
        cwd: message.cwd || this.cwd,
      })
      return
    }

    if (message.subtype === 'permission_denied') {
      this.emit({
        type: 'tool_done',
        requestId: activeRequest.requestId,
        toolUseId: message.tool_use_id,
        status: 'denied',
      })
    }
  }

  private handleStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>, activeRequest: ActiveRequest): void {
    const event = message.event

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      this.emitAssistantDelta(activeRequest, event.delta.text)
      return
    }

    if (event.type === 'content_block_start') {
      this.emitToolStartFromBlock(event.content_block, activeRequest)
    }
  }

  private handleAssistantMessage(message: Extract<SDKMessage, { type: 'assistant' }>, activeRequest: ActiveRequest): void {
    const content = message.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        this.emitToolStartFromBlock(block, activeRequest)
      }
    }

    const text = extractTextFromContent(content)
    if (text && !activeRequest.didEmitText) {
      this.emitAssistantDelta(activeRequest, text)
    }
  }

  private handleUserMessage(message: Extract<SDKMessage, { type: 'user' }>, activeRequest: ActiveRequest): void {
    const content = message.message.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        continue
      }

      this.emit({
        type: 'tool_done',
        requestId: activeRequest.requestId,
        toolUseId: block.tool_use_id,
        status: block.is_error === true ? 'error' : 'done',
      })
    }
  }

  private emitToolStartFromBlock(block: unknown, activeRequest: ActiveRequest): void {
    if (!isRecord(block)) return
    if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') return

    const toolUseId = typeof block.id === 'string' ? block.id : undefined
    const name = getToolName(block)
    if (!toolUseId || !name || activeRequest.seenToolUseIds.has(toolUseId)) return

    activeRequest.seenToolUseIds.add(toolUseId)
    this.emit({
      type: 'tool_start',
      requestId: activeRequest.requestId,
      toolUseId,
      name,
      inputPreview: previewValue(block.input),
    })
  }

  private emitAssistantDelta(activeRequest: ActiveRequest, text: string): void {
    activeRequest.didEmitText = true
    this.emit({
      type: 'assistant_delta',
      requestId: activeRequest.requestId,
      messageId: activeRequest.assistantMessageId,
      text,
    })
  }

  private emit(event: ClaudeChatEvent): void {
    if (this.webContents.isDestroyed()) return
    this.webContents.send(CLAUDE_CHAT_EVENT_CHANNEL, event)
  }

  private normalizeThreadId(threadId?: string): string {
    const trimmed = threadId?.trim()
    return trimmed || this.defaultThreadId
  }

  private getThreadRuntimeState(threadId: string): ThreadRuntimeState {
    const existing = this.threadRuntimeStates.get(threadId)
    if (existing) return existing
    const next: ThreadRuntimeState = { model: 'Claude Agent' }
    this.threadRuntimeStates.set(threadId, next)
    return next
  }

  private buildSdkEnv(config: ClaudeAgentResolvedConfig): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-ui-template/0.0.0',
    }

    if (config.authToken) {
      env.ANTHROPIC_AUTH_TOKEN = config.authToken
      env.ANTHROPIC_API_KEY = undefined
    } else if (config.apiKey) {
      env.ANTHROPIC_API_KEY = config.apiKey
      env.ANTHROPIC_AUTH_TOKEN = undefined
    }
    if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl
    if (config.model) env.ANTHROPIC_MODEL = config.model
    if (config.defaultHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.defaultHaikuModel
    if (config.defaultOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.defaultOpusModel
    if (config.defaultSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.defaultSonnetModel

    return env
  }
}

function getConfigSignature(config: ClaudeAgentResolvedConfig): string {
  return JSON.stringify([
    config.configSource,
    config.apiKey,
    config.authToken,
    config.baseUrl,
    config.model,
    config.defaultHaikuModel,
    config.defaultOpusModel,
    config.defaultSonnetModel,
  ])
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return ''
      return block.text
    })
    .join('')
}

function getToolName(block: Record<string, unknown>): string {
  if (typeof block.name === 'string') return block.name
  if (typeof block.tool_name === 'string') return block.tool_name
  if (typeof block.server_name === 'string') return block.server_name
  return 'Tool'
}

function previewValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    const json = JSON.stringify(value)
    if (!json) return ''
    return json.length > 180 ? `${json.slice(0, 177)}...` : json
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
