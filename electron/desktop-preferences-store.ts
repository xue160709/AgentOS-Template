import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DesktopPreferences } from '../src/desktop-types'
import { normalizeUiLocale } from './ui-locale'

const PREFS_FILE_NAME = 'desktop-preferences.json'

const DEFAULT_PREFS: DesktopPreferences = {
  closeToTray: false,
  openAtLogin: false,
  locale: 'zh',
}

function normalizePrefs(raw: unknown): DesktopPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
  const o = raw as Record<string, unknown>
  return {
    closeToTray: o.closeToTray === true,
    openAtLogin: o.openAtLogin === true,
    locale: normalizeUiLocale(o.locale),
  }
}

export class DesktopPreferencesStore {
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, PREFS_FILE_NAME)
  }

  read(): DesktopPreferences {
    if (!existsSync(this.filePath)) return { ...DEFAULT_PREFS }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return normalizePrefs(raw)
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }

  save(partial: Partial<DesktopPreferences>): DesktopPreferences {
    const next: DesktopPreferences = {
      ...this.read(),
      ...partial,
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }
}
