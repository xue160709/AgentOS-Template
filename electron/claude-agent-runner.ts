import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeAskUserQuestion,
  ClaudeAgentResolvedConfig,
  ClaudeChatAttachment,
  ClaudeChatEvent,
  ClaudeChatSubmitPayload,
  ClaudeChatSubmitResult,
  ClaudePermissionMode,
  ClaudePermissionResponsePayload,
} from '../src/claude-chat-types'
import type { AgentModeProjectSettings } from '../src/desktop-types'
import { buildRuntimeContext, resolvePromptWithContext } from './agent-context'
import {
  buildSdkEnv,
  getConfigSignature,
  summarizeConfigForLog,
  summarizeErrorForLog,
  summarizeSdkEnvForLog,
} from './claude-agent-runner/config'
import { ClaudeChatEventCoalescer } from './claude-agent-runner/event-coalescer'
import { buildSdkPromptInput, normalizeSubmitAttachments, resolveWorkspaceCwd } from './claude-agent-runner/input'
import { ClaudeSdkMessageRouter } from './claude-agent-runner/sdk-message-router'

export const CLAUDE_CHAT_EVENT_CHANNEL = 'claude-chat:event'

type ActiveRequest = {
  requestId: string
  assistantMessageId: string
  threadId: string
  cwd: string
  abortController: AbortController
  query?: Query
  cancelled: boolean
  didEmitText: boolean
  didEmitThinking: boolean
  permissionMode: ClaudePermissionMode
  seenToolUseIds: Set<string>
  streamBlocks: Map<number, StreamBlockState>
}

const READ_ONLY_AUTO_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'ListMcpResources', 'ReadMcpResource']
const DEFAULT_AGENT_TOOLS = { type: 'preset', preset: 'claude_code' } as const
type PendingPermissionRequest = {
  requestId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  abortSignal: AbortSignal
  abortListener: () => void
  resolve: (result: PermissionResult) => void
}

type ThreadRuntimeState = {
  sessionId?: string
  model: string
  configSignature?: string
}

type StreamBlockState = {
  id: string
  type: 'text' | 'thinking' | 'tool' | 'other'
  toolUseId?: string
  inputJson: string
}

export class ClaudeAgentRunner {
  private readonly activeRequests = new Map<string, ActiveRequest>()
  private readonly activeRequestIdsByThread = new Map<string, string>()
  private readonly defaultThreadId = 'default'
  private readonly threadRuntimeStates = new Map<string, ThreadRuntimeState>()
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>()
  private readonly eventCoalescer: ClaudeChatEventCoalescer
  private readonly messageRouter: ClaudeSdkMessageRouter

  constructor(
    private readonly webContents: WebContents,
    private readonly cwd: string,
    private readonly resolveConfig: () => ClaudeAgentResolvedConfig,
    private readonly resolveAgentModeSettings: (rootPath: string) => Promise<AgentModeProjectSettings>,
  ) {
    this.eventCoalescer = new ClaudeChatEventCoalescer((event) => this.sendEventNow(event))
    this.messageRouter = new ClaudeSdkMessageRouter(
      (event) => this.emit(event),
      (threadId) => this.getThreadRuntimeState(threadId),
    )
  }

  submit(payload: ClaudeChatSubmitPayload): ClaudeChatSubmitResult {
    const text = payload.text.trim()
    const attachments = normalizeSubmitAttachments(payload.attachments)
    const requestId = randomUUID()
    const threadId = this.normalizeThreadId(payload.threadId)

    if (!text && attachments.length === 0) {
      this.emit({
        type: 'error',
        requestId,
        code: 'empty_prompt',
        message: '请输入要发送给 Claude 的内容。',
      })
      return { requestId }
    }

    const cwd = resolveWorkspaceCwd(payload.cwd, this.cwd)
    const previousRequestId = this.activeRequestIdsByThread.get(threadId)
    if (previousRequestId) {
      void this.cancel(previousRequestId)
    }

    const activeRequest: ActiveRequest = {
      requestId,
      assistantMessageId: `assistant-${requestId}`,
      threadId,
      cwd,
      abortController: new AbortController(),
      cancelled: false,
      didEmitText: false,
      didEmitThinking: false,
      permissionMode: normalizeChatPermissionMode(payload.permissionMode),
      seenToolUseIds: new Set(),
      streamBlocks: new Map(),
    }

    this.activeRequests.set(requestId, activeRequest)
    this.activeRequestIdsByThread.set(threadId, requestId)
    void this.run(text, attachments, activeRequest)

    return { requestId }
  }

