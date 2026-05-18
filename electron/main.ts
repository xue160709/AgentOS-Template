import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zh from '../src/locales/zh.json'
import en from '../src/locales/en.json'
import type { AgentModeProjectSettings, AppUiLocale, DesktopPreferences, HomePluginRunOptions } from '../src/desktop-types'
import { ensureAgentModeFiles, getAgentModeStatus, setAgentModeState } from './agent-mode-files'
import { AgentModeSettingsStore } from './agent-mode-settings-store'
import { discoverAgentContext, searchProjectFiles } from './agent-context'
import { ClaudeAgentRunner } from './claude-agent-runner'
import { ClaudeAgentSettingsStore } from './claude-agent-settings'
import { ChatWorkspaceStore } from './chat-workspace-store'
import { DesktopPreferencesStore } from './desktop-preferences-store'
import { loadMainProcessEnv } from './env-loader'
import { runProjectHomePlugin } from './home-plugin-runner'
import { normalizeUiLocale } from './ui-locale'
import type {
  ActiveChatPickPayload,
  ClaudeChatAttachment,
  ClaudeChatAttachmentPickerResult,
  ClaudeAgentSettings,
  ClaudeChatSubmitPayload,
  ClaudeFileRewindPayload,
  ClaudePermissionResponsePayload,
} from '../src/claude-chat-types'
import type { FileTreeNode, FileTreeResult } from '../src/components/types'

/**
 * Electron 主进程入口：BrowserWindow、托盘、IPC 与 Claude Agent。
 * Electron main entry: window lifecycle, tray menu, IPC bridges, and Claude Agent runner.
 */

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

const APP_NAME = 'AgentOS'
const TRAY_ACTION_CHANNEL = 'desktop:tray-action'

const TRAY_LOCALE_BUNDLE = { zh, en } as const
type TrayLocale = keyof typeof TRAY_LOCALE_BUNDLE

let win: BrowserWindow | null
let tray: Tray | null = null
let isQuitting = false
let currentTrayLocale: TrayLocale = 'zh'
let claudeAgentRunner: ClaudeAgentRunner | null = null
let claudeAgentSettingsStore: ClaudeAgentSettingsStore | null = null
let agentModeSettingsStore: AgentModeSettingsStore | null = null
let chatWorkspaceStore: ChatWorkspaceStore | null = null
let desktopPreferencesStore: DesktopPreferencesStore | null = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()

app.setName(APP_NAME)

const FILE_TREE_MAX_DEPTH = 8
const FILE_TREE_MAX_ENTRIES = 1200
const FILE_TREE_MAX_CHILDREN_PER_DIRECTORY = 200
const CHAT_ATTACHMENT_MAX_FILES = 8
const CHAT_TEXT_ATTACHMENT_MAX_BYTES = 512 * 1024
const CHAT_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const CHAT_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const CHAT_IMAGE_MEDIA_TYPES = new Map<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])
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

// --- Window, tray & branding / 窗口、托盘与 Dock ---

function getWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#181818' : '#f9f9f9'
}

function getAppIconPath() {
  return path.join(process.env.VITE_PUBLIC, 'app-icon.png')
}

