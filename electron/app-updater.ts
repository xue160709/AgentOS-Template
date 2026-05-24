/**
 * GitHub Releases 应用内更新（electron-updater）。
 * In-app updates from GitHub Releases via electron-updater.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdaterState } from '../src/desktop-types'

/** electron-updater 为 CJS，ESM 主进程需走 default 再解构 / CJS package — default import then destructure */
const { autoUpdater } = electronUpdater

export const APP_UPDATER_EVENT_CHANNEL = 'app-updater:event'

const STARTUP_CHECK_DELAY_MS = 8_000
const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

function formatReleaseNotes(notes: unknown): string | undefined {
  if (typeof notes === 'string' && notes.trim()) return notes.trim()
  if (Array.isArray(notes)) {
    const parts = notes
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object' && 'note' in entry && typeof (entry as { note: unknown }).note === 'string') {
          return (entry as { note: string }).note
        }
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n\n')
  }
  return undefined
}

class AppUpdaterService {
  private getWindow: () => BrowserWindow | null = () => null
  private beforeQuitAndInstall: () => void = () => undefined
  private installed = false
  private startupCheckTimer: ReturnType<typeof setTimeout> | null = null
  private updatePollTimer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<AppUpdaterState> | null = null
  private state: AppUpdaterState = {
    phase: 'idle',
    updatesSupported: false,
    currentVersion: app.getVersion(),
  }

  /** 仅在打包环境注册；开发模式为 no-op / Register only when packaged */
  install(getWindow: () => BrowserWindow | null, options?: { beforeQuitAndInstall?: () => void }) {
    this.getWindow = getWindow
    this.beforeQuitAndInstall = options?.beforeQuitAndInstall ?? (() => undefined)
    if (!app.isPackaged) return

    this.installed = true
    this.state.updatesSupported = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.patch({ phase: 'checking', errorMessage: undefined })
    })
    autoUpdater.on('update-available', (info) => {
      this.patch({
        phase: 'available',
        availableVersion: info.version,
        releaseNotes: formatReleaseNotes(info.releaseNotes),
        errorMessage: undefined,
        percent: undefined,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined,
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.patch({
        phase: 'not-available',
        availableVersion: undefined,
        releaseNotes: undefined,
        errorMessage: undefined,
      })
    })
    autoUpdater.on('download-progress', (progress) => {
      this.patch({
        phase: 'downloading',
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.patch({
        phase: 'downloaded',
        availableVersion: info.version,
        releaseNotes: formatReleaseNotes(info.releaseNotes) ?? this.state.releaseNotes,
      })
    })
    autoUpdater.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ phase: 'error', errorMessage: message })
    })
  }

  getState(): AppUpdaterState {
    return {
      ...this.state,
      currentVersion: app.getVersion(),
      updatesSupported: this.installed,
    }
  }

  isEnabled(): boolean {
    return this.installed
  }

  scheduleUpdateChecks() {
    if (!this.installed) return
    if (!this.startupCheckTimer) {
      this.startupCheckTimer = setTimeout(() => {
        this.startupCheckTimer = null
        void this.check()
      }, STARTUP_CHECK_DELAY_MS)
    }
    if (!this.updatePollTimer) {
      this.updatePollTimer = setInterval(() => {
        void this.check()
      }, UPDATE_POLL_INTERVAL_MS)
    }
  }

  async check(): Promise<AppUpdaterState> {
    if (!this.installed) {
      return this.getState()
    }
    if (this.checkPromise) {
      return this.checkPromise
    }
    if (
      this.state.phase === 'checking' ||
      this.state.phase === 'available' ||
      this.state.phase === 'downloading' ||
      this.state.phase === 'downloaded'
    ) {
      return this.getState()
    }
    this.checkPromise = this.runCheck()
    try {
      return await this.checkPromise
    } finally {
      this.checkPromise = null
    }
  }

  private async runCheck(): Promise<AppUpdaterState> {
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ phase: 'error', errorMessage: message })
    }
    return this.getState()
  }

  async download(): Promise<AppUpdaterState> {
    if (!this.installed) {
      return this.getState()
    }
    if (this.state.phase !== 'available' && this.state.phase !== 'error') {
      return this.getState()
    }
    try {
      this.patch({
        phase: 'downloading',
        errorMessage: undefined,
        percent: 0,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined,
      })
      await autoUpdater.downloadUpdate()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ phase: 'error', errorMessage: message })
    }
    return this.getState()
  }

  quitAndInstall(): void {
    if (!this.installed) return
    if (this.state.phase !== 'downloaded') return
    this.beforeQuitAndInstall()
    autoUpdater.quitAndInstall()
  }

  private patch(partial: Partial<AppUpdaterState>) {
    this.state = {
      ...this.state,
      currentVersion: app.getVersion(),
      updatesSupported: this.installed,
      ...partial,
    }
    this.broadcast()
  }

  private broadcast() {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(APP_UPDATER_EVENT_CHANNEL, this.getState())
  }
}

export const appUpdaterService = new AppUpdaterService()

export function registerAppUpdaterIpc(getWindow: () => BrowserWindow | null, options?: { beforeQuitAndInstall?: () => void }) {
  appUpdaterService.install(getWindow, options)

  ipcMain.handle('app-updater:get-state', () => appUpdaterService.getState())
  ipcMain.handle('app-updater:check', () => appUpdaterService.check())
  ipcMain.handle('app-updater:download', () => appUpdaterService.download())
  ipcMain.handle('app-updater:quit-and-install', () => {
    appUpdaterService.quitAndInstall()
  })
}
