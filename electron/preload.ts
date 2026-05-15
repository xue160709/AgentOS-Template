import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'
import type {
  ActiveChatPickPayload,
  ClaudeAgentSettings,
  ClaudeChatEvent,
  ClaudeChatEventHandler,
  ClaudeChatSubmitPayload,
} from '../src/claude-chat-types'

const CLAUDE_CHAT_EVENT_CHANNEL = 'claude-chat:event'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  windowEffects: {
    macVibrancy: process.platform === 'darwin',
  },
})

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
