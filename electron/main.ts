/**
 * Electron 主进程入口：BrowserWindow、托盘、IPC 与 Claude Agent。
 * Electron main entry: window lifecycle, tray menu, IPC bridges, and Claude Agent runner.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import zh from '../src/locales/zh.json'
import en from '../src/locales/en.json'
import type {
  AgentModeProjectSettings,
  AppUiLocale,
  DesktopPreferences,
  HomePluginRunOptions,
  HomePluginTaskEvent,
} from '../src/desktop-types'
import { ensureAgentModeFiles, getAgentModeStatus, setAgentModeState } from './agent-mode-files'
import { AgentModeSettingsStore } from './agent-mode-settings-store'
import { discoverAgentContext, searchProjectFiles } from './agent-context'
import { ClaudeAgentRunner } from './claude-agent-runner'
import { ClaudeAgentSettingsStore } from './claude-agent-settings'
import { ChatWorkspaceStore } from './chat-workspace-store'
import { DesktopPreferencesStore } from './desktop-preferences-store'
import { loadMainProcessEnv } from './env-loader'
import { runProjectHomePlugin, saveProjectHomePluginLayout, saveProjectHomePluginOrder } from './home-plugin-runner'
import { installSafeStdStreamHandlers } from './safe-console'
import { TaskHomePluginManager } from './task-home-plugin-manager'
import { normalizeUiLocale } from './ui-locale'
import { appUpdaterService, registerAppUpdaterIpc } from './app-updater'
import { installApplicationMenu } from './app-menu'
import { formatProjectPathError, resolveProjectPath, validateProjectPaths } from './project-path'
import { getMainWindowBackgroundColor, getMainWindowChromeOptions } from './window-chrome'
import type {
  ActiveChatPickPayload,
  ClaudeChatAttachment,
  ClaudeChatAttachmentPickerResult,
  ClaudeAgentSettings,
  ClaudeChatSubmitPayload,
  ClaudeFileRewindPayload,
  ClaudePermissionResponsePayload,
} from '../src/claude-chat-types'
import type { FileTreeNode, FileTreeResult, ProjectFilePreviewKind, ProjectFilePreviewResult } from '../src/components/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录示意 / Built output layout (for orientation when reading paths)
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
installSafeStdStreamHandlers()

// 🚧 使用 process.env['KEY'] 避免被 vite:define 内联；见 Vite 2.x 插件行为 /
// 🚧 Use bracket notation so vite:define does not replace env keys (Vite@2.x plugin behavior).
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

const APP_NAME = 'AgentOS'
const TRAY_ACTION_CHANNEL = 'desktop:tray-action'
const TASK_HOME_PLUGIN_EVENT_CHANNEL = 'desktop:task-home-plugin-event'

const TRAY_LOCALE_BUNDLE = { zh, en } as const
type TrayLocale = keyof typeof TRAY_LOCALE_BUNDLE
type ProjectFilePreviewTextKind = Exclude<ProjectFilePreviewKind, 'image'>

let win: BrowserWindow | null
let tray: Tray | null = null
let isQuitting = false
let currentTrayLocale: TrayLocale = 'zh'
let claudeAgentRunner: ClaudeAgentRunner | null = null
let claudeAgentSettingsStore: ClaudeAgentSettingsStore | null = null
let agentModeSettingsStore: AgentModeSettingsStore | null = null
let chatWorkspaceStore: ChatWorkspaceStore | null = null
let desktopPreferencesStore: DesktopPreferencesStore | null = null
let taskHomePluginManager: TaskHomePluginManager | null = null
let chatWorkspaceOperationChain: Promise<void> = Promise.resolve()
let claudeSettingsOperationChain: Promise<void> = Promise.resolve()

const gotSingleInstanceLock = app.requestSingleInstanceLock()

/** 与 VITE 开发服务器一致：打包产物无开发菜单 / Matches Vite dev server; packaged builds omit dev menu */
const isDevRuntime = Boolean(VITE_DEV_SERVER_URL) || !app.isPackaged

app.setName(APP_NAME)

