export type ClaudeChatSubmitPayload = {
  text: string
  attachments?: ClaudeChatAttachment[]
  threadId?: string
  /** 工作区项目文件夹绝对路径；未传时回退到应用根目录 */
  cwd?: string
  permissionMode?: ClaudePermissionMode
}

export type ClaudeChatAttachmentKind = 'text' | 'image'

export type ClaudeChatAttachment = {
  id: string
  kind: ClaudeChatAttachmentKind
  name: string
  path: string
  mimeType: string
  size: number
  /** 文本附件正文，仅发送给主进程 / Agent，不建议长期持久化 */
  text?: string
  /** 图片 base64，仅发送给主进程 / Agent，不建议长期持久化 */
  base64?: string
  /** UI 展示用短预览 */
  preview?: string
  /** UI 缩略图预览 */
  dataUrl?: string
}

export type ClaudeChatAttachmentSkipped = {
  name: string
  path: string
  reason: string
}

export type ClaudeChatAttachmentPickerResult =
  | {
      ok: true
      attachments: ClaudeChatAttachment[]
      skipped: ClaudeChatAttachmentSkipped[]
    }
  | {
      ok: false
      message: string
    }

export type ClaudePermissionMode = 'plan' | 'auto' | 'default' | 'bypassPermissions'

export type ClaudeAskUserQuestionOption = {
  label: string
  description: string
  preview?: string
}

export type ClaudeAskUserQuestion = {
  question: string
  header: string
  options: ClaudeAskUserQuestionOption[]
  multiSelect: boolean
}

export type ClaudePermissionResponsePayload =
  | {
      permissionRequestId: string
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
    }
  | {
      permissionRequestId: string
      behavior: 'deny'
      message?: string
    }

export type AgentContextScope = 'user' | 'project'

export type AgentContextSource = 'claude' | 'agent' | 'agents' | 'cursor'

export type AgentContextSlashKind = 'skill' | 'command'

export type AgentContextSlashItem = {
  kind: AgentContextSlashKind
  name: string
  command: string
  title: string
  description: string
  argumentHint: string
  path: string
  relativePath: string
  scope: AgentContextScope
  source: AgentContextSource
  native: boolean
}

export type AgentContextAgentItem = {
  kind: 'agent'
  name: string
  description: string
  path: string
  relativePath: string
  scope: AgentContextScope
  source: AgentContextSource
  native: boolean
  model?: string
  tools: string[]
}

export type AgentInstructionFile = {
  name: string
  path: string
  relativePath: string
  scope: AgentContextScope
  source: AgentContextSource
  loadMode: 'sdk' | 'host'
}

export type AgentContextCatalog = {
  ok: true
  rootPath: string
  skills: AgentContextSlashItem[]
  agents: AgentContextAgentItem[]
  instructionFiles: AgentInstructionFile[]
}

export type AgentContextResult =
  | AgentContextCatalog
  | {
      ok: false
      rootPath: string
      message: string
    }

export type ProjectFileSearchItem = {
  label: string
  path: string
  relativePath: string
  type: 'directory' | 'file'
}

