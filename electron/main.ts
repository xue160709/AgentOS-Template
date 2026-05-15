import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ClaudeAgentRunner } from './claude-agent-runner'
import { ClaudeAgentSettingsStore } from './claude-agent-settings'
import { loadMainProcessEnv } from './env-loader'
import type {
  ActiveChatPickPayload,
  ClaudeAgentSettings,
  ClaudeChatSubmitPayload,
} from '../src/claude-chat-types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')
loadMainProcessEnv(process.env.APP_ROOT)

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let claudeAgentRunner: ClaudeAgentRunner | null = null
let claudeAgentSettingsStore: ClaudeAgentSettingsStore | null = null

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#181818' : '#f9f9f9'
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: isMac ? '#00000000' : getWindowBackgroundColor(),
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 13 },
          /** 仅透明区域透出系统 material；右侧工作区用不透明白底盖住 */
          transparent: true,
          vibrancy: 'under-window' as const,
          backgroundColor: '#00000000',
        }
      : {}),
  })

  claudeAgentRunner = new ClaudeAgentRunner(win.webContents, process.env.APP_ROOT, () => getClaudeAgentSettingsStore().resolve())

  if (!isMac) {
    const syncBackgroundColor = () => {
      win?.setBackgroundColor(getWindowBackgroundColor())
    }
    nativeTheme.on('updated', syncBackgroundColor)
    win.on('closed', () => {
      nativeTheme.off('updated', syncBackgroundColor)
    })
  }

  win.on('closed', () => {
    claudeAgentRunner = null
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function getClaudeAgentRunner() {
  if (!claudeAgentRunner) {
    throw new Error('Claude Agent runner is not ready.')
  }
  return claudeAgentRunner
}

function getClaudeAgentSettingsStore() {
  if (!claudeAgentSettingsStore) {
    throw new Error('Claude Agent settings store is not ready.')
  }
  return claudeAgentSettingsStore
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system'
  claudeAgentSettingsStore = new ClaudeAgentSettingsStore(app.getPath('userData'))
  ipcMain.handle('claude-chat:submit', (_event, payload: ClaudeChatSubmitPayload) => {
    return getClaudeAgentRunner().submit(payload)
  })
  ipcMain.handle('claude-chat:cancel', (_event, requestId?: string) => {
    return getClaudeAgentRunner().cancel(requestId)
  })
  ipcMain.handle('claude-chat:new-thread', (_event, threadId?: string) => {
    return getClaudeAgentRunner().newThread(threadId)
  })
  ipcMain.handle('claude-agent-settings:get', () => {
    return getClaudeAgentSettingsStore().getSnapshot()
  })
  ipcMain.handle('claude-agent-settings:save', (_event, settings: ClaudeAgentSettings) => {
    return getClaudeAgentSettingsStore().save(settings)
  })
  ipcMain.handle('claude-agent-settings:set-active-chat-pick', (_event, payload: ActiveChatPickPayload) => {
    return getClaudeAgentSettingsStore().setActiveChatPick(payload)
  })
  createWindow()
})