const CHAT_ATTACHMENT_MAX_FILES = 8
const CHAT_TEXT_ATTACHMENT_MAX_BYTES = 512 * 1024
const PROJECT_FILE_PREVIEW_TEXT_MAX_BYTES = 5 * 1024 * 1024
const PROJECT_FILE_PREVIEW_TEXT_SAMPLE_BYTES = 8192
const CLIPBOARD_PNG_MAX_DATA_URL_LENGTH = 25_000_000
const CLIPBOARD_SVG_MAX_CHARS = 4_000_000
const CLIPBOARD_SVG_MAX_DIMENSION = 4096
const CHAT_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const CHAT_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const PROJECT_FILE_PREVIEW_TEXT_EXTENSIONS = new Set([
  '.astro',
  '.bat',
  '.bash',
  '.c',
  '.cc',
  '.cjs',
  '.cfg',
  '.cmd',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.cts',
  '.csv',
  '.cxx',
  '.dart',
  '.diff',
  '.dockerfile',
  '.env',
  '.fish',
  '.go',
  '.gql',
  '.graphql',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.json5',
  '.jsonc',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.log',
  '.lua',
  '.md',
  '.markdown',
  '.mdx',
  '.mjs',
  '.mts',
  '.php',
  '.pl',
  '.properties',
  '.ps1',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
])
const PROJECT_FILE_PREVIEW_TEXT_FILENAMES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.env',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  '.prettierrc',
  '.stylelintrc',
  '.yarnrc',
  'brewfile',
  'changelog',
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'procfile',
  'rakefile',
  'readme',
  'vagrantfile',
])
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
  return getMainWindowBackgroundColor(nativeTheme.shouldUseDarkColors)
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
  const windowBackgroundColor = getWindowBackgroundColor()

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: isMac ? '#00000000' : windowBackgroundColor,
    icon: getAppIconPath(),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      devTools: isDevRuntime,
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
    ...getMainWindowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors),
  })

  claudeAgentRunner = new ClaudeAgentRunner(
    win.webContents,
    process.env.APP_ROOT,
    () => getClaudeAgentSettingsStore().resolve(),
    (rootPath) => getAgentModeSettingsStore().resolve(rootPath),
    () => normalizeUiLocale(getDesktopPreferencesStore().read().locale),
    (event) => taskHomePluginManager?.handleClaudeEvent(event),
  )

  taskHomePluginManager = new TaskHomePluginManager({
    getRunner: () => claudeAgentRunner,
    getWorkspace: () => chatWorkspaceStore?.read() ?? null,
    emitTaskEvent: sendTaskHomePluginEvent,
  })
  void taskHomePluginManager.refreshFromWorkspace()

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
    taskHomePluginManager = null
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // 生产环境从磁盘加载打包后的 index.html（非直连 dist 根路径）/
    // Production: load packaged `index.html` from disk (not the dev-server URL).
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

function getTaskHomePluginManager() {
  if (!taskHomePluginManager) {
    throw new Error('Task home plugin manager is not ready.')
  }
  return taskHomePluginManager
}

function runChatWorkspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = chatWorkspaceOperationChain.then(operation, operation)
  chatWorkspaceOperationChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function runClaudeSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = claudeSettingsOperationChain.then(operation, operation)
  claudeSettingsOperationChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function clearChatWorkspaceData(userDataPath: string): Promise<void> {
  try {
    await claudeAgentRunner?.cancel()
  } catch {
    /* ignore */
  }

  await removeWorkspaceArtifacts(userDataPath)
  await taskHomePluginManager?.refreshFromWorkspace()
}

async function clearClaudeAgentSettingsData(userDataPath: string): Promise<void> {
  await removeIfExists(path.join(userDataPath, 'claude-agent-settings.json'))
}

async function removeWorkspaceArtifacts(userDataPath: string): Promise<void> {
  await Promise.all([
    removeIfExists(path.join(userDataPath, 'chat-workspace.json')),
    removeIfExists(path.join(userDataPath, 'chat-workspace.sqlite')),
    removeIfExists(path.join(userDataPath, 'chat-workspace.sqlite-wal')),
    removeIfExists(path.join(userDataPath, 'chat-workspace.sqlite-shm')),
    removeIfExists(path.join(userDataPath, 'chat-workspace.sqlite-journal')),
    removeIfExists(path.join(userDataPath, 'chat-sessions')),
  ])
}

