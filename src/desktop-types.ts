/**
 * 桌面端偏好与 Agent Mode 相关共享类型（渲染进程与主进程对齐）。
 * Desktop preference and Agent Mode shared types aligned across renderer and main.
 */

/** UI 文本语言；与会话偏好一致并由主进程写入模板 / UI text locale; matches session prefs and main-process templates */
export type AppUiLocale = 'zh' | 'en'

/** Electron 偏好：托盘、登录启动与语言（持久化 userData）/ Electron prefs: tray, login item, locale (persisted userData) */
export type DesktopPreferences = {
  closeToTray: boolean
  openAtLogin: boolean
  /** 缺省或未识别时按 zh 处理 / Defaults to zh when missing or unknown */
  locale?: AppUiLocale
}

/** 托盘菜单动作（与 IPC 载荷一致）/ Tray menu action matching IPC payloads */
export type TrayMenuAction = 'new-thread' | 'open-project'

/** Apple Speech helper lifecycle exposed to the renderer / 暴露给渲染层的 Apple 语音状态 */
export type SpeechRecognitionStatus =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'requesting_permission'
  | 'listening'
  | 'transcribing'
  | 'error'

/** Renderer command result for native speech recognition / 原生语音命令结果 */
export type SpeechRecognitionCommandResult =
  | {
      ok: true
      status: SpeechRecognitionStatus
    }
  | {
      ok: false
      status: SpeechRecognitionStatus
      message: string
    }

/** Current native speech recognizer snapshot / 原生语音识别当前快照 */
export type SpeechRecognitionSnapshot = {
  supported: boolean
  status: SpeechRecognitionStatus
}

/** Streaming events from the Apple Speech helper / Apple 语音 helper 事件流 */
export type SpeechRecognitionEvent =
  | {
      type: 'status'
      status: SpeechRecognitionStatus
      locale?: string
      supportsOnDevice?: boolean
      requiresOnDevice?: boolean
    }
  | {
      type: 'partial'
      text: string
    }
  | {
      type: 'final'
      text: string
    }
  | {
      type: 'error'
      code: string
      message: string
    }

/** Agent Mode 文件写入状态 / Agent Mode scaffold file status */
export type AgentModeFileStatus = 'created' | 'updated' | 'exists'

/** Agent Mode 单次文件变更记录 / Single Agent Mode file change record */
export type AgentModeFileChange = {
  relativePath: string
  path: string
  status: AgentModeFileStatus
}

/** Agent Mode 项目级开关与身份文案 / Project-level Agent Mode toggles and identity copy */
export type AgentModeProjectSettings = {
  enabled: boolean
  todoEnabled: boolean
  user: string
  identity: string
}

