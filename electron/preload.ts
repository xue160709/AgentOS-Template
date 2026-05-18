/**
 * 预加载脚本：`contextBridge` 暴露 `desktop`、`ipcRenderer`、`claudeChat`。
 * Preload bridge exposing `desktop`, `ipcRenderer`, and `claudeChat` to the renderer.
 */

import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'
import type { DesktopPreferences, TrayMenuAction } from '../src/desktop-types'
import type {
  ActiveChatPickPayload,
  ClaudeAgentSettings,
  ClaudeChatEvent,
  ClaudeChatEventHandler,
  ClaudeFileRewindPayload,
  ClaudePermissionResponsePayload,
  ClaudeChatSubmitPayload,
} from '../src/claude-chat-types'

const CLAUDE_CHAT_EVENT_CHANNEL = 'claude-chat:event'
const TRAY_MENU_ACTION_CHANNEL = 'desktop:tray-action'

// --- Desktop bridge / 桌面通用 API ---

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  windowEffects: {
    macVibrancy: process.platform === 'darwin',
  },
  pickProjectDirectory() {
    return ipcRenderer.invoke('desktop:pick-project-directory') as Promise<string | null>
  },
  pickChatAttachments(options?: { allowImages?: boolean }) {
    return ipcRenderer.invoke('desktop:pick-chat-attachments', options)
  },
  listProjectFiles(rootPath: string) {
    return ipcRenderer.invoke('desktop:list-project-files', rootPath)
  },
  searchProjectFiles(rootPath: string, query: string) {
    return ipcRenderer.invoke('desktop:search-project-files', rootPath, query)
  },
  listAgentContext(rootPath: string) {
    return ipcRenderer.invoke('desktop:list-agent-context', rootPath)
  },
  pathExistsUnderProject(rootPath: string, relativePath: string) {
    return ipcRenderer.invoke('desktop:path-exists-under-project', rootPath, relativePath) as Promise<boolean>
  },
  runHomePlugin(rootPath: string, options?: unknown) {
    return ipcRenderer.invoke('desktop:run-home-plugin', rootPath, options)
  },
  getAgentModeStatus(rootPath: string, locale?: 'zh' | 'en') {
    return ipcRenderer.invoke('desktop:get-agent-mode-status', rootPath, locale)
  },
  ensureAgentModeFiles(rootPath: string, locale?: 'zh' | 'en') {
    return ipcRenderer.invoke('desktop:ensure-agent-mode-files', rootPath, locale)
  },
  setAgentModeState(rootPath: string, partial: unknown, locale?: 'zh' | 'en') {
    return ipcRenderer.invoke('desktop:set-agent-mode-state', rootPath, partial, locale)
  },
  getAgentModeSettings(rootPath: string) {
    return ipcRenderer.invoke('desktop:get-agent-mode-settings', rootPath)
  },
  saveAgentModeSettings(rootPath: string, payload: unknown) {
    return ipcRenderer.invoke('desktop:save-agent-mode-settings', rootPath, payload)
  },
  getChatWorkspace() {
    return ipcRenderer.invoke('chat-workspace:get')
  },
  saveChatWorkspace(state: unknown) {
    return ipcRenderer.invoke('chat-workspace:save', state)
  },
  quitApp() {
    return ipcRenderer.invoke('desktop:quit') as Promise<void>
  },
  showItemInFolder(targetPath: string) {
    return ipcRenderer.invoke('desktop:show-item-in-folder', targetPath) as Promise<void>
  },
  openPath(targetPath: string) {
    return ipcRenderer.invoke('desktop:open-path', targetPath) as Promise<void>
  },
  getDesktopPreferences() {
    return ipcRenderer.invoke('desktop-preferences:get') as Promise<DesktopPreferences>
  },
  setDesktopPreferences(partial: Partial<DesktopPreferences>) {
    return ipcRenderer.invoke('desktop-preferences:set', partial) as Promise<DesktopPreferences>
  },
  syncTrayLocale(locale: 'zh' | 'en') {
    return ipcRenderer.invoke('desktop:sync-tray-locale', locale) as Promise<void>
  },
  onTrayMenuAction(handler: (action: TrayMenuAction) => void) {
    const listener = (_event: IpcRendererEvent, raw: unknown) => {
      if (raw === 'new-thread') handler('new-thread')
      else if (raw === 'open-project') handler('open-project')
    }
    ipcRenderer.on(TRAY_MENU_ACTION_CHANNEL, listener)
    return () => ipcRenderer.off(TRAY_MENU_ACTION_CHANNEL, listener)
  },
})

// --- Raw ipcRenderer passthrough / 原始 ipc 封装 ---

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

// --- Claude chat IPC / Claude 聊天 IPC ---

contextBridge.exposeInMainWorld('claudeChat', {
  submit(payload: ClaudeChatSubmitPayload) {
    return ipcRenderer.invoke('claude-chat:submit', payload)
  },
  cancel(requestId?: string) {
    return ipcRenderer.invoke('claude-chat:cancel', requestId)
  },
  newThread(threadId?: string) {
    return ipcRenderer.invoke('claude-chat:new-thread', threadId)
  },
  answerPermissionRequest(payload: ClaudePermissionResponsePayload) {
    return ipcRenderer.invoke('claude-chat:answer-permission-request', payload)
  },
  rewindFiles(payload: ClaudeFileRewindPayload) {
    return ipcRenderer.invoke('claude-chat:rewind-files', payload)
  },
  getSettings() {
    return ipcRenderer.invoke('claude-agent-settings:get')
  },
  saveSettings(settings: ClaudeAgentSettings) {
    return ipcRenderer.invoke('claude-agent-settings:save', settings)
  },
  setActiveChatPick(payload: ActiveChatPickPayload) {
    return ipcRenderer.invoke('claude-agent-settings:set-active-chat-pick', payload)
  },
  onEvent(handler: ClaudeChatEventHandler) {
    const listener = (_event: IpcRendererEvent, event: ClaudeChatEvent) => handler(event)
    ipcRenderer.on(CLAUDE_CHAT_EVENT_CHANNEL, listener)
    return () => ipcRenderer.off(CLAUDE_CHAT_EVENT_CHANNEL, listener)
  },
})
