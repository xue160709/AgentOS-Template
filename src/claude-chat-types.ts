export type ClaudeChatSubmitPayload = {
  text: string
  threadId?: string
  /** 工作区项目文件夹绝对路径；未传时回退到应用根目录 */
  cwd?: string
}

export type ClaudeAgentConfigSource = 'settings' | 'env'

export type ClaudeAgentModelProvider = {
  id: string
  name: string
  apiKey: string
  authToken: string
  baseUrl: string
  model: string
  defaultHaikuModel: string
  defaultOpusModel: string
  defaultSonnetModel: string
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
  getSettings(): Promise<ClaudeAgentSettingsSnapshot>
  saveSettings(settings: ClaudeAgentSettings): Promise<ClaudeAgentSettingsSnapshot>
  setActiveChatPick(payload: ActiveChatPickPayload): Promise<ClaudeAgentSettingsSnapshot>
  onEvent(handler: ClaudeChatEventHandler): () => void
}
