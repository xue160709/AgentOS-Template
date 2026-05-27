/**
 * 将 Claude Agent SDK 消息路由为 `ClaudeChatEvent` 流。
 * Map Claude Agent SDK messages into renderer-facing `ClaudeChatEvent`s.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeChatEvent, ClaudeTaskSnapshot, ClaudeTaskStatus } from '../../src/claude-chat-types'
import { fileDiffFromPostToolUse } from './file-diff'

type ThreadRuntimeState = {
  sessionId?: string
  model: string
  configSignature?: string
}

type StreamBlockState = {
  id: string
  type: 'text' | 'thinking' | 'tool' | 'other'
  toolUseId?: string
  toolName?: string
  inputJson: string
}

type ActiveRequest = {
  requestId: string
  assistantMessageId: string
  threadId: string
  cwd: string
  didEmitText: boolean
  didEmitThinking: boolean
  checkpointId?: string
  seenToolUseIds: Set<string>
  seenTaskInputToolUseIds: Set<string>
  toolNamesByUseId: Map<string, string>
  diffedToolUseIds: Set<string>
  streamBlocks: Map<number, StreamBlockState>
}

/** SDK → UI 事件适配层 / Adapter translating SDK stream into UI events */
export class ClaudeSdkMessageRouter {
  constructor(
    private readonly emit: (event: ClaudeChatEvent) => void,
    private readonly getThreadRuntimeState: (threadId: string) => ThreadRuntimeState,
  ) {}

  handleSdkMessage(message: SDKMessage, activeRequest: ActiveRequest): void {
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

      this.emitTaskEventFromToolResult(block, activeRequest)
      this.emit({
        type: 'tool_done',
        requestId: activeRequest.requestId,
        toolUseId: block.tool_use_id,
        status: block.is_error === true ? 'error' : 'done',
        detail: block.is_error === true ? '工具返回错误' : '工具执行完成',
      })
      this.emitFileDiffFromToolResult(message, block.tool_use_id, activeRequest)
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
        toolName: isRecord(block) ? getToolName(block) : undefined,
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
      this.emitTaskEventFromToolInput(
        block.toolUseId,
        block.toolName ?? activeRequest.toolNamesByUseId.get(block.toolUseId) ?? '',
        parseJsonInput(block.inputJson),
        activeRequest,
      )
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
    activeRequest.toolNamesByUseId.set(toolUseId, name)
    this.emit({
      type: 'tool_start',
      requestId: activeRequest.requestId,
      toolUseId,
      name,
      inputPreview: previewValue(block.input),
    })
    this.emitTaskEventFromToolInput(toolUseId, name, block.input, activeRequest)
    return toolUseId
  }

  private emitTaskEventFromToolInput(
    toolUseId: string,
    toolName: string,
    input: unknown,
    activeRequest: ActiveRequest,
  ): void {
    if (!isRecord(input) || activeRequest.seenTaskInputToolUseIds.has(toolUseId)) return

    if (toolName === 'TaskCreate') {
      const subject = readText(input.subject)
      if (!subject) return
      activeRequest.seenTaskInputToolUseIds.add(toolUseId)
      this.emit({
        type: 'task_create',
        requestId: activeRequest.requestId,
        toolUseId,
        subject,
        description: readText(input.description),
        activeForm: readText(input.activeForm),
        metadata: isRecord(input.metadata) ? input.metadata : undefined,
      })
      return
    }

    if (toolName === 'TaskUpdate') {
      const taskId = readTaskId(input)
      if (!taskId) return
      activeRequest.seenTaskInputToolUseIds.add(toolUseId)
      this.emit({
        type: 'task_update',
        requestId: activeRequest.requestId,
        toolUseId,
        taskId,
        status: normalizeTaskStatus(input.status),
        subject: readText(input.subject),
        description: readText(input.description),
        activeForm: readText(input.activeForm),
        owner: readText(input.owner),
        blocks: readStringList(input.addBlocks),
        blockedBy: readStringList(input.addBlockedBy),
        metadata: isRecord(input.metadata) ? input.metadata : undefined,
      })
    }
  }

