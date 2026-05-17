/**
 * Claude 聊天与 Agent 相关的共享类型（渲染进程与 Electron 主进程通过 IPC 交换）。
 * Shared types for Claude chat and Agent payloads exchanged via IPC (renderer ↔ Electron main).
 */

// --- Submit payload & attachments / 提交载荷与附件 ---

/** 用户发送对话的载荷 / Payload when submitting a user chat message */
export type ClaudeChatSubmitPayload = {
  text: string
  attachments?: ClaudeChatAttachment[]
  threadId?: string
  /** 特殊提示词通道；普通聊天省略 / Special prompt channel; omitted for normal chat */
  promptMode?: 'home-plugin-customization'
  /**
   * 上次 Agent SDK 会话 ID（chatState 持久化）；主进程重启后可恢复同一会话；若已有活跃 session 则忽略。
   * Last Agent SDK session id (persisted in chatState); resumes after main restart; ignored if session already active.
   */
  sessionId?: string
  /** 工作区项目绝对路径；省略则回退应用根目录 / Absolute cwd for the workspace project; falls back to app root */
  cwd?: string
  permissionMode?: ClaudePermissionMode
}

/** 附件种类：文本或图片 / Attachment kind: text or image */
export type ClaudeChatAttachmentKind = 'text' | 'image'

/** 单个聊天附件的元数据与可选内联内容 / Chat attachment metadata plus optional inline payload */
export type ClaudeChatAttachment = {
  id: string
  kind: ClaudeChatAttachmentKind
  name: string
  path: string
  mimeType: string
  size: number
  /** 文本正文（仅送主进程/Agent，勿长期持久化）/ Text body for main/agent only; avoid persisting long-term */
  text?: string
  /** 图片 base64（仅送主进程/Agent）/ Image base64 for main/agent only */
  base64?: string
  /** UI 短预览 / Short preview for UI */
  preview?: string
  /** UI data URL 缩略图 / Data URL thumbnail for UI */
  dataUrl?: string
}

/** 被跳过附件的原因说明 / Reason an attachment was skipped */
export type ClaudeChatAttachmentSkipped = {
  name: string
  path: string
  reason: string
}

/** 附件选择器结果：成功含列表或失败信息 / Attachment picker outcome: success list or error */
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

/** Claude Agent 权限模式 / Claude Agent permission mode */
export type ClaudePermissionMode = 'plan' | 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions'

// --- User prompts & permission responses / 用户问答与权限应答 ---

/** Agent 询问用户的单个选项 / Single option for an agent ask-user prompt */
export type ClaudeAskUserQuestionOption = {
  label: string
  description: string
  preview?: string
}

/** Agent 向用户提出的问题块 / Agent question block shown to the user */
export type ClaudeAskUserQuestion = {
  question: string
  header: string
  options: ClaudeAskUserQuestionOption[]
  multiSelect: boolean
}

/** 用户对权限请求或问答的响应载荷 / User response payload for permission or ask-user flows */
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

// --- Agent context catalog / Agent 上下文目录 ---

/** 上下文条目作用域：用户级或项目级 / Context entry scope: user or project */
export type AgentContextScope = 'user' | 'project'

/** 上下文来源标记（CLI 目录约定）/ Context origin marker for CLI directories */
export type AgentContextSource = 'claude' | 'agent' | 'agents' | 'cursor'

/** Slash 命令种类：技能或命令 / Slash entry kind: skill or command */
export type AgentContextSlashKind = 'skill' | 'command'

/** Slash 技能/命令在 UI 与插入文本中的表示 / Slash skill/command representation for UI and insertion */
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

/** Agent 定义条目（子 agent）/ Sub-agent definition entry */
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

/** 指令文件（AGENTS 等）及其加载方式 / Instruction file (e.g. AGENTS) and load mode */
export type AgentInstructionFile = {
  name: string
  path: string
  relativePath: string
  scope: AgentContextScope
  source: AgentContextSource
  loadMode: 'sdk' | 'host'
}

/** 扫描成功的上下文目录快照 / Successful scanned agent context catalog */
export type AgentContextCatalog = {
  ok: true
  rootPath: string
  skills: AgentContextSlashItem[]
  agents: AgentContextAgentItem[]
  instructionFiles: AgentInstructionFile[]
}

/** 上下文扫描结果：成功目录或错误 / Agent context scan result: catalog or error */
export type AgentContextResult =
  | AgentContextCatalog
  | {
      ok: false
      rootPath: string
      message: string
    }

// --- Project file search / 项目内文件搜索 ---

/** 搜索结果的单个文件或目录项 / Single file or directory hit from project search */
export type ProjectFileSearchItem = {
  label: string
  path: string
  relativePath: string
  type: 'directory' | 'file'
}

/** 项目文件搜索结果：列表或错误 / Project file search outcome: items or error */
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

// --- Claude Agent settings / Claude Agent 设置 ---

/** 配置来源：应用设置或环境变量 / Config origin: persisted settings or environment */
export type ClaudeAgentConfigSource = 'settings' | 'env'