function applyDockBranding() {
  app.setName(APP_NAME)
  if (process.platform !== 'darwin' || !app.dock) return
  const dockImage = nativeImage.createFromPath(getAppIconPath())
  if (!dockImage.isEmpty()) {
    app.dock.setIcon(dockImage)
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: isMac ? '#00000000' : getWindowBackgroundColor(),
    icon: getAppIconPath(),
    title: APP_NAME,
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

  claudeAgentRunner = new ClaudeAgentRunner(
    win.webContents,
    process.env.APP_ROOT,
    () => getClaudeAgentSettingsStore().resolve(),
    (rootPath) => getAgentModeSettingsStore().resolve(rootPath),
    () => normalizeUiLocale(getDesktopPreferencesStore().read().locale),
  )

  win.on('close', (event) => {
    if (isQuitting) return
    const prefs = desktopPreferencesStore?.read() ?? { closeToTray: false, openAtLogin: false, locale: 'zh' }
    if (prefs.closeToTray) {
      event.preventDefault()
      win?.hide()
    }
  })

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

function getAgentModeSettingsStore() {
  if (!agentModeSettingsStore) {
    throw new Error('Agent Mode settings store is not ready.')
  }
  return agentModeSettingsStore
}

function getChatWorkspaceStore() {
  if (!chatWorkspaceStore) {
    throw new Error('Chat workspace store is not ready.')
  }
  return chatWorkspaceStore
}

function getDesktopPreferencesStore() {
  if (!desktopPreferencesStore) {
    throw new Error('Desktop preferences store is not ready.')
  }
  return desktopPreferencesStore
}

function resolveAgentModeIpcLocale(raw: unknown): AppUiLocale {
  if (raw === 'zh' || raw === 'en') return raw
  return normalizeUiLocale(getDesktopPreferencesStore().read().locale)
}

function trayMenuLabel(locale: TrayLocale, key: 'newThread' | 'openProject' | 'quit'): string {
  const tray = TRAY_LOCALE_BUNDLE[locale].tray as Record<string, string> | undefined
  const value = tray?.[key]
  return typeof value === 'string' ? value : key
}

function getTrayImage() {
  const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray-icon.png'
  const iconPath = path.join(process.env.VITE_PUBLIC, iconName)
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(process.env.APP_ROOT ?? '', 'public', iconName))
  }
  if (!image.isEmpty() && process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  /** macOS：托盘图为空时用系统模板图兜底，避免菜单栏“看不见”。 */
  if (image.isEmpty() && process.platform === 'darwin') {
    try {
      image = nativeImage.createFromNamedImage('NSImageNameBookmarksTemplate', [18, 18])
      image.setTemplateImage(true)
    } catch {
      /* ignore */
    }
  }
  /** 其它平台仍为空时用 16×16 纯色 PNG，避免 `new Tray` 无图标 */
  if (image.isEmpty()) {
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYCMg/BOMrgMERYA5KquhnSuCqmRBwBZ9A/TsQ5TAAAAAElFTkSuQmCC',
    )
  }
  return image
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function buildTrayContextMenu() {
  const locale = currentTrayLocale
  return Menu.buildFromTemplate([
    {
      label: trayMenuLabel(locale, 'newThread'),
      click: () => {
        if (win && !win.isDestroyed()) {
          win.show()
          win.focus()
          win.webContents.send(TRAY_ACTION_CHANNEL, 'new-thread')
        }
      },
    },
    {
      label: trayMenuLabel(locale, 'openProject'),
      click: () => {
        if (win && !win.isDestroyed()) {
          win.show()
          win.focus()
          win.webContents.send(TRAY_ACTION_CHANNEL, 'open-project')
        }
      },
    },
    { type: 'separator' },
    {
      label: trayMenuLabel(locale, 'quit'),
      click: () => {
        app.quit()
      },
    },
  ])
}

function ensureTray() {
  if (!win || win.isDestroyed()) return
  if (!tray) {
    tray = new Tray(getTrayImage())
    const name = app.getName()
    tray.setToolTip(name)
    tray.on('click', () => {
      showMainWindow()
    })
    tray.on('right-click', () => {
      tray?.popUpContextMenu(buildTrayContextMenu())
    })
  }
}

function applyLoginItemSettingsFromPrefs(prefs: DesktopPreferences) {
  app.setLoginItemSettings({
    openAtLogin: prefs.openAtLogin,
    path: process.execPath,
  })
}

function applyLoginItemSettingsOnStartup(prefs: DesktopPreferences) {
  if (!prefs.openAtLogin) return
  applyLoginItemSettingsFromPrefs(prefs)
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.on('window-all-closed', () => {
    const prefs = desktopPreferencesStore?.read() ?? { closeToTray: false, openAtLogin: false, locale: 'zh' }
    if (prefs.closeToTray) return
    app.quit()
    win = null
  })

  app.on('activate', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      ensureTray()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    tray?.destroy()
    tray = null
  })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system'
    applyDockBranding()
    const userDataPath = app.getPath('userData')
    desktopPreferencesStore = new DesktopPreferencesStore(userDataPath)
    claudeAgentSettingsStore = new ClaudeAgentSettingsStore(userDataPath)
    agentModeSettingsStore = new AgentModeSettingsStore(userDataPath)
    chatWorkspaceStore = new ChatWorkspaceStore(userDataPath)
    applyLoginItemSettingsOnStartup(getDesktopPreferencesStore().read())
    currentTrayLocale = normalizeUiLocale(getDesktopPreferencesStore().read().locale)

    // --- IPC handlers / IPC 注册 ---

    ipcMain.handle('desktop-preferences:get', () => {
      return getDesktopPreferencesStore().read()
    })
    ipcMain.handle('desktop-preferences:set', (_event, partial: Partial<DesktopPreferences>) => {
      const next = getDesktopPreferencesStore().save(partial)
      if (Object.prototype.hasOwnProperty.call(partial, 'openAtLogin')) {
        applyLoginItemSettingsFromPrefs(next)
      }
      ensureTray()
      return next
    })
    ipcMain.handle('desktop:sync-tray-locale', (_event, raw: unknown) => {
      if (raw === 'zh' || raw === 'en') {
        currentTrayLocale = raw
        ensureTray()
      }
    })
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
    ipcMain.handle('claude-chat:rewind-files', (_event, payload: ClaudeFileRewindPayload) => {
      return getClaudeAgentRunner().rewindFiles(payload)
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
    ipcMain.handle('desktop:pick-chat-attachments', async (_event, rawOptions: unknown) => {
      const parent = BrowserWindow.getFocusedWindow() ?? win
      if (!parent) {
        return { ok: false, message: '当前窗口不可用' } satisfies ClaudeChatAttachmentPickerResult
      }
      const allowImages = isRecord(rawOptions) ? rawOptions.allowImages === true : false
      const extensions = allowImages ? ['md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp'] : ['md', 'markdown', 'txt']
      const result = await dialog.showOpenDialog(parent, {
        properties: ['openFile', 'multiSelections'],
        title: allowImages ? '添加 Markdown、文本或图片' : '添加 Markdown 或文本',
        filters: [
          {
            name: allowImages ? 'Markdown, Text, Images' : 'Markdown, Text',
            extensions,
          },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: true, attachments: [], skipped: [] } satisfies ClaudeChatAttachmentPickerResult
      }
      return readChatAttachments(result.filePaths, allowImages)
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
    ipcMain.handle('desktop:path-exists-under-project', async (_event, rootPath: unknown, relativePath: unknown) => {
      if (typeof rootPath !== 'string' || typeof relativePath !== 'string') return false
      return pathExistsUnderProject(rootPath, relativePath)
    })
    ipcMain.handle('desktop:run-home-plugin', (_event, rootPath: string, options?: HomePluginRunOptions) => {
      return runProjectHomePlugin(rootPath, options)
    })
    ipcMain.handle('desktop:get-agent-mode-status', (_event, rootPath: string, rawLocale?: unknown) => {
      return getAgentModeStatus(rootPath, getAgentModeSettingsStore(), resolveAgentModeIpcLocale(rawLocale))
    })
    ipcMain.handle('desktop:ensure-agent-mode-files', (_event, rootPath: string, rawLocale?: unknown) => {
      return ensureAgentModeFiles(rootPath, getAgentModeSettingsStore(), resolveAgentModeIpcLocale(rawLocale))
    })
    ipcMain.handle(
      'desktop:set-agent-mode-state',
      (_event, rootPath: string, partial: Partial<AgentModeProjectSettings>, rawLocale?: unknown) => {
        return setAgentModeState(rootPath, partial, getAgentModeSettingsStore(), resolveAgentModeIpcLocale(rawLocale))
      },
    )
    ipcMain.handle('desktop:get-agent-mode-settings', (_event, rootPath: string) => {
      return getAgentModeSettingsStore().getResult(rootPath)
    })
    ipcMain.handle('desktop:save-agent-mode-settings', (_event, rootPath: string, payload: { user: string; identity: string }) => {
      return getAgentModeSettingsStore().saveText(rootPath, payload)
    })
    ipcMain.handle('desktop:quit', () => {
      app.quit()
    })
    ipcMain.handle('desktop:show-item-in-folder', (_event, rawPath: unknown) => {
      if (typeof rawPath !== 'string' || !rawPath.trim()) return
      const resolved = resolveProjectPath(rawPath)
      shell.showItemInFolder(resolved)
    })
    ipcMain.handle('desktop:open-path', async (_event, rawPath: unknown) => {
      if (typeof rawPath !== 'string' || !rawPath.trim()) return
      const resolved = resolveProjectPath(rawPath)
      const message = await shell.openPath(resolved)
      if (message) throw new Error(message)
    })
    createWindow()
    ensureTray()
  })
} else {
  app.quit()
}

// --- Attachment ingest & file tree / 附件读取与文件树 ---

async function readChatAttachments(filePaths: string[], allowImages: boolean): Promise<ClaudeChatAttachmentPickerResult> {
  const attachments: ClaudeChatAttachment[] = []
  const skipped: Array<{ name: string; path: string; reason: string }> = []
  const selected = filePaths.slice(0, CHAT_ATTACHMENT_MAX_FILES)

  if (filePaths.length > CHAT_ATTACHMENT_MAX_FILES) {
    for (const filePath of filePaths.slice(CHAT_ATTACHMENT_MAX_FILES)) {
      skipped.push({
        name: path.basename(filePath),
        path: filePath,
        reason: `一次最多添加 ${CHAT_ATTACHMENT_MAX_FILES} 个文件`,
      })
    }
  }

  for (const filePath of selected) {
    const resolvedPath = path.resolve(filePath)
    const name = path.basename(resolvedPath)
    const extension = path.extname(name).toLowerCase()
    const imageMimeType = CHAT_IMAGE_MEDIA_TYPES.get(extension)
    const isTextAttachment = CHAT_TEXT_EXTENSIONS.has(extension)

    if (!isTextAttachment && !imageMimeType) {
      skipped.push({ name, path: resolvedPath, reason: '仅支持 MD、TXT、PNG、JPG、GIF、WEBP' })
      continue
    }

    if (imageMimeType && !allowImages) {
      skipped.push({ name, path: resolvedPath, reason: '当前模型未开启图片输入' })
      continue
    }

    try {
      const stat = await fs.stat(resolvedPath)
      if (!stat.isFile()) {
        skipped.push({ name, path: resolvedPath, reason: '只能添加文件' })
        continue
      }

      if (isTextAttachment) {
        if (stat.size > CHAT_TEXT_ATTACHMENT_MAX_BYTES) {
          skipped.push({ name, path: resolvedPath, reason: '文本文件超过 512KB' })
          continue
        }
        const text = await fs.readFile(resolvedPath, 'utf8')
        attachments.push({
          id: createAttachmentId(attachments.length),
          kind: 'text',
          name,
          path: resolvedPath,
          mimeType: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain',
          size: stat.size,
          text,
          preview: firstPreviewLine(text),
        })
        continue
      }

      if (imageMimeType) {
        if (stat.size > CHAT_IMAGE_ATTACHMENT_MAX_BYTES) {
          skipped.push({ name, path: resolvedPath, reason: '图片超过 10MB' })
          continue
        }
        const data = await fs.readFile(resolvedPath)
        const base64 = data.toString('base64')
        const image = nativeImage.createFromBuffer(data)
        const imageSize = image.isEmpty() ? undefined : image.getSize()
        const dimensions =
          imageSize && imageSize.width > 0 && imageSize.height > 0 ? `${imageSize.width} x ${imageSize.height}` : ''
        attachments.push({
          id: createAttachmentId(attachments.length),
          kind: 'image',
          name,
          path: resolvedPath,
          mimeType: imageMimeType,
          size: stat.size,
          base64,
          dataUrl: `data:${imageMimeType};base64,${base64}`,
          preview: dimensions,
        })
      }
    } catch (error) {
      skipped.push({
        name,
        path: resolvedPath,
        reason: error instanceof Error ? error.message : '读取失败',
      })
    }
  }

  return { ok: true, attachments, skipped }
}

function createAttachmentId(index: number): string {
  return `attachment-${Date.now()}-${index}`
}

function firstPreviewLine(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim()
  const firstLine = normalized.split('\n').find((line) => line.trim())?.trim() ?? ''
  if (!firstLine) return ''
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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

async function pathExistsUnderProject(rootPath: string, relativePath: string): Promise<boolean> {
  const resolvedRoot = resolveProjectPath(rootPath)
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) return false
  const resolvedTarget = path.resolve(resolvedRoot, ...normalized.split('/'))
  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  try {
    await fs.access(resolvedTarget)
    return true
  } catch {
    return false
  }
}

function shouldIgnoreFileTreeEntry(entry: import('node:fs').Dirent): boolean {
  return entry.isDirectory() && FILE_TREE_IGNORED_DIRECTORIES.has(entry.name)
}