  async cancel(requestId?: string): Promise<void> {
    if (requestId) {
      const activeRequest = this.activeRequests.get(requestId)
      if (!activeRequest) return
      this.cancelRequest(activeRequest)
      return
    }

    for (const activeRequest of this.activeRequests.values()) {
      this.cancelRequest(activeRequest)
    }
  }

  private cancelRequest(activeRequest: ActiveRequest): void {
    if (activeRequest.cancelled) return
    activeRequest.cancelled = true
    activeRequest.abortController.abort()
    activeRequest.query?.close()
    this.denyPendingRequests(activeRequest.requestId, 'Request cancelled.')

    this.emit({
      type: 'cancelled',
      requestId: activeRequest.requestId,
    })
  }

  async newThread(threadId?: string): Promise<void> {
    const normalizedThreadId = this.normalizeThreadId(threadId)
    if (!threadId) {
      await this.cancel()
    } else {
      const activeRequestId = this.activeRequestIdsByThread.get(normalizedThreadId)
      if (activeRequestId) await this.cancel(activeRequestId)
    }
    this.threadRuntimeStates.delete(normalizedThreadId)
  }

  async answerPermissionRequest(payload: ClaudePermissionResponsePayload): Promise<void> {
    const pending = this.pendingPermissionRequests.get(payload.permissionRequestId)
    if (!pending) return

    if (payload.behavior === 'allow') {
      this.resolvePendingPermission(payload.permissionRequestId, {
        behavior: 'allow',
        updatedInput: payload.updatedInput ?? pending.input,
        toolUseID: pending.toolUseId,
      })
      this.emit({
        type: 'tool_update',
        requestId: pending.requestId,
        toolUseId: pending.toolUseId,
        detail: pending.toolName === 'AskUserQuestion' ? '已收到用户回答' : '已允许',
      })
      return
    }

    this.resolvePendingPermission(payload.permissionRequestId, {
      behavior: 'deny',
      message: payload.message || 'Denied by user.',
      toolUseID: pending.toolUseId,
    })
    this.emit({
      type: 'tool_done',
      requestId: pending.requestId,
      toolUseId: pending.toolUseId,
      status: 'denied',
      detail: payload.message || '用户已拒绝',
    })
  }

