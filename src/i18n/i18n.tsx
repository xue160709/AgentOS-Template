/**
 * 轻量 i18n：本地 JSON 目录、`localStorage` 初始语言与 React Context。
 * Lightweight locale catalog with persisted preference and React context helpers.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import en from '../locales/en.json'
import zh from '../locales/zh.json'

/** 受支持的界面语言 / Supported UI locales */
export type AppLocale = 'en' | 'zh'

/** `localStorage` 语言键 / Storage key for persisted locale */
export const LOCALE_STORAGE_KEY = 'CodeX-UI-Template-locale-v1'

type Messages = typeof en

const CATALOG: Record<AppLocale, Messages> = { en, zh }

/** 读取持久化语言回退 zh / Read persisted locale defaulting to zh */
export function getInitialLocale(): AppLocale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw === 'en' || raw === 'zh') return raw
  } catch {
    /* ignore */
  }
  return 'zh'
}

function getByPath(obj: unknown, path: string): string | undefined {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return typeof cur === 'string' ? cur : undefined
}

function applyInterpolation(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    const token = `{{${key}}}`
    out = out.split(token).join(String(value))
  }
  return out
}

/** 点路径翻译并支持 `{{var}}` 插值 / Dot-path lookup with optional interpolation */
export function translate(
  locale: AppLocale,
  path: string,
  vars?: Record<string, string | number>,
): string {
  const msg = getByPath(CATALOG[locale], path)
  if (msg !== undefined) return applyInterpolation(msg, vars)
  const fb = getByPath(CATALOG.en, path)
  if (import.meta.env?.DEV && fb === undefined) {
    console.warn(`[i18n] missing translation: ${path}`)
  }
  return applyInterpolation(fb ?? path, vars)
}

const zhTitle = getByPath(CATALOG.zh, 'thread.newThreadTitle')
const enTitle = getByPath(CATALOG.en, 'thread.newThreadTitle')

/** 视为「默认新线程标题」的本地化集合 / Known localized default thread titles */
export const defaultThreadTitleSet = new Set([zhTitle, enTitle].filter(Boolean) as string[])

type I18nContextValue = {
  locale: AppLocale
  t: (path: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

/** 提供静态（初次渲染）语言上下文 / Supplies locale + `t()` from initial storage snapshot */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = getInitialLocale()
  const t = useCallback(
    (path: string, vars?: Record<string, string | number>) => translate(locale, path, vars),
    [locale],
  )
  const value = useMemo(() => ({ locale, t }), [locale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** 读取当前 `t` 与 locale / Consume i18n context */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider')
  }
  return ctx
}