  private emitTaskEventFromToolResult(block: Record<string, unknown>, activeRequest: ActiveRequest): void {
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    if (!toolUseId) return
    const toolName = activeRequest.toolNamesByUseId.get(toolUseId) || ''
    if (!isTaskToolName(toolName)) return

    const result = normalizeToolResultValue(block)
    if (toolName === 'TaskList') {
      const tasks = readTaskList(result)
      if (tasks.length > 0) {
        this.emit({ type: 'task_list', requestId: activeRequest.requestId, toolUseId, tasks })
      }
      return
    }

    const task = readTaskSnapshot(result)
    if (!task) return
    if (toolName === 'TaskCreate') {
      this.emit({
        type: 'task_create',
        requestId: activeRequest.requestId,
        toolUseId,
        taskId: task.taskId,
        subject: task.subject,
        description: task.description,
        activeForm: task.activeForm,
        metadata: task.metadata,
      })
      return
    }

    this.emit({
      type: 'task_update',
      requestId: activeRequest.requestId,
      toolUseId,
      taskId: task.taskId,
      status: task.status,
      subject: task.subject,
      description: task.description,
      activeForm: task.activeForm,
      owner: task.owner,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
      metadata: task.metadata,
    })
  }

  private emitFileDiffFromToolResult(
    message: Extract<SDKMessage, { type: 'user' }>,
    toolUseId: string,
    activeRequest: ActiveRequest,
  ): void {
    if (activeRequest.diffedToolUseIds.has(toolUseId)) return
    const toolName = activeRequest.toolNamesByUseId.get(toolUseId) || ''
    const toolResult = toolUseResultFromMessage(message)
    const file = fileDiffFromPostToolUse(
      {
        tool_name: toolName,
        tool_response: toolResult,
      },
      activeRequest.cwd,
    )
    if (!file) return

    activeRequest.diffedToolUseIds.add(toolUseId)
    this.emit({
      type: 'file_diff',
      requestId: activeRequest.requestId,
      changeSetId: `file-diff-${activeRequest.requestId}`,
      checkpointId: activeRequest.checkpointId,
      files: [file],
    })
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

function isTaskToolName(value: string): boolean {
  return value === 'TaskCreate' || value === 'TaskUpdate' || value === 'TaskList' || value === 'TaskGet'
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readTaskId(record: Record<string, unknown>): string {
  return readText(record.taskId) ?? readText(record.task_id) ?? readText(record.id) ?? ''
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return items.length > 0 ? items : undefined
}

function normalizeTaskStatus(value: unknown): ClaudeTaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
    ? value
    : undefined
}

function parseJsonInput(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function normalizeToolResultValue(block: Record<string, unknown>): unknown {
  const content = block.content
  if (typeof content === 'string') return parseMaybeJson(content)
  if (Array.isArray(content)) {
    const text = content
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return parseMaybeJson(text)
  }
  if (content !== undefined) return content
  return block
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function readTaskList(value: unknown): ClaudeTaskSnapshot[] {
  const source = unwrapTaskResult(value)
  const tasks = Array.isArray(source)
    ? source
    : isRecord(source) && Array.isArray(source.tasks)
      ? source.tasks
      : isRecord(source) && Array.isArray(source.items)
        ? source.items
        : []
  return tasks.flatMap((task) => {
    const parsed = readTaskSnapshot(task)
    return parsed ? [parsed] : []
  })
}

function readTaskSnapshot(value: unknown): ClaudeTaskSnapshot | undefined {
  const source = unwrapTaskResult(value)
  if (!isRecord(source)) return undefined
  const taskId = readTaskId(source)
  const subject = readText(source.subject) ?? readText(source.title) ?? readText(source.content)
  if (!taskId || !subject) return undefined
  return {
    taskId,
    subject,
    description: readText(source.description),
    activeForm: readText(source.activeForm) ?? readText(source.active_form),
    status: normalizeTaskStatus(source.status),
    owner: readText(source.owner),
    blocks: readStringList(source.blocks),
    blockedBy: readStringList(source.blockedBy) ?? readStringList(source.blocked_by),
    metadata: isRecord(source.metadata) ? source.metadata : undefined,
  }
}

function unwrapTaskResult(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (isRecord(value.task)) return value.task
  if (isRecord(value.result)) return unwrapTaskResult(value.result)
  if (isRecord(value.data)) return unwrapTaskResult(value.data)
  return value
}

function toolUseResultFromMessage(message: Extract<SDKMessage, { type: 'user' }>): unknown {
  const record = message as unknown
  if (!isRecord(record)) return undefined
  return record.toolUseResult ?? record.tool_use_result
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