  private async run(prompt: string, attachments: ClaudeChatAttachment[], activeRequest: ActiveRequest): Promise<void> {
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

    const imageAttachmentCount = attachments.filter((attachment) => attachment.kind === 'image').length
    if (imageAttachmentCount > 0 && !config.supportsImages) {
      this.emit({
        type: 'error',
        requestId: activeRequest.requestId,
        code: 'image_input_disabled',
        message: '当前模型未开启图片输入。请在设置 · 模型中为该模型打开图片开关。',
      })
      this.finish(activeRequest)
      return
    }

    try {
      const runtimeContext = await buildRuntimeContext(
        activeRequest.cwd,
        await this.resolveAgentModeSettings(activeRequest.cwd),
      )
      const resolvedPrompt = await resolvePromptWithContext(prompt, runtimeContext.catalog)
      const promptInput = buildSdkPromptInput(resolvedPrompt, attachments)
      const sdkEnv = buildSdkEnv(config)
      if (attachments.length > 0) {
        this.emitActivity(
          activeRequest,
          'user-attachments',
          '已添加附件',
          'done',
          joinDetails([
            `${attachments.length} 个文件`,
            imageAttachmentCount ? `${imageAttachmentCount} 张图片` : '',
          ]),
          attachments.map((attachment) => `${attachment.kind}: ${attachment.name}`).join('\n'),
        )
      }
      console.info('[ClaudeAgentRunner] starting SDK query', {
        requestId: activeRequest.requestId,
        threadId: activeRequest.threadId,
        cwd: activeRequest.cwd,
        permissionMode: activeRequest.permissionMode,
        attachmentCount: attachments.length,
        imageAttachmentCount,
        config: summarizeConfigForLog(config),
        sdkEnv: summarizeSdkEnvForLog(sdkEnv),
      })
      const response = query({
        prompt: promptInput,
        options: {
          abortController: activeRequest.abortController,
          agents: runtimeContext.agents,
          allowDangerouslySkipPermissions: activeRequest.permissionMode === 'bypassPermissions' ? true : undefined,
          allowedTools: READ_ONLY_AUTO_ALLOWED_TOOLS,
          canUseTool: (toolName, input, options) => this.handleCanUseTool(activeRequest, toolName, input, options),
          cwd: activeRequest.cwd,
          env: sdkEnv,
          forwardSubagentText: true,
          includeHookEvents: true,
          includePartialMessages: true,
          // Third-party Anthropic-compatible endpoints such as SiliconFlow expect
          // custom models through ANTHROPIC_MODEL. Passing options.model makes
          // Claude Code treat the value as its own model flag and can trigger
          // false "model does not exist" errors.
          permissionMode: toSdkPermissionMode(activeRequest.permissionMode),
          resume: threadState.sessionId,
          // Keep this app's provider settings authoritative. Claude Code user or
          // project settings may contain another model (for example glm-5.1) and
          // otherwise override the model shown in this UI.
          settingSources: [],
          skills: 'all',
          systemPrompt: runtimeContext.appendSystemPrompt
            ? { type: 'preset', preset: 'claude_code', append: runtimeContext.appendSystemPrompt }
            : undefined,
          toolConfig: {
            askUserQuestion: { previewFormat: 'markdown' },
          },
          tools: DEFAULT_AGENT_TOOLS,
        },
      })

      activeRequest.query = response

      for await (const message of response) {
        if (activeRequest.cancelled) break
        this.messageRouter.handleSdkMessage(message, activeRequest)
      }
    } catch (error) {
      if (!activeRequest.cancelled) {
        console.error('[ClaudeAgentRunner] SDK query failed', {
          requestId: activeRequest.requestId,
          config: summarizeConfigForLog(config),
          error: summarizeErrorForLog(error),
        })
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
    this.eventCoalescer.flushRequest(activeRequest.requestId)
    this.denyPendingRequests(activeRequest.requestId, 'Request finished.')
    this.activeRequests.delete(activeRequest.requestId)
    if (this.activeRequestIdsByThread.get(activeRequest.threadId) === activeRequest.requestId) {
      this.activeRequestIdsByThread.delete(activeRequest.threadId)
    }
  }

  private async handleCanUseTool(
    activeRequest: ActiveRequest,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (activeRequest.cancelled || options.signal.aborted) {
      return { behavior: 'deny', message: 'Request cancelled.', toolUseID: options.toolUseID }
    }

    const permissionRequestId = randomUUID()
    const toolUseId = options.toolUseID || `permission-${permissionRequestId}`
    const pendingResult = new Promise<PermissionResult>((resolve) => {
      const abortListener = () => {
        this.resolvePendingPermission(permissionRequestId, {
          behavior: 'deny',
          message: 'Request cancelled.',
          toolUseID: toolUseId,
        })
      }

      options.signal.addEventListener('abort', abortListener, { once: true })
      this.pendingPermissionRequests.set(permissionRequestId, {
        requestId: activeRequest.requestId,
        toolUseId,
        toolName,
        input,
        abortSignal: options.signal,
        abortListener,
        resolve,
      })
    })

    if (toolName === 'AskUserQuestion') {
      const questions = normalizeAskUserQuestions(input)
      if (questions.length === 0) {
        this.resolvePendingPermission(permissionRequestId, {
          behavior: 'allow',
          updatedInput: input,
          toolUseID: toolUseId,
        })
        return pendingResult
      }

      this.emit({
        type: 'ask_user_question',
        requestId: activeRequest.requestId,
        permissionRequestId,
        toolUseId,
        questions,
      })
      this.emitActivity(activeRequest, `ask-user-question-${permissionRequestId}`, '等待用户输入', 'running', `${questions.length} 个问题`)
      return pendingResult
    }

    this.emit({
      type: 'permission_request',
      requestId: activeRequest.requestId,
      permissionRequestId,
      toolUseId,
      toolName,
      title: options.title || `${toolName} 需要权限`,
      displayName: options.displayName || toolName,
      description: options.description || '',
      inputPreview: previewValue(input),
    })
    this.emitActivity(activeRequest, `permission-request-${permissionRequestId}`, '等待权限确认', 'running', options.displayName || toolName)
    return pendingResult
  }

  private resolvePendingPermission(permissionRequestId: string, result: PermissionResult): boolean {
    const pending = this.pendingPermissionRequests.get(permissionRequestId)
    if (!pending) return false

    this.pendingPermissionRequests.delete(permissionRequestId)
    pending.abortSignal.removeEventListener('abort', pending.abortListener)
    pending.resolve(result)
    return true
  }

  private denyPendingRequests(requestId: string, message: string): void {
    for (const [permissionRequestId, pending] of this.pendingPermissionRequests) {
      if (pending.requestId !== requestId) continue
      this.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message,
        toolUseID: pending.toolUseId,
      })
    }
  }