export type ProjectFileSearchResult =
  | {
      ok: true
      rootPath: string
      items: ProjectFileSearchItem[]
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

export type ClaudeAgentConfigSource = 'settings' | 'env'

export type ClaudeAgentModelProvider = {
  id: string
  name: string
  apiKey: string
  authToken: string
  baseUrl: string
  model: string
  modelSupportsImages: boolean
  defaultHaikuModel: string
  defaultHaikuSupportsImages: boolean
  defaultOpusModel: string
  defaultOpusSupportsImages: boolean
  defaultSonnetModel: string
  defaultSonnetSupportsImages: boolean
}

export type ClaudeAgentSettings = {
  configSource: ClaudeAgentConfigSource
  activeProviderId: string
  /** 选用主 Model 之外的实际请求模型 ID（须属于当前条目的主模型或各档位映射）；空则用语义主 Model */
  activeAnthropicModel: string
  providers: ClaudeAgentModelProvider[]
}

export type ActiveChatPickPayload = {
  providerId: string
  /** 省略或空：主 Model；显式传主 Model 时也会归并为空 */
  anthropicModel?: string | null
}

export type ClaudeAgentEnvSnapshot = {
  hasApiKey: boolean
  hasAuthToken: boolean
  baseUrl: string
  model: string
  supportsImages: boolean
  defaultHaikuModel: string
  defaultOpusModel: string
  defaultSonnetModel: string
}

export type ClaudeAgentSettingsSnapshot = {
  settings: ClaudeAgentSettings
  env: ClaudeAgentEnvSnapshot
}

export type ClaudeAgentResolvedConfig = {
  configSource: ClaudeAgentConfigSource
  apiKey: string
  authToken: string
  baseUrl: string
  model: string
  supportsImages: boolean
  defaultHaikuModel: string
  defaultOpusModel: string
  defaultSonnetModel: string
}

export type ClaudeChatSubmitResult = {
  requestId: string
}

export type ClaudeChatActivityStatus = 'running' | 'done' | 'error' | 'info'

export type ClaudeChatEvent =
  | {
      type: 'session_start'
      requestId: string
      sessionId: string
      model: string
      cwd: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      agents: string[]
      mcpServers: { name: string; status: string }[]
      permissionMode: string
      plugins: string[]
    }
  | {
      type: 'assistant_delta'
      requestId: string
      messageId: string
      text: string
    }
  | {
      type: 'thinking_start'
      requestId: string
      thinkingId: string
      title: string
    }
  | {
      type: 'thinking_delta'
      requestId: string
      thinkingId: string
      text: string
    }
  | {
      type: 'thinking_done'
      requestId: string
      thinkingId: string
    }
  | {
      type: 'tool_start'
      requestId: string
      toolUseId: string
      name: string
      inputPreview: string
    }
  | {
      type: 'tool_update'
      requestId: string
      toolUseId: string
      inputPreview?: string
      detail?: string
    }
  | {
      type: 'tool_done'
      requestId: string
      toolUseId: string
      status: 'done' | 'error' | 'denied'
      detail?: string
    }
  | {
      type: 'ask_user_question'
      requestId: string
      permissionRequestId: string
      toolUseId: string
      questions: ClaudeAskUserQuestion[]
    }
  | {
      type: 'permission_request'
      requestId: string
      permissionRequestId: string
      toolUseId: string
      toolName: string
      title: string
      displayName: string
      description: string
      inputPreview: string
    }
  | {
      type: 'agent_activity'
      requestId: string
      activityId: string
      title: string
      status: ClaudeChatActivityStatus
      detail?: string
      preview?: string
    }
  | {
      type: 'result'
      requestId: string
      sessionId: string
      result: string
      costUsd?: number
      durationMs?: number
    }
  | {
      type: 'error'
      requestId: string
      code: string
      message: string
    }
  | {
      type: 'cancelled'
      requestId: string
    }

export type ClaudeChatEventHandler = (event: ClaudeChatEvent) => void

export type ClaudeChatAPI = {
  submit(payload: ClaudeChatSubmitPayload): Promise<ClaudeChatSubmitResult>
  cancel(requestId?: string): Promise<void>
  newThread(threadId?: string): Promise<void>
  answerPermissionRequest(payload: ClaudePermissionResponsePayload): Promise<void>
  getSettings(): Promise<ClaudeAgentSettingsSnapshot>
  saveSettings(settings: ClaudeAgentSettings): Promise<ClaudeAgentSettingsSnapshot>
  setActiveChatPick(payload: ActiveChatPickPayload): Promise<ClaudeAgentSettingsSnapshot>
  onEvent(handler: ClaudeChatEventHandler): () => void
}
