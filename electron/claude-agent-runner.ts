/**
 * 主进程内封装 Claude Agent SDK `query`：会话恢复、权限闸门与事件转发。
 * Main-process facade for Claude Agent SDK `query`: resume, permission gating, and IPC streaming.
 */

import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeAskUserQuestion,
  ClaudeAgentResolvedConfig,
  ClaudeChatAttachment,
  ClaudeChatEvent,
  ClaudeChatSubmitPayload,
  ClaudeChatSubmitResult,
  ClaudeFileRewindPayload,
  ClaudeFileRewindResult,
  ClaudePermissionMode,
  ClaudePermissionResponsePayload,
} from '../src/claude-chat-types'
import type { AgentModeProjectSettings, AppUiLocale } from '../src/desktop-types'
import { buildRuntimeContext, resolvePromptWithContext } from './agent-context'
import {
  buildSdkEnv,
  getConfigSignature,
  summarizeConfigForLog,
  summarizeErrorForLog,
  summarizeSdkEnvForLog,
} from './claude-agent-runner/config'
import { ClaudeChatEventCoalescer } from './claude-agent-runner/event-coalescer'
import { fileDiffFromPostToolUse } from './claude-agent-runner/file-diff'
import { buildSdkPromptInput, normalizeSubmitAttachments, resolveWorkspaceCwd } from './claude-agent-runner/input'
import { ClaudeSdkMessageRouter } from './claude-agent-runner/sdk-message-router'
import {
  HOME_PLUGIN_CARD_CUSTOMIZATION_SYSTEM_PROMPT,
  HOME_PLUGIN_CUSTOMIZATION_SYSTEM_PROMPT,
  HOME_PLUGIN_TASK_RUN_SYSTEM_PROMPT,
} from './home-plugin-customization-prompt'
import { safeConsoleError, safeConsoleInfo, safeConsoleWarn } from './safe-console'

/** 渲染进程订阅聊天事件的 IPC 信道 / IPC channel for streamed chat events to renderer */
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
  checkpointId?: string
  promptMode?: ClaudeChatSubmitPayload['promptMode']
  agentModeSettingsOverride?: ClaudeChatSubmitPayload['agentModeSettingsOverride']
  permissionMode: ClaudePermissionMode
  seenToolUseIds: Set<string>
  toolNamesByUseId: Map<string, string>
  diffedToolUseIds: Set<string>
  streamBlocks: Map<number, StreamBlockState>
}

const READ_ONLY_AUTO_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'ListMcpResources', 'ReadMcpResource']
const DEFAULT_AGENT_TOOLS = { type: 'preset', preset: 'claude_code' } as const
const HOME_PLUGIN_CUSTOMIZATION_SKILL = 'a2ui-project-home-panel'
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
  cwd?: string
}

type StreamBlockState = {
  id: string
  type: 'text' | 'thinking' | 'tool' | 'other'
  toolUseId?: string
  inputJson: string
}