/** 单个模型提供商的配置块 / Per-provider Claude/agent configuration block */
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

/** 全量 Agent 设置（多提供商）/ Full agent settings including multiple providers */
export type ClaudeAgentSettings = {
  configSource: ClaudeAgentConfigSource
  activeProviderId: string
  /** 覆盖主 Model 的实际请求 ID（须匹配档位映射）；空则用语义主模型 / Overrides primary model id (must match tier mapping); empty uses semantic primary */
  activeAnthropicModel: string
  providers: ClaudeAgentModelProvider[]
}

/** 当前选用的提供商与模型（聊天 UI）/ Active provider/model pick from chat UI */
export type ActiveChatPickPayload = {
  providerId: string
  /** 省略或空表示主模型；显式等于主模型时也归并为空 / Omit or empty uses primary model; explicit primary collapses to empty too */
  anthropicModel?: string | null
}

/** 环境变量侧 Agent 配置快照（脱敏标志）/ Env-side agent snapshot with presence flags */
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

/** 设置与环境快照的组合视图 / Combined settings + env snapshot for UI */
export type ClaudeAgentSettingsSnapshot = {
  settings: ClaudeAgentSettings
  env: ClaudeAgentEnvSnapshot
}

/** 主进程解析后的最终请求配置 / Fully resolved config used by the main-process runner */
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

/** 提交对话后主进程返回的请求 ID / Request id returned after submitting a chat turn */
export type ClaudeChatSubmitResult = {
  requestId: string
}

/** Agent 活动条的状态 / Status for inline agent activity rows */
export type ClaudeChatActivityStatus = 'running' | 'done' | 'error' | 'info'

// --- File diffs & rewind / 文件 diff 与回滚 ---

/** 单行 diff 类型 / Single rendered diff line kind */
export type ClaudeFileDiffLineKind = 'context' | 'add' | 'delete'

/** 单行 diff，含旧/新文件行号 / Single diff line with old/new line numbers */
export type ClaudeFileDiffLine = {
  kind: ClaudeFileDiffLineKind
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

/** 单个 diff hunk / Single diff hunk */
export type ClaudeFileDiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ClaudeFileDiffLine[]
}

/** 文件变更状态 / File change status */
export type ClaudeFileDiffFileStatus = 'added' | 'modified' | 'deleted' | 'unknown'

/** 单文件 diff 快照 / Single-file diff snapshot */
export type ClaudeFileDiffFile = {
  path: string
  relativePath: string
  status: ClaudeFileDiffFileStatus
  additions: number
  deletions: number
  hunks: ClaudeFileDiffHunk[]
  truncated?: boolean
}

/** 文件变更卡状态 / File change card status */
export type ClaudeFileChangeSetStatus = 'captured' | 'reviewed' | 'reverted' | 'error'

/** 请求回滚文件变更 / Request to rewind file changes */
export type ClaudeFileRewindPayload = {
  requestId?: string
  threadId?: string
  changeSetId?: string
  checkpointId: string
  cwd?: string
}

/** 回滚文件变更的结果 / Result of rewinding file changes */
export type ClaudeFileRewindResult = {
  ok: boolean
  changeSetId?: string
  message?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

// --- Streaming events & API surface / 流式事件与 API ---

/** 单条聊天事件（含可选线程归属）/ Single streamed chat event with optional thread id */
export type ClaudeChatEvent = ClaudeChatEventBase & {
  /** 事件所属线程；旧负载可能缺省，UI 回退到 request 映射 / Owning thread; legacy events omit and UI maps by request */
  threadId?: string
}

/** 聊天事件判别联合（SDK → UI）/ Discriminated union of SDK→UI chat events */
export type ClaudeChatEventBase =
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
      type: 'file_diff'
      requestId: string
      changeSetId: string
      checkpointId?: string
      files: ClaudeFileDiffFile[]
    }
  | {
      type: 'file_rewind_result'
      requestId: string
      changeSetId?: string
      status: 'reverted' | 'error'
      detail?: string
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

/** 聊天事件订阅回调 / Subscriber callback for chat events */
export type ClaudeChatEventHandler = (event: ClaudeChatEvent) => void

/** 预加载暴露给渲染进程的聊天 API 形状 / Chat API shape exposed via preload to renderer */
export type ClaudeChatAPI = {
  submit(payload: ClaudeChatSubmitPayload): Promise<ClaudeChatSubmitResult>
  cancel(requestId?: string): Promise<void>
  newThread(threadId?: string): Promise<void>
  answerPermissionRequest(payload: ClaudePermissionResponsePayload): Promise<void>
  rewindFiles(payload: ClaudeFileRewindPayload): Promise<ClaudeFileRewindResult>
  getSettings(): Promise<ClaudeAgentSettingsSnapshot>
  saveSettings(settings: ClaudeAgentSettings): Promise<ClaudeAgentSettingsSnapshot>
  setActiveChatPick(payload: ActiveChatPickPayload): Promise<ClaudeAgentSettingsSnapshot>
  onEvent(handler: ClaudeChatEventHandler): () => void
}
