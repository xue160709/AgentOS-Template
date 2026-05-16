import type { AppUiLocale } from '../src/desktop-types'
import zh from '../src/locales/zh.json'
import en from '../src/locales/en.json'

export type ElectronAgentCatalog = typeof zh.electronAgent

export function normalizeUiLocale(value: unknown): AppUiLocale {
  return value === 'en' ? 'en' : 'zh'
}

export function electronAgentCatalog(locale: AppUiLocale): ElectronAgentCatalog {
  return locale === 'en' ? en.electronAgent : zh.electronAgent
}
