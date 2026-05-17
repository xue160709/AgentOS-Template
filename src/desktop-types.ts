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

/** Home Plugin 运行选项 / Home Plugin run options */
export type HomePluginRunOptions = {
  /** 渲染层已持有的输出 hash；相同时主进程返回 unchanged / Renderer-held hash; returns unchanged when equal */
  knownOutputHash?: string
}

/** 项目首页插件输出 / Project home plugin output */
export type HomePluginRunResult =
  | {
      ok: true
      rootPath: string
      pluginPath?: string
      status: HomePluginRunStatus
      outputHash?: string
      messages?: unknown[]
      diagnostics?: string[]
    }
  | {
      ok: false
      rootPath: string
      pluginPath?: string
      message: string
      diagnostics?: string[]
    }
