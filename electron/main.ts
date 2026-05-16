import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverAgentContext, searchProjectFiles } from './agent-context'
import { ClaudeAgentRunner } from './claude-agent-runner'
import { ClaudeAgentSettingsStore } from './claude-agent-settings'
import { ChatWorkspaceStore } from './chat-workspace-store'
import { loadMainProcessEnv } from './env-loader'
import type {
  ActiveChatPickPayload,
  ClaudeAgentSettings,
  ClaudeChatSubmitPayload,
  ClaudePermissionResponsePayload,
} from '../src/claude-chat-types'
import type { FileTreeNode, FileTreeResult } from '../src/components/types'

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
let chatWorkspaceStore: ChatWorkspaceStore | null = null

const FILE_TREE_MAX_DEPTH = 8
const FILE_TREE_MAX_ENTRIES = 1200
const FILE_TREE_MAX_CHILDREN_PER_DIRECTORY = 200
const FILE_TREE_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
  'release',
])

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

function getChatWorkspaceStore() {
  if (!chatWorkspaceStore) {
    throw new Error('Chat workspace store is not ready.')
  }
  return chatWorkspaceStore
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
  const userDataPath = app.getPath('userData')
  claudeAgentSettingsStore = new ClaudeAgentSettingsStore(userDataPath)
  chatWorkspaceStore = new ChatWorkspaceStore(userDataPath)
  ipcMain.handle('claude-chat:submit', (_event, payload: ClaudeChatSubmitPayload) => {
    return getClaudeAgentRunner().submit(payload)
  })
  ipcMain.handle('claude-chat:cancel', (_event, requestId?: string) => {
    return getClaudeAgentRunner().cancel(requestId)
  })
  ipcMain.handle('claude-chat:new-thread', (_event, threadId?: string) => {
    return getClaudeAgentRunner().newThread(threadId)
  })
  ipcMain.handle('claude-chat:answer-permission-request', (_event, payload: ClaudePermissionResponsePayload) => {
    return getClaudeAgentRunner().answerPermissionRequest(payload)
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
  ipcMain.handle('chat-workspace:get', () => {
    return getChatWorkspaceStore().read()
  })
  ipcMain.handle('chat-workspace:save', (_event, state: unknown) => {
    return getChatWorkspaceStore().save(state)
  })
  ipcMain.handle('desktop:pick-project-directory', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? win
    if (!parent) return null
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })
  ipcMain.handle('desktop:list-project-files', (_event, rootPath: string) => {
    return readProjectFileTree(rootPath)
  })
  ipcMain.handle('desktop:search-project-files', (_event, rootPath: string, query: string) => {
    return searchProjectFiles(rootPath, query)
  })
  ipcMain.handle('desktop:list-agent-context', (_event, rootPath: string) => {
    return discoverAgentContext(rootPath)
  })
  ipcMain.handle('desktop:quit', () => {
    app.quit()
  })
  ipcMain.handle('desktop:show-item-in-folder', (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return
    const resolved = resolveProjectPath(rawPath)
    shell.showItemInFolder(resolved)
  })
  createWindow()
})

async function readProjectFileTree(rootPath: string): Promise<FileTreeResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  try {
    const stat = await fs.stat(resolvedRootPath)
    if (!stat.isDirectory()) {
      return {
        ok: false,
        rootPath: resolvedRootPath,
        message: '当前项目路径不是文件夹',
      }
    }

    let entriesRead = 0
    let truncated = false

    const readDirectory = async (directoryPath: string, relativeBase: string, depth: number): Promise<FileTreeNode[]> => {
      if (depth > FILE_TREE_MAX_DEPTH) {
        truncated = true
        return []
      }

      let entries = await fs.readdir(directoryPath, { withFileTypes: true })
      entries = entries
        .filter((entry) => !shouldIgnoreFileTreeEntry(entry))
        .sort((a, b) => {
          const typeDiff = Number(b.isDirectory()) - Number(a.isDirectory())
          return typeDiff || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        })

      if (entries.length > FILE_TREE_MAX_CHILDREN_PER_DIRECTORY) {
        entries = entries.slice(0, FILE_TREE_MAX_CHILDREN_PER_DIRECTORY)
        truncated = true
      }

      const nodes: FileTreeNode[] = []
      for (const entry of entries) {
        if (entriesRead >= FILE_TREE_MAX_ENTRIES) {
          truncated = true
          break
        }

        const entryPath = path.join(directoryPath, entry.name)
        const relativePath = normalizeRelativePath(path.join(relativeBase, entry.name))
        entriesRead += 1

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: entryPath,
            relativePath,
            type: 'directory',
            children: await readChildDirectory(entryPath, relativePath, depth + 1),
          })
          continue
        }

        if (entry.isFile() || entry.isSymbolicLink()) {
          nodes.push({
            name: entry.name,
            path: entryPath,
            relativePath,
            type: 'file',
          })
        }
      }

      return nodes
    }

    const readChildDirectory = async (directoryPath: string, relativePath: string, depth: number) => {
      try {
        return await readDirectory(directoryPath, relativePath, depth)
      } catch {
        truncated = true
        return []
      }
    }

    return {
      ok: true,
      rootPath: resolvedRootPath,
      rootName: path.basename(resolvedRootPath) || resolvedRootPath,
      nodes: await readDirectory(resolvedRootPath, '', 0),
      truncated,
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      message: error instanceof Error ? error.message : '无法读取文件树',
    }
  }
}

function resolveProjectPath(projectPath: string): string {
  const trimmedPath = projectPath.trim()
  if (trimmedPath === '~') return os.homedir()
  if (trimmedPath.startsWith(`~${path.sep}`) || trimmedPath.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmedPath.slice(2))
  }
  return path.resolve(trimmedPath)
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}

function shouldIgnoreFileTreeEntry(entry: import('node:fs').Dirent): boolean {
  return entry.isDirectory() && FILE_TREE_IGNORED_DIRECTORIES.has(entry.name)
}
