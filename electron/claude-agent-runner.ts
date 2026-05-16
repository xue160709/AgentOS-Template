import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
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
import { buildRuntimeContext, resolvePromptWithContext } from './agent-context'

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
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
type SDKUserMessageContent = Exclude<SDKUserMessage['message']['content'], string>

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
  private activeRequest?: ActiveRequest
  private readonly defaultThreadId = 'default'
  private readonly threadRuntimeStates = new Map<string, ThreadRuntimeState>()
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>()

  constructor(
    private readonly webContents: WebContents,
    private readonly cwd: string,
    private readonly resolveConfig: () => ClaudeAgentResolvedConfig,
  ) {}

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

    if (this.activeRequest) {
      this.cancel(this.activeRequest.requestId)
    }

    const cwd = resolveWorkspaceCwd(payload.cwd, this.cwd)

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

    this.activeRequest = activeRequest
    void this.run(text, attachments, activeRequest)

    return { requestId }
  }

  async cancel(requestId?: string): Promise<void> {
    const activeRequest = this.activeRequest
    if (!activeRequest) return
    if (requestId && requestId !== activeRequest.requestId) return

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
    if (!threadId || this.activeRequest?.threadId === normalizedThreadId) {
      await this.cancel()
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
      const runtimeContext = await buildRuntimeContext(activeRequest.cwd)
      const resolvedPrompt = await resolvePromptWithContext(prompt, runtimeContext.catalog)
      const promptInput = buildSdkPromptInput(resolvedPrompt, attachments)
      const sdkEnv = this.buildSdkEnv(config)
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
        this.handleSdkMessage(message, activeRequest)
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
    this.denyPendingRequests(activeRequest.requestId, 'Request finished.')
    if (this.activeRequest?.requestId === activeRequest.requestId) {
      this.activeRequest = undefined
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

    if (this.handleStandaloneSdkMessage(message, activeRequest)) {
      return
    }

    if (message.type === 'result') {
      const threadState = this.getThreadRuntimeState(activeRequest.threadId)
      threadState.sessionId = message.session_id
      const result = 'result' in message ? message.result : message.errors.join('\n')
      if (result && !activeRequest.didEmitText) {
        this.emitAssistantDelta(activeRequest, result)
      }
      this.emitActivity(
        activeRequest,
        'result',
        message.subtype === 'success' ? '任务完成' : '任务结束',
        message.is_error ? 'error' : 'done',
        joinDetails([formatDuration(message.duration_ms), formatCost(message.total_cost_usd), `${message.num_turns} turns`]),
      )
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
      const tools = Array.isArray(message.tools) ? message.tools : []
      const skills = Array.isArray(message.skills) ? message.skills : []
      const slashCommands = Array.isArray(message.slash_commands) ? message.slash_commands : []
      const agents = Array.isArray(message.agents) ? message.agents : []
      const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : []
      const plugins = Array.isArray(message.plugins) ? message.plugins.map((plugin) => plugin.name) : []
      this.emit({
        type: 'session_start',
        requestId: activeRequest.requestId,
        sessionId: message.session_id,
        model: threadState.model,
        cwd: message.cwd || activeRequest.cwd,
        tools,
        skills,
        slashCommands,
        agents,
        mcpServers,
        permissionMode: message.permissionMode || '',
        plugins,
      })
      this.emitActivity(
        activeRequest,
        'session-init',
        'Agent 初始化',
        'done',
        joinDetails([
          threadState.model,
          message.permissionMode ? `权限 ${message.permissionMode}` : '',
          `${tools.length} tools`,
          `${skills.length} skills`,
          `${agents.length} agents`,
        ]),
        joinPreview([
          formatListPreview('Tools', tools),
          formatListPreview('Skills', skills),
          formatListPreview('Slash', slashCommands),
          formatListPreview('Agents', agents),
          formatListPreview('MCP', mcpServers.map((server) => `${server.name}:${server.status}`)),
          formatListPreview('Plugins', plugins),
        ]),
      )
      return
    }

    if (message.subtype === 'permission_denied') {
      this.emit({
        type: 'tool_done',
        requestId: activeRequest.requestId,
        toolUseId: message.tool_use_id,
        status: 'denied',
        detail: message.decision_reason || message.message,
      })
      this.emitActivity(
        activeRequest,
        `permission-denied-${message.tool_use_id}`,
        `权限拒绝：${message.tool_name}`,
        'error',
        message.decision_reason || message.message,
      )
      return
    }

    const activity = activityFromSystemMessage(message)
    if (activity) {
      this.emitActivity(activeRequest, activity.key, activity.title, activity.status, activity.detail, activity.preview)
    }
  }

  private handleStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>, activeRequest: ActiveRequest): void {
    const event = message.event
    const eventRecord = event as unknown

    if (!isRecord(eventRecord) || typeof eventRecord.type !== 'string') return

    if (eventRecord.type === 'message_start') {
      const model = isRecord(eventRecord.message) && typeof eventRecord.message.model === 'string' ? eventRecord.message.model : ''
      this.emitActivity(activeRequest, 'message-stream', '模型响应开始', 'running', model)
      return
    }

    if (eventRecord.type === 'message_stop') {
      this.emitActivity(activeRequest, 'message-stream', '模型响应完成', 'done')
      return
    }

    if (eventRecord.type === 'message_delta') {
      const stopReason =
        isRecord(eventRecord.delta) && typeof eventRecord.delta.stop_reason === 'string'
          ? `停止原因 ${eventRecord.delta.stop_reason}`
          : undefined
      if (stopReason) this.emitActivity(activeRequest, 'message-stream', '模型响应更新', 'running', stopReason)
      return
    }

    if (eventRecord.type === 'content_block_start') {
      const index = typeof eventRecord.index === 'number' ? eventRecord.index : undefined
      this.handleContentBlockStart(index, eventRecord.content_block, activeRequest)
      return
    }

    if (eventRecord.type === 'content_block_delta') {
      const index = typeof eventRecord.index === 'number' ? eventRecord.index : undefined
      const delta = eventRecord.delta
      if (!isRecord(delta) || typeof delta.type !== 'string') return

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.emitAssistantDelta(activeRequest, delta.text)
        return
      }

      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const thinkingId = this.ensureThinkingBlock(index, activeRequest)
        this.emit({
          type: 'thinking_delta',
          requestId: activeRequest.requestId,
          thinkingId,
          text: delta.thinking,
        })
        return
      }

      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.handleToolInputDelta(index, delta.partial_json, activeRequest)
        return
      }

      if (delta.type === 'signature_delta') {
        const thinkingId = this.ensureThinkingBlock(index, activeRequest)
        this.emitActivity(activeRequest, `thinking-signature-${thinkingId}`, '思考签名已接收', 'done')
        return
      }
    }

    if (eventRecord.type === 'content_block_stop') {
      const index = typeof eventRecord.index === 'number' ? eventRecord.index : undefined
      this.handleContentBlockStop(index, activeRequest)
      return
    }
  }

  private handleAssistantMessage(message: Extract<SDKMessage, { type: 'assistant' }>, activeRequest: ActiveRequest): void {
    const content = message.message.content
    if (Array.isArray(content)) {
      for (const [index, block] of content.entries()) {
        this.emitToolStartFromBlock(block, activeRequest)
        this.emitThinkingFromCompleteBlock(index, block, activeRequest)
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
        detail: block.is_error === true ? '工具返回错误' : '工具执行完成',
      })
    }
  }

  private handleContentBlockStart(index: number | undefined, block: unknown, activeRequest: ActiveRequest): void {
    if (index === undefined || !isRecord(block) || typeof block.type !== 'string') {
      this.emitToolStartFromBlock(block, activeRequest)
      return
    }

    if (block.type === 'thinking') {
      const thinkingId = `thinking-${activeRequest.requestId}-${index}`
      activeRequest.streamBlocks.set(index, { id: thinkingId, type: 'thinking', inputJson: '' })
      activeRequest.didEmitThinking = true
      this.emit({
        type: 'thinking_start',
        requestId: activeRequest.requestId,
        thinkingId,
        title: 'Think',
      })
      return
    }

    if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
      const toolUseId = this.emitToolStartFromBlock(block, activeRequest)
      activeRequest.streamBlocks.set(index, {
        id: toolUseId || `tool-block-${activeRequest.requestId}-${index}`,
        type: 'tool',
        toolUseId,
        inputJson: '',
      })
      return
    }

    activeRequest.streamBlocks.set(index, {
      id: `${block.type}-${activeRequest.requestId}-${index}`,
      type: block.type === 'text' ? 'text' : 'other',
      inputJson: '',
    })
  }

  private handleContentBlockStop(index: number | undefined, activeRequest: ActiveRequest): void {
    if (index === undefined) return
    const block = activeRequest.streamBlocks.get(index)
    if (!block) return

    if (block.type === 'thinking') {
      this.emit({
        type: 'thinking_done',
        requestId: activeRequest.requestId,
        thinkingId: block.id,
      })
      return
    }

    if (block.type === 'tool' && block.toolUseId) {
      this.emit({
        type: 'tool_update',
        requestId: activeRequest.requestId,
        toolUseId: block.toolUseId,
        detail: '输入就绪，等待执行',
      })
    }
  }

  private handleToolInputDelta(index: number | undefined, partialJson: string, activeRequest: ActiveRequest): void {
    if (index === undefined) return
    const block = activeRequest.streamBlocks.get(index)
    if (!block || block.type !== 'tool' || !block.toolUseId) return

    block.inputJson += partialJson
    this.emit({
      type: 'tool_update',
      requestId: activeRequest.requestId,
      toolUseId: block.toolUseId,
      inputPreview: previewJsonText(block.inputJson),
      detail: '正在生成输入',
    })
  }

  private ensureThinkingBlock(index: number | undefined, activeRequest: ActiveRequest): string {
    if (index !== undefined) {
      const existing = activeRequest.streamBlocks.get(index)
      if (existing?.type === 'thinking') return existing.id
      const thinkingId = `thinking-${activeRequest.requestId}-${index}`
      activeRequest.streamBlocks.set(index, { id: thinkingId, type: 'thinking', inputJson: '' })
      activeRequest.didEmitThinking = true
      this.emit({
        type: 'thinking_start',
        requestId: activeRequest.requestId,
        thinkingId,
        title: 'Think',
      })
      return thinkingId
    }

    const thinkingId = `thinking-${activeRequest.requestId}-unknown`
    activeRequest.didEmitThinking = true
    this.emit({
      type: 'thinking_start',
      requestId: activeRequest.requestId,
      thinkingId,
      title: 'Think',
    })
    return thinkingId
  }

  private emitThinkingFromCompleteBlock(index: number, block: unknown, activeRequest: ActiveRequest): void {
    if (activeRequest.didEmitThinking || !isRecord(block) || typeof block.type !== 'string') return

    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      const thinkingId = `thinking-${activeRequest.requestId}-complete-${index}`
      activeRequest.didEmitThinking = true
      this.emit({
        type: 'thinking_start',
        requestId: activeRequest.requestId,
        thinkingId,
        title: 'Think',
      })
      this.emit({
        type: 'thinking_delta',
        requestId: activeRequest.requestId,
        thinkingId,
        text: block.thinking,
      })
      this.emit({
        type: 'thinking_done',
        requestId: activeRequest.requestId,
        thinkingId,
      })
      return
    }

    if (block.type === 'redacted_thinking') {
      this.emitActivity(activeRequest, `redacted-thinking-${index}`, '思考内容已省略', 'info')
    }
  }

  private emitToolStartFromBlock(block: unknown, activeRequest: ActiveRequest): string | undefined {
    if (!isRecord(block)) return undefined
    if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') return undefined

    const toolUseId = typeof block.id === 'string' ? block.id : undefined
    const name = getToolName(block)
    if (!toolUseId || !name) return undefined
    if (activeRequest.seenToolUseIds.has(toolUseId)) return toolUseId

    activeRequest.seenToolUseIds.add(toolUseId)
    this.emit({
      type: 'tool_start',
      requestId: activeRequest.requestId,
      toolUseId,
      name,
      inputPreview: previewValue(block.input),
    })
    return toolUseId
  }

  private handleStandaloneSdkMessage(message: SDKMessage, activeRequest: ActiveRequest): boolean {
    const record = message as unknown
    if (!isRecord(record) || typeof record.type !== 'string') return false

    if (record.type === 'tool_progress') {
      const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : ''
      const toolName = typeof record.tool_name === 'string' ? record.tool_name : 'Tool'
      const elapsed =
        typeof record.elapsed_time_seconds === 'number'
          ? `${Math.max(0, Math.round(record.elapsed_time_seconds))}s`
          : ''
      if (toolUseId) {
        this.emit({
          type: 'tool_update',
          requestId: activeRequest.requestId,
          toolUseId,
          detail: elapsed ? `运行中 ${elapsed}` : '运行中',
        })
      }
      this.emitActivity(activeRequest, `tool-progress-${toolUseId || toolName}`, `工具运行中：${toolName}`, 'running', elapsed)
      return true
    }

    if (record.type === 'tool_use_summary') {
      this.emitActivity(
        activeRequest,
        `tool-summary-${previewHash(record.summary)}`,
        '工具摘要',
        'done',
        typeof record.summary === 'string' ? record.summary : undefined,
      )
      return true
    }

    if (record.type === 'auth_status') {
      const isAuthenticating = record.isAuthenticating === true
      const output = Array.isArray(record.output) ? record.output.filter((item): item is string => typeof item === 'string') : []
      this.emitActivity(
        activeRequest,
        'auth-status',
        isAuthenticating ? '认证中' : '认证状态',
        record.error ? 'error' : isAuthenticating ? 'running' : 'done',
        typeof record.error === 'string' ? record.error : output[output.length - 1],
        output.join('\n'),
      )
      return true
    }

    if (record.type === 'rate_limit_event') {
      const info = isRecord(record.rate_limit_info) ? record.rate_limit_info : {}
      const status = typeof info.status === 'string' ? info.status : 'unknown'
      const utilization = typeof info.utilization === 'number' ? `${Math.round(info.utilization * 100)}%` : ''
      this.emitActivity(activeRequest, 'rate-limit', `限额状态：${status}`, status === 'rejected' ? 'error' : 'info', utilization)
      return true
    }

    if (record.type === 'prompt_suggestion') {
      this.emitActivity(
        activeRequest,
        'prompt-suggestion',
        '下一步建议',
        'info',
        typeof record.suggestion === 'string' ? record.suggestion : undefined,
      )
      return true
    }

    return false
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
    config.supportsImages,
    config.defaultHaikuModel,
    config.defaultOpusModel,
    config.defaultSonnetModel,
  ])
}

