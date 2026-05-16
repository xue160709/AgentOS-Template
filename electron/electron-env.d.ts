/// <reference types="vite-plugin-electron/electron-env" />

import type { ClaudeChatAPI } from '../src/claude-chat-types'
import type {
  AgentContextResult,
  ProjectFileSearchResult,
} from '../src/claude-chat-types'
import type { DesktopPreferences, TrayMenuAction } from '../src/desktop-types'
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

  // Used in Renderer process, expose in `preload.ts`
  interface Window {
    ipcRenderer: import('electron').IpcRenderer
    claudeChat?: ClaudeChatAPI
    desktop?: {
      platform: NodeJS.Platform
      /** macOS 透明窗口 + vibrancy，用于渲染层切换样式（系统级磨砂 / 桌面透出） */
      windowEffects?: {
        macVibrancy: boolean
      }
      pickProjectDirectory?: () => Promise<string | null>
      listProjectFiles?: (rootPath: string) => Promise<FileTreeResult>
      searchProjectFiles?: (rootPath: string, query: string) => Promise<ProjectFileSearchResult>
      listAgentContext?: (rootPath: string) => Promise<AgentContextResult>
      getChatWorkspace?: () => Promise<ChatWorkspaceState | null>
      saveChatWorkspace?: (state: ChatWorkspaceState) => Promise<ChatWorkspaceState>
      quitApp?: () => Promise<void>
      /** 在系统文件管理器中显示路径（macOS 为访达） */
      showItemInFolder?: (targetPath: string) => Promise<void>
      getDesktopPreferences?: () => Promise<DesktopPreferences>
      setDesktopPreferences?: (partial: Partial<DesktopPreferences>) => Promise<DesktopPreferences>
      syncTrayLocale?: (locale: 'zh' | 'en') => Promise<void>
      onTrayMenuAction?: (handler: (action: TrayMenuAction) => void) => () => void
    }
  }
}

export {}
