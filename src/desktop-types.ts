/** UI 文本语言 — 与会话偏好（重启后全文切换）对齐；主进程写入 Agent 模板与追加 prompt */
export type AppUiLocale = 'zh' | 'en'

/** 桌面端（Electron）偏好，由主进程持久化到 userData */
export type DesktopPreferences = {
  closeToTray: boolean
  openAtLogin: boolean
  /** 缺省或未识别时读取端按 zh 处理 */
  locale?: AppUiLocale
}

/** 托盘菜单触发的动作（与主进程 IPC 载荷一致） */
export type TrayMenuAction = 'new-thread' | 'open-project'

export type AgentModeFileStatus = 'created' | 'updated' | 'exists'

export type AgentModeFileChange = {
  relativePath: string
  path: string
  status: AgentModeFileStatus
}

export type AgentModeProjectSettings = {
  enabled: boolean
  todoEnabled: boolean
  user: string
  identity: string
}

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