function summarizeConfigForLog(config: ClaudeAgentResolvedConfig): Record<string, unknown> {
  return {
    configSource: config.configSource,
    hasApiKey: Boolean(config.apiKey),
    apiKey: redactSecret(config.apiKey),
    hasAuthToken: Boolean(config.authToken),
    authToken: redactSecret(config.authToken),
    baseUrl: config.baseUrl,
    model: config.model,
    supportsImages: config.supportsImages,
    defaultHaikuModel: config.defaultHaikuModel,
    defaultSonnetModel: config.defaultSonnetModel,
    defaultOpusModel: config.defaultOpusModel,
  }
}

function summarizeSdkEnvForLog(env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY),
    ANTHROPIC_API_KEY: redactSecret(env.ANTHROPIC_API_KEY ?? ''),
    hasAnthropicAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
    ANTHROPIC_AUTH_TOKEN: redactSecret(env.ANTHROPIC_AUTH_TOKEN ?? ''),
  }
}

function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const maybeCause = (error as Error & { cause?: unknown }).cause
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: maybeCause instanceof Error ? { name: maybeCause.name, message: maybeCause.message } : maybeCause,
    }
  }
  return { value: String(error) }
}

function redactSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return `***(${trimmed.length})`
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}(${trimmed.length})`
}

function normalizeSubmitAttachments(value: unknown): ClaudeChatAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: ClaudeChatAttachment[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    const base = {
      id: item.id,
      name: item.name,
      path: typeof item.path === 'string' ? item.path : '',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
      preview: typeof item.preview === 'string' ? item.preview : undefined,
      dataUrl: typeof item.dataUrl === 'string' ? item.dataUrl : undefined,
    }

    if (item.kind === 'text' && typeof item.text === 'string') {
      attachments.push({
        ...base,
        kind: 'text',
        text: item.text,
      })
      continue
    }

    if (
      item.kind === 'image' &&
      typeof item.base64 === 'string' &&
      SUPPORTED_IMAGE_MIME_TYPES.has(base.mimeType)
    ) {
      attachments.push({
        ...base,
        kind: 'image',
        mimeType: base.mimeType as SupportedImageMimeType,
        base64: item.base64,
      })
    }
  }
  return attachments
}

function buildSdkPromptInput(prompt: string, attachments: ClaudeChatAttachment[]): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0) return prompt
  const content = buildSdkUserContent(prompt, attachments)
  return singleUserMessage(content)
}

function buildSdkUserContent(prompt: string, attachments: ClaudeChatAttachment[]): SDKUserMessageContent {
  const content: SDKUserMessageContent = []
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt) {
    content.push({ type: 'text', text: trimmedPrompt })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'text' && attachment.text != null) {
      content.push({
        type: 'text',
        text: formatTextAttachmentForPrompt(attachment),
      })
      continue
    }

    if (attachment.kind === 'image' && attachment.base64 && isSupportedImageMimeType(attachment.mimeType)) {
      content.push({
        type: 'text',
        text: `Attached image: ${attachment.name}${attachment.path ? `\nPath: ${attachment.path}` : ''}`,
      })
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mimeType,
          data: attachment.base64,
        },
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '请阅读这些附件。' })
  }
  return content
}

async function* singleUserMessage(content: SDKUserMessageContent): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  }
}

function formatTextAttachmentForPrompt(attachment: ClaudeChatAttachment): string {
  const header = [
    'Attached text file:',
    `Name: ${attachment.name}`,
    attachment.path ? `Path: ${attachment.path}` : '',
    attachment.mimeType ? `MIME: ${attachment.mimeType}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\n${attachment.text ?? ''}`
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.has(value)
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

type ActivityDescriptor = {
  key: string
  title: string
  status: 'running' | 'done' | 'error' | 'info'
  detail?: string
  preview?: string
}

function activityFromSystemMessage(message: Extract<SDKMessage, { type: 'system' }>): ActivityDescriptor | undefined {
  const record = message as unknown
  if (!isRecord(record) || typeof record.subtype !== 'string') return undefined

  if (record.subtype === 'status') {
    const status = typeof record.status === 'string' ? record.status : null
    if (status === 'requesting') {
      return { key: 'sdk-status', title: '请求模型', status: 'running', detail: formatPermissionMode(record.permissionMode) }
    }
    if (status === 'compacting') {
      return { key: 'sdk-status', title: '压缩上下文', status: 'running', detail: formatCompactResult(record) }
    }
    return { key: 'sdk-status', title: 'Agent 空闲', status: 'done', detail: formatCompactResult(record) }
  }

  if (record.subtype === 'session_state_changed') {
    const state = typeof record.state === 'string' ? record.state : 'unknown'
    return {
      key: 'session-state',
      title: state === 'running' ? 'Agent 运行中' : state === 'requires_action' ? '等待操作' : 'Agent 空闲',
      status: state === 'running' ? 'running' : state === 'requires_action' ? 'info' : 'done',
      detail: state,
    }
  }

  if (record.subtype === 'compact_boundary') {
    const metadata = isRecord(record.compact_metadata) ? record.compact_metadata : {}
    const pre = typeof metadata.pre_tokens === 'number' ? `${metadata.pre_tokens} tokens` : ''
    const post = typeof metadata.post_tokens === 'number' ? `-> ${metadata.post_tokens}` : ''
    const trigger = typeof metadata.trigger === 'string' ? metadata.trigger : 'unknown'
    return { key: `compact-${previewHash(`${pre}-${post}-${trigger}`)}`, title: '上下文压缩边界', status: 'done', detail: joinDetails([trigger, pre, post]) }
  }

  if (record.subtype === 'api_retry') {
    const attempt = typeof record.attempt === 'number' ? record.attempt : 0
    const max = typeof record.max_retries === 'number' ? record.max_retries : 0
    const delay = typeof record.retry_delay_ms === 'number' ? `${Math.round(record.retry_delay_ms / 1000)}s 后重试` : ''
    const error = typeof record.error === 'string' ? record.error : ''
    return {
      key: `api-retry-${attempt}`,
      title: 'API 请求重试',
      status: 'running',
      detail: joinDetails([attempt && max ? `${attempt}/${max}` : '', delay, error]),
    }
  }

  if (record.subtype === 'notification') {
    const text = typeof record.text === 'string' ? record.text : ''
    const priority = typeof record.priority === 'string' ? record.priority : ''
    return { key: `notification-${previewHash(text)}`, title: '通知', status: priority === 'high' || priority === 'immediate' ? 'info' : 'done', detail: text }
  }

  if (record.subtype === 'local_command_output') {
    const content = typeof record.content === 'string' ? record.content : ''
    return { key: `local-command-${previewHash(content)}`, title: '本地命令输出', status: 'done', detail: firstLine(content), preview: content }
  }

  if (record.subtype === 'memory_recall') {
    const memories = Array.isArray(record.memories) ? record.memories : []
    return {
      key: `memory-recall-${memories.length}`,
      title: '读取记忆',
      status: 'done',
      detail: `${memories.length} 条`,
      preview: memories.map((memory) => (isRecord(memory) && typeof memory.path === 'string' ? memory.path : '')).filter(Boolean).join('\n'),
    }
  }

  if (record.subtype === 'files_persisted') {
    const files = Array.isArray(record.files) ? record.files : []
    const failed = Array.isArray(record.failed) ? record.failed : []
    return {
      key: `files-persisted-${files.length}-${failed.length}`,
      title: '文件已持久化',
      status: failed.length > 0 ? 'error' : 'done',
      detail: joinDetails([`${files.length} 成功`, failed.length ? `${failed.length} 失败` : '']),
    }
  }

  if (record.subtype === 'hook_started' || record.subtype === 'hook_progress' || record.subtype === 'hook_response') {
    const hookName = typeof record.hook_name === 'string' ? record.hook_name : 'hook'
    const hookEvent = typeof record.hook_event === 'string' ? record.hook_event : ''
    const outcome = typeof record.outcome === 'string' ? record.outcome : ''
    const output = typeof record.output === 'string' ? record.output : ''
    return {
      key: `hook-${typeof record.hook_id === 'string' ? record.hook_id : hookName}`,
      title: `Hook：${hookName}`,
      status: record.subtype === 'hook_response' ? (outcome === 'error' ? 'error' : 'done') : 'running',
      detail: joinDetails([hookEvent, outcome]),
      preview: output,
    }
  }

  if (record.subtype === 'plugin_install') {
    const status = typeof record.status === 'string' ? record.status : 'unknown'
    const name = typeof record.name === 'string' ? record.name : 'plugin'
    const error = typeof record.error === 'string' ? record.error : ''
    return {
      key: `plugin-${name}`,
      title: `插件安装：${name}`,
      status: status === 'failed' ? 'error' : status === 'completed' || status === 'installed' ? 'done' : 'running',
      detail: error || status,
    }
  }

  if (record.subtype === 'task_started' || record.subtype === 'task_progress' || record.subtype === 'task_updated' || record.subtype === 'task_notification') {
    return activityFromTaskMessage(record)
  }

  if (record.subtype === 'elicitation_complete') {
    const server = typeof record.mcp_server_name === 'string' ? record.mcp_server_name : 'MCP'
    return { key: `elicitation-${server}`, title: 'MCP 交互完成', status: 'done', detail: server }
  }

  if (record.subtype === 'mirror_error') {
    return {
      key: 'mirror-error',
      title: '会话镜像失败',
      status: 'error',
      detail: typeof record.error === 'string' ? record.error : undefined,
    }
  }

  return {
    key: `system-${record.subtype}-${previewHash(previewValue(record))}`,
    title: `系统事件：${record.subtype}`,
    status: 'info',
    preview: previewValue(record),
  }
}

function activityFromTaskMessage(record: Record<string, unknown>): ActivityDescriptor {
  const taskId = typeof record.task_id === 'string' ? record.task_id : 'task'
  const description = typeof record.description === 'string' ? record.description : ''
  const summary = typeof record.summary === 'string' ? record.summary : ''
  const subagent = typeof record.subagent_type === 'string' ? record.subagent_type : ''

  if (record.subtype === 'task_started') {
    return {
      key: `task-${taskId}`,
      title: subagent ? `子任务启动：${subagent}` : '任务启动',
      status: 'running',
      detail: description,
      preview: typeof record.prompt === 'string' ? record.prompt : undefined,
    }
  }

  if (record.subtype === 'task_progress') {
    const usage = isRecord(record.usage) ? record.usage : {}
    const tokens = typeof usage.total_tokens === 'number' ? `${usage.total_tokens} tokens` : ''
    const toolUses = typeof usage.tool_uses === 'number' ? `${usage.tool_uses} tools` : ''
    const lastTool = typeof record.last_tool_name === 'string' ? `last ${record.last_tool_name}` : ''
    return {
      key: `task-${taskId}`,
      title: subagent ? `子任务运行：${subagent}` : '任务运行中',
      status: 'running',
      detail: joinDetails([description, tokens, toolUses, lastTool]),
      preview: summary,
    }
  }

  if (record.subtype === 'task_updated') {
    const patch = isRecord(record.patch) ? record.patch : {}
    const status = typeof patch.status === 'string' ? patch.status : ''
    return {
      key: `task-${taskId}`,
      title: '任务状态更新',
      status: status === 'failed' || status === 'killed' ? 'error' : status === 'completed' ? 'done' : 'running',
      detail: joinDetails([status, typeof patch.error === 'string' ? patch.error : '']),
    }
  }

  const status = typeof record.status === 'string' ? record.status : ''
  return {
    key: `task-${taskId}`,
    title: '任务通知',
    status: status === 'failed' ? 'error' : status === 'completed' ? 'done' : 'info',
    detail: joinDetails([status, summary]),
  }
}

function formatPermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' ? `权限 ${value}` : undefined
}

function formatCompactResult(record: Record<string, unknown>): string | undefined {
  const result = typeof record.compact_result === 'string' ? record.compact_result : ''
  const error = typeof record.compact_error === 'string' ? record.compact_error : ''
  return joinDetails([result, error])
}

function formatListPreview(label: string, items: string[]): string {
  return `${label}: ${items.length ? items.join(', ') : 'none'}`
}

function joinDetails(parts: Array<string | undefined | null | false>): string | undefined {
  const text = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ')
  return text || undefined
}

function joinPreview(parts: string[]): string | undefined {
  const text = parts.filter((part) => part.trim().length > 0).join('\n')
  return text || undefined
}

function firstLine(value: string): string {
  return value.trim().split(/\n/)[0]?.trim() || ''
}

function formatDuration(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`
}

function formatCost(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function previewJsonText(value: string): string {
  try {
    return previewValue(JSON.parse(value))
  } catch {
    return truncate(value, 180)
  }
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

function previewHash(value: unknown): string {
  const text = typeof value === 'string' ? value : previewValue(value)
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
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

function resolveWorkspaceCwd(requested: string | undefined, fallback: string): string {
  const raw = requested?.trim() || fallback.trim()
  if (!raw) return path.resolve(fallback)
  if (raw.startsWith('~/')) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)))
  }
  return path.resolve(raw)
}