/** Agent Mode 状态查询结果 / Agent Mode status query result */
export type AgentModeStatusResult =
  | {
      ok: true
      rootPath: string
      enabled: boolean
      todoEnabled: boolean
      instructionFile: string
      missingFiles: string[]
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Agent Mode 设置读写结果 / Agent Mode settings read/write result */
export type AgentModeSettingsResult =
  | {
      ok: true
      rootPath: string
      settings: AgentModeProjectSettings
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Agent Mode 文件清单生成结果 / Agent Mode scaffold files generation result */
export type AgentModeFilesResult =
  | {
      ok: true
      rootPath: string
      instructionFile: string
      files: AgentModeFileChange[]
      message: string
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Home Plugin 运行状态 / Home Plugin run state */
export type HomePluginRunStatus = 'empty' | 'ready' | 'unchanged'

/** Home Plugin 卡片尺寸 / Home Plugin card display span */
export type HomePluginCardSize = 'small' | 'medium' | 'large'

/** Home Plugin manifest 元数据 / Home Plugin manifest metadata */
export type HomePluginManifest = {
  id: string
  name: string
  version: string
  description: string
  entry: string
  outputFormat: string
  kind: 'data' | 'task'
  preferredSize: HomePluginCardSize
  threadId?: string
  createdAt?: string
  updatedAt?: string
  order?: number
}

/** 单个 Home Plugin 卡片运行结果 / Single Home Plugin card run item */
export type HomePluginRunItem = {
  slug: string
  rootPath: string
  pluginPath: string
  manifest: HomePluginManifest
  status: HomePluginRunStatus
  outputHash?: string
  messages?: unknown[]
  variants?: Partial<Record<HomePluginCardSize, unknown[]>>
  diagnostics?: string[]
}

/** Home Plugin 运行选项 / Home Plugin run options */
export type HomePluginRunOptions = {
  /** 渲染层已持有的输出 hash；相同时主进程返回 unchanged / Renderer-held hash; returns unchanged when equal */
  knownOutputHash?: string
  /** 多插件模式下按 slug 传入已知 hash / Per-plugin known hashes for multi-plugin mode */
  knownOutputHashes?: Record<string, string>
}

/** 项目首页插件输出 / Project home plugin output */
export type HomePluginRunResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath?: string
      pluginPath?: string
      status: HomePluginRunStatus
      outputHash?: string
      messages?: unknown[]
      plugins?: HomePluginRunItem[]
      order?: string[]
      diagnostics?: string[]
    }
  | {
      ok: false
      rootPath: string
      pluginPath?: string
      message: string
      diagnostics?: string[]
    }

/** Home Plugin 排序保存结果 / Home Plugin order save result */
export type HomePluginOrderSaveResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath: string
      order: string[]
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Home Plugin 卡片布局项 / Home Plugin card layout item */
export type HomePluginCardLayoutItem = {
  slug: string
  preferredSize: HomePluginCardSize
}

/** Home Plugin 布局保存结果 / Home Plugin layout save result */
export type HomePluginLayoutSaveResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath: string
      order: string[]
      cards: HomePluginCardLayoutItem[]
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Home Plugin 删除结果 / Home Plugin delete result */
export type HomePluginDeleteResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath: string
      slug: string
      deletedPath: string
      order: string[]
    }
  | {
      ok: false
      rootPath: string
      slug?: string
      message: string
    }

/** Home Plugin 任务运行模式 / Home Plugin task execution mode */
export type HomePluginTaskMode = 'agent' | 'skills'

/** Home Plugin 任务技能步骤 / A single skill step in a task sequence */
export type HomePluginTaskSkillStep = {
  id: string
  command: string
  path: string
  title: string
  description?: string
  addedAt: string
}

/** Home Plugin 任务定时配置 / Home Plugin schedule configuration */
export type HomePluginTaskSchedule = {
  enabled: boolean
  hour: number
  minute: number
  interval: 'off' | '1h' | '2h' | '3h' | '6h' | '12h' | '1d'
}

/** Home Plugin 任务卡配置 / Task card configuration persisted in task.json */
export type HomePluginTaskConfig = {
  version: 1
  slug: string
  title: string
  mode: HomePluginTaskMode
  skillSteps: HomePluginTaskSkillStep[]
  todoEnabled: boolean
  runCount: number
  schedule: HomePluginTaskSchedule
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Home Plugin 任务运行态 / Task runtime snapshot persisted in runtime.json */
export type HomePluginTaskRuntimeStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled'

/** Home Plugin 任务运行态快照 / Task runtime snapshot */
export type HomePluginTaskRuntime = {
  version: 1
  projectPath: string
  slug: string
  threadId?: string
  threadTitle?: string
  status: HomePluginTaskRuntimeStatus
  requestId?: string
  runIndex?: number
  runTotal?: number
  stepIndex?: number
  stepTotal?: number
  stepTitle?: string
  lastRunAt?: string
  lastCompletedAt?: string
  lastResult?: string
  lastError?: string
  nextRunAt?: string
  summary?: string
  detail?: string
  updatedAt: string
}

/** Home Plugin 任务持久化保存结果 / Task config save result */
export type HomePluginTaskSaveResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath: string
      slug: string
      manifestPath: string
      taskPath: string
      runtimePath: string
      manifest: HomePluginManifest
      task: HomePluginTaskConfig
      runtime: HomePluginTaskRuntime
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Home Plugin 任务运行结果 / Task run launch result */
export type HomePluginTaskRunResult =
  | {
      ok: true
      rootPath: string
      slug: string
      threadId: string
      requestId: string
      title: string
    }
  | {
      ok: false
      rootPath: string
      slug: string
      message: string
    }

/** Home Plugin 任务停止结果 / Task stop result */
export type HomePluginTaskStopResult =
  | {
      ok: true
      rootPath: string
      slug: string
      stopped: boolean
    }
  | {
      ok: false
      rootPath: string
      slug: string
      message: string
    }

/** Home Plugin 任务读取结果 / Task read result */
export type HomePluginTaskReadResult =
  | {
      ok: true
      rootPath: string
      slug: string
      task: HomePluginTaskConfig
      runtime: HomePluginTaskRuntime
      manifest: HomePluginManifest
    }
  | {
      ok: false
      rootPath: string
      slug: string
      message: string
    }

/** Home Plugin 任务列表结果 / Task list result */
export type HomePluginTaskListResult =
  | {
      ok: true
      rootPath: string
      pluginRootPath: string
      tasks: Array<{
        slug: string
        manifest: HomePluginManifest
        task: HomePluginTaskConfig
        runtime: HomePluginTaskRuntime
      }>
    }
  | {
      ok: false
      rootPath: string
      message: string
    }

/** Home Plugin 任务状态事件 / Task state event mirrored to the renderer */
export type HomePluginTaskEvent = {
  projectPath: string
  slug: string
  task: HomePluginTaskConfig
  runtime: HomePluginTaskRuntime
  thread?: {
    id: string
    projectId: string
    title: string
    purpose: 'task-run'
    homePluginSlug: string
    createdAt: number
    updatedAt: number
  }
}

/** 应用更新阶段 / In-app update lifecycle phase */
export type AppUpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** 应用更新状态（主进程 → 渲染进程）/ App update state pushed to the renderer */
export type AppUpdaterState = {
  phase: AppUpdaterPhase
  /** 打包应用为 true；开发模式为 false / true when packaged production build */
  updatesSupported: boolean
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  errorMessage?: string
}