  private emitActivity(
    activeRequest: ActiveRequest,
    key: string,
    title: string,
    status: 'running' | 'done' | 'error' | 'info',
    detail?: string,
    preview?: string,
  ): void {
    this.emit({
      type: 'agent_activity',
      requestId: activeRequest.requestId,
      activityId: `activity-${activeRequest.requestId}-${key}`,
      title,
      status,
      detail,
      preview,
    })
  }

  private emit(event: ClaudeChatEvent): void {
    if (this.webContents.isDestroyed()) return
    const threadId = event.threadId ?? this.activeRequests.get(event.requestId)?.threadId
    this.eventCoalescer.emit(threadId ? { ...event, threadId } : event)
  }

  private sendEventNow(event: ClaudeChatEvent): void {
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

}

function joinDetails(parts: Array<string | undefined | null | false>): string | undefined {
  const text = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ')
  return text || undefined
}

function previewValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    const json = JSON.stringify(value)
    if (!json) return ''
    return truncate(json, 180)
  } catch {
    return truncate(String(value), 180)
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeChatPermissionMode(value: ClaudePermissionMode | undefined): ClaudePermissionMode {
  if (value === 'plan' || value === 'default' || value === 'bypassPermissions') return value
  return 'auto'
}

function toSdkPermissionMode(value: ClaudePermissionMode): PermissionMode {
  return value
}

function normalizeAskUserQuestions(input: Record<string, unknown>): ClaudeAskUserQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  return rawQuestions
    .map((question): ClaudeAskUserQuestion | undefined => {
      if (!isRecord(question) || typeof question.question !== 'string') return undefined
      const options = normalizeAskUserQuestionOptions(question.options)
      if (options.length < 2) return undefined
      return {
        question: question.question,
        header: typeof question.header === 'string' ? question.header : 'Question',
        options,
        multiSelect: question.multiSelect === true,
      }
    })
    .filter((question): question is ClaudeAskUserQuestion => Boolean(question))
}

function normalizeAskUserQuestionOptions(value: unknown): ClaudeAskUserQuestion['options'] {
  if (!Array.isArray(value)) return []
  const options: ClaudeAskUserQuestion['options'] = []
  for (const option of value) {
    if (!isRecord(option) || typeof option.label !== 'string') continue
    const normalized: ClaudeAskUserQuestion['options'][number] = {
      label: option.label,
      description: typeof option.description === 'string' ? option.description : '',
    }
    if (typeof option.preview === 'string') normalized.preview = option.preview
    options.push(normalized)
  }
  return options
}
