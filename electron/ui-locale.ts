/**
 * 主进程 UI 语言归一化与 Electron Agent 文案目录访问。
 * Normalize UI locale and load Electron-scoped agent strings for the main process.
 */

import type { AppUiLocale } from '../src/desktop-types'
import zh from '../src/locales/zh.json'
import en from '../src/locales/en.json'

/** `electronAgent` 文案段的类型别名 / Type alias for `electronAgent` locale blob */
export type ElectronAgentCatalog = typeof zh.electronAgent

/** 将未知输入规范为 zh 或 en / Coerce unknown locale flag to zh or en */
export function normalizeUiLocale(value: unknown): AppUiLocale {
  return value === 'en' ? 'en' : 'zh'
}

/** 按语言返回 Electron Agent 相关文案 / Pick Electron agent strings for locale */
export function electronAgentCatalog(locale: AppUiLocale): ElectronAgentCatalog {
  return locale === 'en' ? en.electronAgent : zh.electronAgent
}