async function removeIfExists(targetPath: string): Promise<void> {
  try {
    await fs.rm(targetPath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function sendTaskHomePluginEvent(event: HomePluginTaskEvent): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(TASK_HOME_PLUGIN_EVENT_CHANNEL, event)
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
    installApplicationMenu({ isDev: isDevRuntime })
    applyDockBranding()
    const userDataPath = app.getPath('userData')
    desktopPreferencesStore = new DesktopPreferencesStore(userDataPath)
    claudeAgentSettingsStore = new ClaudeAgentSettingsStore(userDataPath, {
      allowEnvConfigSource: isDevRuntime,
    })
    agentModeSettingsStore = new AgentModeSettingsStore(userDataPath)
    chatWorkspaceStore = new ChatWorkspaceStore(userDataPath)
    applyLoginItemSettingsOnStartup(getDesktopPreferencesStore().read())
    currentTrayLocale = normalizeUiLocale(getDesktopPreferencesStore().read().locale)

    // --- IPC handlers / IPC 注册 ---

    registerAppUpdaterIpc(() => win)

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
    ipcMain.handle('desktop:copy-png-to-clipboard', (_event, dataUrl: unknown) => {
      if (
        typeof dataUrl !== 'string' ||
        !/^data:image\/png;base64,/i.test(dataUrl) ||
        dataUrl.length > CLIPBOARD_PNG_MAX_DATA_URL_LENGTH
      ) {
        return false
      }
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return false
      clipboard.writeImage(image)
      return true
    })
    ipcMain.handle('desktop:copy-svg-to-clipboard', async (_event, svg: unknown) => {
      if (typeof svg !== 'string' || !svg.trim().startsWith('<svg') || svg.length > CLIPBOARD_SVG_MAX_CHARS) {
        return false
      }
      return copySvgToClipboard(svg)
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
      return runClaudeSettingsOperation(async () => getClaudeAgentSettingsStore().save(settings))
    })
    ipcMain.handle('claude-agent-settings:set-active-chat-pick', (_event, payload: ActiveChatPickPayload) => {
      return runClaudeSettingsOperation(async () => getClaudeAgentSettingsStore().setActiveChatPick(payload))
    })
    ipcMain.handle('chat-workspace:get', () => {
      return getChatWorkspaceStore().read()
    })
    ipcMain.handle('chat-workspace:save', (_event, state: unknown) => {
      return runChatWorkspaceOperation(async () => {
        const saved = await getChatWorkspaceStore().save(state)
        void taskHomePluginManager?.refreshFromWorkspace(saved)
        return saved
      })
    })
    ipcMain.handle('desktop:clear-chat-workspace-data', () => {
      return runChatWorkspaceOperation(async () => {
        await clearChatWorkspaceData(userDataPath)
      })
    })
    ipcMain.handle('desktop:clear-claude-agent-settings-data', () => {
      return runClaudeSettingsOperation(async () => {
        await clearClaudeAgentSettingsData(userDataPath)
      })
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
    ipcMain.handle('desktop:read-project-file', (_event, rootPath: unknown, filePath: unknown) => {
      if (typeof rootPath !== 'string' || typeof filePath !== 'string') {
        return {
          ok: false,
          rootPath: '',
          path: '',
          message: '文件路径无效',
        } satisfies ProjectFilePreviewResult
      }
      return readProjectFilePreview(rootPath, filePath)
    })
    ipcMain.handle('desktop:validate-project-paths', async (_event, paths: unknown) => {
      if (!Array.isArray(paths)) return {}
      return validateProjectPaths(paths.filter((path): path is string => typeof path === 'string'))
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
    ipcMain.handle('desktop:save-home-plugin-order', (_event, rootPath: string, order: unknown) => {
      return saveProjectHomePluginOrder(rootPath, order)
    })
    ipcMain.handle('desktop:save-home-plugin-layout', (_event, rootPath: string, order: unknown, cards: unknown) => {
      return saveProjectHomePluginLayout(rootPath, order, cards)
    })
    ipcMain.handle('desktop:save-task-home-plugin', (_event, rootPath: string, payload: unknown) => {
      return getTaskHomePluginManager().saveTask(rootPath, payload as Parameters<TaskHomePluginManager['saveTask']>[1])
    })
    ipcMain.handle('desktop:get-task-home-plugin', (_event, rootPath: string, slug: string) => {
      return getTaskHomePluginManager().readTask(rootPath, slug)
    })
    ipcMain.handle('desktop:run-task-home-plugin', (_event, rootPath: string, slug: string) => {
      return getTaskHomePluginManager().startTask(rootPath, slug)
    })
    ipcMain.handle('desktop:stop-task-home-plugin', (_event, rootPath: string, slug: string) => {
      return getTaskHomePluginManager().stopTask(rootPath, slug)
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
    appUpdaterService.scheduleStartupCheck()
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

async function copySvgToClipboard(svg: string): Promise<boolean> {
  const size = readSvgClipboardSize(svg)
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  const renderWindow = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    useContentSize: true,
    frame: false,
    resizable: false,
    backgroundColor: '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  try {
    await renderWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildSvgClipboardHtml(svgDataUrl, size.width, size.height))}`,
    )
    const ready = await waitForSvgClipboardRender(renderWindow)
    if (!ready) return false

    await delay(80)
    const image = await renderWindow.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height })
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  } catch {
    return false
  } finally {
    if (!renderWindow.isDestroyed()) renderWindow.destroy()
  }
}

function buildSvgClipboardHtml(svgDataUrl: string, width: number, height: number): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden;background:#fff;}
img{display:block;width:${width}px;height:${height}px;object-fit:contain;background:#fff;}
</style>
</head>
<body>
<img id="svg-source" src="${svgDataUrl}" alt="">
<script>
const img = document.getElementById('svg-source');
window.__svgClipboardReady = img.complete && img.naturalWidth > 0;
window.__svgClipboardFailed = false;
img.onload = () => { window.__svgClipboardReady = true; };
img.onerror = () => { window.__svgClipboardFailed = true; };
</script>
</body>
</html>`
}

async function waitForSvgClipboardRender(renderWindow: BrowserWindow): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2500) {
    const status = (await renderWindow.webContents.executeJavaScript(
      `({
        ready: Boolean(window.__svgClipboardReady),
        failed: Boolean(window.__svgClipboardFailed),
        naturalWidth: document.getElementById('svg-source')?.naturalWidth || 0
      })`,
      true,
    )) as { ready?: boolean; failed?: boolean; naturalWidth?: number }
    if (status.ready && (status.naturalWidth ?? 0) > 0) return true
    if (status.failed) return false
    await delay(50)
  }
  return false
}

function readSvgClipboardSize(svg: string): { width: number; height: number } {
  const svgTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const width = parseSvgClipboardDimension(readSvgAttribute(svgTag, 'width'))
  const height = parseSvgClipboardDimension(readSvgAttribute(svgTag, 'height'))
  const viewBox = readSvgAttribute(svgTag, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)

  return {
    width: clampSvgClipboardDimension(width || (Number.isFinite(viewBox?.[2]) ? viewBox?.[2] : 920)),
    height: clampSvgClipboardDimension(height || (Number.isFinite(viewBox?.[3]) ? viewBox?.[3] : 320)),
  }
}

function readSvgAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

function parseSvgClipboardDimension(value: string): number {
  const trimmed = value.trim()
  if (!trimmed || trimmed.endsWith('%')) return 0
  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function clampSvgClipboardDimension(value: number | undefined): number {
  const normalized = Number.isFinite(value) && value && value > 0 ? value : 1
  return Math.min(Math.max(1, Math.ceil(normalized)), CLIPBOARD_SVG_MAX_DIMENSION)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

    const readDirectory = async (directoryPath: string, relativeBase: string): Promise<FileTreeNode[]> => {
      let entries = await fs.readdir(directoryPath, { withFileTypes: true })
      entries = entries
        .filter((entry) => !shouldIgnoreFileTreeEntry(entry))
        .sort((a, b) => {
          const typeDiff = Number(b.isDirectory()) - Number(a.isDirectory())
          return typeDiff || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        })

      const nodes: FileTreeNode[] = []
      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name)
        const relativePath = normalizeRelativePath(path.join(relativeBase, entry.name))

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: entryPath,
            relativePath,
            type: 'directory',
            children: await readChildDirectory(entryPath, relativePath),
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

    const readChildDirectory = async (directoryPath: string, relativePath: string) => {
      try {
        return await readDirectory(directoryPath, relativePath)
      } catch {
        return []
      }
    }

    return {
      ok: true,
      rootPath: resolvedRootPath,
      rootName: path.basename(resolvedRootPath) || resolvedRootPath,
      nodes: await readDirectory(resolvedRootPath, ''),
      truncated: false,
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      message: formatProjectPathError(error),
    }
  }
}

async function readProjectFilePreview(rootPath: string, filePath: string): Promise<ProjectFilePreviewResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  const trimmedFilePath = filePath.trim()
  const requestedPath = path.isAbsolute(trimmedFilePath)
    ? path.resolve(trimmedFilePath)
    : path.resolve(resolvedRootPath, trimmedFilePath)
  const relativePath = normalizeRelativePath(path.relative(resolvedRootPath, requestedPath))
  const name = path.basename(requestedPath)

  const fail = (message: string): ProjectFilePreviewResult => ({
    ok: false,
    rootPath: resolvedRootPath,
    path: requestedPath,
    relativePath,
    name,
    message,
  })

  try {
    const rootStat = await fs.stat(resolvedRootPath)
    if (!rootStat.isDirectory()) return fail('当前项目路径不是文件夹')

    const rootRealPath = await fs.realpath(resolvedRootPath)
    const targetRealPath = await fs.realpath(requestedPath)
    const realRelativePath = path.relative(rootRealPath, targetRealPath)
    if (realRelativePath === '..' || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) {
      return fail('只能预览当前项目内的文件')
    }

    const stat = await fs.stat(targetRealPath)
    if (!stat.isFile()) return fail('只能预览文件')

    const extension = path.extname(name).toLowerCase()
    const imageMimeType = CHAT_IMAGE_MEDIA_TYPES.get(extension)
    const textKind = await getProjectFilePreviewTextKind(targetRealPath, name, stat.size)

    if (!textKind && !imageMimeType) {
      return fail('仅支持预览纯文本文件或 PNG、JPG、GIF、WEBP 图片')
    }

    if (textKind) {
      if (stat.size > PROJECT_FILE_PREVIEW_TEXT_MAX_BYTES) {
        return fail('文本文件超过 5MB，暂不在应用内预览')
      }
      const content = await fs.readFile(targetRealPath, 'utf8')
      return {
        ok: true,
        rootPath: resolvedRootPath,
        path: requestedPath,
        relativePath,
        name,
        kind: textKind,
        mimeType: getProjectFilePreviewTextMimeType(textKind),
        size: stat.size,
        content,
      }
    }

    if (!imageMimeType) return fail('仅支持预览纯文本文件或 PNG、JPG、GIF、WEBP 图片')
    if (stat.size > CHAT_IMAGE_ATTACHMENT_MAX_BYTES) {
      return fail('图片超过 10MB，暂不在应用内预览')
    }
    const data = await fs.readFile(targetRealPath)
    return {
      ok: true,
      rootPath: resolvedRootPath,
      path: requestedPath,
      relativePath,
      name,
      kind: 'image',
      mimeType: imageMimeType,
      size: stat.size,
      dataUrl: `data:${imageMimeType};base64,${data.toString('base64')}`,
    }
  } catch (error) {
    return fail(formatProjectPathError(error))
  }
}

async function getProjectFilePreviewTextKind(filePath: string, name: string, size: number): Promise<ProjectFilePreviewTextKind | null> {
  const lowerName = name.toLowerCase()
  const extension = path.extname(lowerName)
  if (extension === '.md' || extension === '.markdown' || extension === '.mdx') return 'markdown'
  if (extension === '.json' || extension === '.jsonc' || extension === '.json5') return 'json'
  if (
    PROJECT_FILE_PREVIEW_TEXT_EXTENSIONS.has(extension) ||
    PROJECT_FILE_PREVIEW_TEXT_FILENAMES.has(lowerName) ||
    lowerName.startsWith('.env.') ||
    lowerName.endsWith('rc') ||
    lowerName.endsWith('.lock')
  ) {
    return 'text'
  }
  return (await isProbablyTextFile(filePath, size)) ? 'text' : null
}

function getProjectFilePreviewTextMimeType(kind: ProjectFilePreviewTextKind): string {
  if (kind === 'markdown') return 'text/markdown'
  if (kind === 'json') return 'application/json'
  return 'text/plain'
}

async function isProbablyTextFile(filePath: string, size: number): Promise<boolean> {
  const sampleSize = Math.min(Math.max(size, 0), PROJECT_FILE_PREVIEW_TEXT_SAMPLE_BYTES)
  if (sampleSize === 0) return true

  const handle = await fs.open(filePath, 'r')
  try {
    const sample = Buffer.alloc(sampleSize)
    const { bytesRead } = await handle.read(sample, 0, sampleSize, 0)
    return isProbablyTextBuffer(sample.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  let suspiciousBytes = 0
  for (const byte of buffer) {
    if (byte === 0) return false
    const isAllowedControl = byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13
    if ((byte < 32 && !isAllowedControl) || byte === 127) suspiciousBytes += 1
  }
  return suspiciousBytes / buffer.length < 0.01
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