/** 驱动单次或并行 Claude Agent 请求并同步到 WebContents / Runs Claude Agent turns and mirrors state to WebContents */
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
    private readonly resolveUiLocale: () => AppUiLocale,
    private readonly observeEvent?: (event: ClaudeChatEvent) => void,
  ) {
    this.eventCoalescer = new ClaudeChatEventCoalescer((event) => this.sendEventNow(event))
    this.messageRouter = new ClaudeSdkMessageRouter(
      (event) => this.emit(event),
      (threadId) => this.getThreadRuntimeState(threadId),
    )
  }

  // --- Public API / 对外 API ---

  /** 排队新的用户轮次并在后台启动 SDK / Enqueue a user turn and start SDK query asynchronously */
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

    const threadState = this.getThreadRuntimeState(threadId)
    const persistedSession = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (persistedSession && !threadState.sessionId) {
      threadState.sessionId = persistedSession
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
      promptMode:
        payload.promptMode === 'home-plugin-customization' ||
        payload.promptMode === 'home-plugin-card-customization' ||
        payload.promptMode === 'home-plugin-task-run'
          ? payload.promptMode
          : undefined,
      agentModeSettingsOverride: normalizeAgentModeSettingsOverride(payload.agentModeSettingsOverride),
      permissionMode: normalizeChatPermissionMode(payload.permissionMode),
      seenToolUseIds: new Set(),
      toolNamesByUseId: new Map(),
      diffedToolUseIds: new Set(),
      streamBlocks: new Map(),
    }

    this.activeRequests.set(requestId, activeRequest)
    this.activeRequestIdsByThread.set(threadId, requestId)
    void this.run(text, attachments, activeRequest)

    return { requestId }
  }

  /** 取消单个请求或全部进行中的请求 / Cancel one request id or every active request */
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

  /** 重置线程会话状态（新对话）/ Reset persisted session state for a thread */
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

  /** 响应 UI 对权限或 AskUserQuestion 的决定 / Apply renderer decision for tool permission prompts */
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

  /** 回滚到本轮开始前的 SDK 文件 checkpoint / Rewind SDK-tracked file changes to a checkpoint */
  async rewindFiles(payload: ClaudeFileRewindPayload): Promise<ClaudeFileRewindResult> {
    const checkpointId = payload.checkpointId.trim()
    const requestId = payload.requestId?.trim() || `rewind-${randomUUID()}`
    const threadId = this.normalizeThreadId(payload.threadId)
    if (!checkpointId) {
      const result: ClaudeFileRewindResult = {
        ok: false,
        changeSetId: payload.changeSetId,
        message: '缺少可回滚的文件快照。',
      }
      this.emitFileRewindResult(requestId, threadId, result)
      return result
    }

    const activeRequest = payload.requestId ? this.activeRequests.get(payload.requestId) : undefined
    if (activeRequest?.query) {
      try {
        const result = toClaudeFileRewindResult(await activeRequest.query.rewindFiles(checkpointId), payload.changeSetId)
        this.emitFileRewindResult(activeRequest.requestId, activeRequest.threadId, result)
        return result
      } catch (error) {
        const result = toFailedRewindResult(error, payload.changeSetId)
        this.emitFileRewindResult(activeRequest.requestId, activeRequest.threadId, result)
        return result
      }
    }

    const config = this.resolveConfig()
    if (!config.apiKey && !config.authToken) {
      const result: ClaudeFileRewindResult = {
        ok: false,
        changeSetId: payload.changeSetId,
        message: '缺少 Claude 凭据，无法恢复 SDK 会话执行回滚。',
      }
      this.emitFileRewindResult(requestId, threadId, result)
      return result
    }

    const threadState = this.getThreadRuntimeState(threadId)
    if (!threadState.sessionId) {
      const result: ClaudeFileRewindResult = {
        ok: false,
        changeSetId: payload.changeSetId,
        message: '没有可恢复的 Claude 会话，无法回滚文件。',
      }
      this.emitFileRewindResult(requestId, threadId, result)
      return result
    }

    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 30_000)
    const cwd = resolveWorkspaceCwd(payload.cwd ?? threadState.cwd, this.cwd)
    let response: Query | undefined

    try {
      response = query({
        prompt: '',
        options: {
          abortController,
          cwd,
          enableFileCheckpointing: true,
          env: buildSdkEnv(config),
          extraArgs: { 'replay-user-messages': null },
          permissionMode: 'default',
          resume: threadState.sessionId,
          settingSources: [],
          tools: DEFAULT_AGENT_TOOLS,
        },
      })

      for await (const _message of response) {
        const result = toClaudeFileRewindResult(await response.rewindFiles(checkpointId), payload.changeSetId)
        this.emitFileRewindResult(requestId, threadId, result)
        return result
      }

      const result: ClaudeFileRewindResult = {
        ok: false,
        changeSetId: payload.changeSetId,
        message: 'Claude 会话未返回可用于回滚的连接。',
      }
      this.emitFileRewindResult(requestId, threadId, result)
      return result
    } catch (error) {
      const result = toFailedRewindResult(error, payload.changeSetId)
      this.emitFileRewindResult(requestId, threadId, result)
      return result
    } finally {
      clearTimeout(timeout)
      response?.close()
    }
  }

  // --- SDK query lifecycle / SDK 查询生命周期 ---

  private async run(prompt: string, attachments: ClaudeChatAttachment[], activeRequest: ActiveRequest): Promise<void> {
    const config = this.resolveConfig()
    const threadState = this.getThreadRuntimeState(activeRequest.threadId)
    const nextConfigSignature = getConfigSignature(config)
    if (threadState.configSignature && threadState.configSignature !== nextConfigSignature) {
      threadState.sessionId = undefined
    }
    threadState.configSignature = nextConfigSignature
    threadState.cwd = activeRequest.cwd

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
      const agentModeSettings = {
        ...(await this.resolveAgentModeSettings(activeRequest.cwd)),
        ...(activeRequest.agentModeSettingsOverride ?? {}),
      }
      const runtimeContext = await buildRuntimeContext(activeRequest.cwd, agentModeSettings, this.resolveUiLocale())
      const appendSystemPrompt = buildRequestAppendSystemPrompt(activeRequest, runtimeContext.appendSystemPrompt)
      const resolvedPrompt = await resolvePromptWithContext(prompt, runtimeContext.catalog, {
        forcedSkillCommand:
          activeRequest.promptMode === 'home-plugin-customization' || activeRequest.promptMode === 'home-plugin-card-customization'
            ? HOME_PLUGIN_CUSTOMIZATION_SKILL
            : undefined,
      })
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

      let resumeSessionId = threadState.sessionId?.trim() || undefined
      let retriedWithoutResume = false

      while (true) {
        let response: Query | undefined
        try {
          safeConsoleInfo('[ClaudeAgentRunner] starting SDK query', {
            requestId: activeRequest.requestId,
            threadId: activeRequest.threadId,
            cwd: activeRequest.cwd,
            permissionMode: activeRequest.permissionMode,
            attachmentCount: attachments.length,
            imageAttachmentCount,
            resumeSessionIdPresent: Boolean(resumeSessionId),
            config: summarizeConfigForLog(config),
            sdkEnv: summarizeSdkEnvForLog(sdkEnv),
          })
          response = query({
            prompt: promptInput,
            options: {
              abortController: activeRequest.abortController,
              agents: runtimeContext.agents,
              allowDangerouslySkipPermissions: activeRequest.permissionMode === 'bypassPermissions' ? true : undefined,
              allowedTools: READ_ONLY_AUTO_ALLOWED_TOOLS,
              canUseTool: (toolName, input, options) => this.handleCanUseTool(activeRequest, toolName, input, options),
              cwd: activeRequest.cwd,
              enableFileCheckpointing: true,
              env: sdkEnv,
              extraArgs: { 'replay-user-messages': null },
              forwardSubagentText: true,
              hooks: {
                PostToolUse: [
                  {
                    hooks: [async (input) => this.handlePostToolUseHook(activeRequest, input)],
                  },
                ],
              },
              includeHookEvents: false,
              includePartialMessages: true,
              // Third-party Anthropic-compatible endpoints such as SiliconFlow expect
              // custom models through ANTHROPIC_MODEL. Passing options.model makes
              // Claude Code treat the value as its own model flag and can trigger
              // false "model does not exist" errors.
              permissionMode: toSdkPermissionMode(activeRequest.permissionMode),
              resume: resumeSessionId,
              // Keep this app's provider settings authoritative. Claude Code user or
              // project settings may contain another model (for example glm-5.1) and
              // otherwise override the model shown in this UI.
              settingSources: [],
              skills: 'all',
              systemPrompt: appendSystemPrompt
                ? { type: 'preset', preset: 'claude_code', append: appendSystemPrompt }
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
            this.captureCheckpointFromSdkMessage(message, activeRequest)
            this.messageRouter.handleSdkMessage(message, activeRequest)
          }
          return
        } catch (error) {
          if (
            !activeRequest.cancelled &&
            isMissingConversationSessionError(error) &&
            resumeSessionId &&
            !retriedWithoutResume &&
            !activeRequest.didEmitText &&
            !activeRequest.didEmitThinking
          ) {
            safeConsoleWarn('[ClaudeAgentRunner] session missing, retrying without resume', {
              requestId: activeRequest.requestId,
              threadId: activeRequest.threadId,
              sessionIdPresent: Boolean(resumeSessionId),
              error: summarizeErrorForLog(error),
            })
            threadState.sessionId = undefined
            resumeSessionId = undefined
            retriedWithoutResume = true
            continue
          }

          if (!activeRequest.cancelled) {
            safeConsoleError('[ClaudeAgentRunner] SDK query failed', {
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
          return
        } finally {
          activeRequest.query = undefined
          try {
            response?.close()
          } catch {
            // best-effort close
          }
        }
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

  private captureCheckpointFromSdkMessage(message: SDKMessage, activeRequest: ActiveRequest): void {
    const record = message as unknown
    if (!isRecord(record) || record.type !== 'user') return
    if (activeRequest.checkpointId || typeof record.uuid !== 'string') return
    if (record.parent_tool_use_id !== null && record.parent_tool_use_id !== undefined) return

    activeRequest.checkpointId = record.uuid
    this.emitActivity(activeRequest, 'file-checkpoint', '文件快照已创建', 'done', '可用于撤销本轮文件改动')
  }

  private async handlePostToolUseHook(activeRequest: ActiveRequest, input: unknown): Promise<{ continue: true; suppressOutput: true }> {
    try {
      const toolUseId = isRecord(input) && typeof input.tool_use_id === 'string' ? input.tool_use_id : ''
      if (toolUseId && activeRequest.diffedToolUseIds.has(toolUseId)) return { continue: true, suppressOutput: true }
      const file = fileDiffFromPostToolUse(input, activeRequest.cwd)
      if (file) {
        if (toolUseId) activeRequest.diffedToolUseIds.add(toolUseId)
        this.emit({
          type: 'file_diff',
          requestId: activeRequest.requestId,
          changeSetId: `file-diff-${activeRequest.requestId}`,
          checkpointId: activeRequest.checkpointId,
          files: [file],
        })
      }
    } catch (error) {
      safeConsoleWarn('[ClaudeAgentRunner] failed to collect file diff', {
        requestId: activeRequest.requestId,
        error: summarizeErrorForLog(error),
      })
    }
    return { continue: true, suppressOutput: true }
  }

  // --- Tool permission gating / 工具权限闸门 ---

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

  // --- IPC emission / IPC 发送 ---

  private emit(event: ClaudeChatEvent): void {
    if (this.webContents.isDestroyed()) return
    const threadId = event.threadId ?? this.activeRequests.get(event.requestId)?.threadId
    this.eventCoalescer.emit(threadId ? { ...event, threadId } : event)
  }

  private sendEventNow(event: ClaudeChatEvent): void {
    if (this.webContents.isDestroyed()) return
    this.observeEvent?.(event)
    this.webContents.send(CLAUDE_CHAT_EVENT_CHANNEL, event)
  }

  private emitFileRewindResult(requestId: string, threadId: string, result: ClaudeFileRewindResult): void {
    this.emit({
      type: 'file_rewind_result',
      requestId,
      threadId,
      changeSetId: result.changeSetId,
      status: result.ok ? 'reverted' : 'error',
      detail: result.message,
    })
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

// --- Module helpers / 模块内工具 ---

function joinDetails(parts: Array<string | undefined | null | false>): string | undefined {
  const text = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' · ')
  return text || undefined
}

function isMissingConversationSessionError(error: unknown): boolean {
  if (typeof error === 'string') {
    return error.includes('No conversation found with session ID')
  }
  if (error instanceof Error) {
    if (error.message.includes('No conversation found with session ID')) return true
    return isMissingConversationSessionError((error as Error & { cause?: unknown }).cause)
  }
  if (!isRecord(error)) return false
  if (typeof error.message === 'string' && error.message.includes('No conversation found with session ID')) return true
  return isMissingConversationSessionError(error.cause)
}

function buildRequestAppendSystemPrompt(activeRequest: ActiveRequest, basePrompt?: string): string | undefined {
  const sections = [basePrompt?.trim()].filter((section): section is string => Boolean(section))
  if (activeRequest.promptMode === 'home-plugin-customization') {
    sections.push(HOME_PLUGIN_CUSTOMIZATION_SYSTEM_PROMPT)
  }
  if (activeRequest.promptMode === 'home-plugin-card-customization') {
    sections.push(HOME_PLUGIN_CARD_CUSTOMIZATION_SYSTEM_PROMPT)
  }
  if (activeRequest.promptMode === 'home-plugin-task-run') {
    sections.push(HOME_PLUGIN_TASK_RUN_SYSTEM_PROMPT)
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined
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
  if (value === 'plan' || value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions') return value
  return 'auto'
}

function normalizeAgentModeSettingsOverride(
  value: ClaudeChatSubmitPayload['agentModeSettingsOverride'],
): ClaudeChatSubmitPayload['agentModeSettingsOverride'] | undefined {
  if (!isRecord(value)) return undefined
  const output: ClaudeChatSubmitPayload['agentModeSettingsOverride'] = {}
  if (typeof value.enabled === 'boolean') output.enabled = value.enabled
  if (typeof value.todoEnabled === 'boolean') output.todoEnabled = value.todoEnabled
  return Object.keys(output).length > 0 ? output : undefined
}

function toSdkPermissionMode(value: ClaudePermissionMode): PermissionMode {
  return value
}

function toClaudeFileRewindResult(result: RewindFilesResult, changeSetId: string | undefined): ClaudeFileRewindResult {
  return {
    ok: result.canRewind,
    changeSetId,
    message: result.error || (result.canRewind ? '文件改动已撤销。' : '无法撤销文件改动。'),
    filesChanged: result.filesChanged,
    insertions: result.insertions,
    deletions: result.deletions,
  }
}

function toFailedRewindResult(error: unknown, changeSetId: string | undefined): ClaudeFileRewindResult {
  return {
    ok: false,
    changeSetId,
    message: error instanceof Error ? error.message : String(error),
  }
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
