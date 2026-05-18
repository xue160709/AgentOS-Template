/// <reference types="vite-plugin-electron/electron-env" />

/**
 * 渲染进程全局 Window 类型：对齐 preload 暴露的 API。
 * Augment `Window` with APIs mirrored from `preload.ts`.
 */

import type { ClaudeChatAPI } from '../src/claude-chat-types'
import type {
  AgentContextResult,
  ClaudeChatAttachmentPickerResult,
  ProjectFileSearchResult,
} from '../src/claude-chat-types'
import type {
  AgentModeFilesResult,
  AgentModeProjectSettings,
  AgentModeSettingsResult,
  AgentModeStatusResult,
  AppUiLocale,
  DesktopPreferences,
  HomePluginRunOptions,
  HomePluginRunResult,
  TrayMenuAction,
} from '../src/desktop-types'
import type { ChatWorkspaceState, FileTreeResult } from '../src/components/types'

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /**
       * The built directory structure
       *
       * ```tree
       * ├─┬─┬ dist
       * │ │ └── index.html
       * │ │
       * │ ├─┬ dist-electron
       * │ │ ├── main.js
       * │ │ └── preload.js
       * │
       * ```
       */
      APP_ROOT: string
      /** /dist/ or /public/ */
      VITE_PUBLIC: string
    }
  }

  // preload.ts 注入的类型扩展 / Augmented via preload script
  interface Window {
    ipcRenderer: import('electron').IpcRenderer
    claudeChat?: ClaudeChatAPI
    desktop?: {
      platform: NodeJS.Platform
      /** macOS 透明磨砂窗口标记（渲染层样式钩子）/ Enables vibrancy-aware styling on macOS */
      windowEffects?: {
        macVibrancy: boolean
      }
      pickProjectDirectory?: () => Promise<string | null>
      pickChatAttachments?: (options?: { allowImages?: boolean }) => Promise<ClaudeChatAttachmentPickerResult>
      listProjectFiles?: (rootPath: string) => Promise<FileTreeResult>
      searchProjectFiles?: (rootPath: string, query: string) => Promise<ProjectFileSearchResult>
      listAgentContext?: (rootPath: string) => Promise<AgentContextResult>
      /** 相对路径须不含 `..`；用于探测项目下目录/文件是否存在 / Relative path must not contain `..` */
      pathExistsUnderProject?: (rootPath: string, relativePath: string) => Promise<boolean>
      runHomePlugin?: (rootPath: string, options?: HomePluginRunOptions) => Promise<HomePluginRunResult>
      getAgentModeStatus?: (rootPath: string, locale?: AppUiLocale) => Promise<AgentModeStatusResult>
      ensureAgentModeFiles?: (rootPath: string, locale?: AppUiLocale) => Promise<AgentModeFilesResult>
      setAgentModeState?: (
        rootPath: string,
        partial: Partial<Pick<AgentModeProjectSettings, 'enabled' | 'todoEnabled'>>,
        locale?: AppUiLocale,
      ) => Promise<AgentModeStatusResult>
      getAgentModeSettings?: (rootPath: string) => Promise<AgentModeSettingsResult>
      saveAgentModeSettings?: (
        rootPath: string,
        payload: Pick<AgentModeProjectSettings, 'user' | 'identity'>,
      ) => Promise<AgentModeSettingsResult>
      getChatWorkspace?: () => Promise<ChatWorkspaceState | null>
      saveChatWorkspace?: (state: ChatWorkspaceState) => Promise<ChatWorkspaceState>
      quitApp?: () => Promise<void>
      /** 在访达/资源管理器中展示路径 / Reveal path in Finder or Explorer */
      showItemInFolder?: (targetPath: string) => Promise<void>
      /** 使用系统默认应用打开路径 / Open path with the system default app */
      openPath?: (targetPath: string) => Promise<void>
      getDesktopPreferences?: () => Promise<DesktopPreferences>
      setDesktopPreferences?: (partial: Partial<DesktopPreferences>) => Promise<DesktopPreferences>
      syncTrayLocale?: (locale: 'zh' | 'en') => Promise<void>
      onTrayMenuAction?: (handler: (action: TrayMenuAction) => void) => () => void
    }
  }
}

export {}
