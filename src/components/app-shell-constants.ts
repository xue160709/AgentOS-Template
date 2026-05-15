import type { AppViewId } from './types'

export const SIDEBAR_WIDTH_STORAGE_KEY = 'CodeX-UI-Template-sidebar-width-px'
export const SIDEBAR_MAX_RATIO = 0.3

export const VIEW_HEADINGS: Record<AppViewId, string> = {
  home: 'Codex Chatbot',
  docs: '文档',
  settings: '设置',
}

export const NAV_LABELS: Record<'home' | 'docs', string> = {
  home: '聊天',
  docs: '文档',
}

export const NAV_VIEW_IDS = ['home', 'docs'] as const

export function normalizeViewId(value: string): AppViewId {
  return value === 'docs' || value === 'settings' ? value : 'home'
}

export function viewFromLocation(): AppViewId {
  return normalizeViewId(window.location.hash.replace(/^#/, ''))
}
