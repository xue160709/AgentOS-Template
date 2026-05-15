import type { IconName } from '../icons'
import type { AppViewId, SettingsCategoryId } from './types'

export const SIDEBAR_WIDTH_STORAGE_KEY = 'CodeX-UI-Template-sidebar-width-px'
export const SIDEBAR_MAX_RATIO = 0.3

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = 'general'

/** 设置侧栏项：与 Codex「设置」左栏结构类似；未实现的项可标记 disabled */
export const SETTINGS_SIDEBAR_NAV: {
  id: SettingsCategoryId
  label: string
  icon: IconName
  disabled?: boolean
}[] = [
  { id: 'general', label: '常规', icon: 'settings' },
  { id: 'appearance', label: '外观', icon: 'laptop' },
]

export const VIEW_HEADINGS: Record<AppViewId, string> = {
  home: 'Codex Chatbot',
  docs: '文档',
  settings: '设置',
}

export function settingsWorkspaceTitle(category: SettingsCategoryId): string {
  return category === 'appearance' ? '设置 · 外观' : '设置 · 常规'
}

export const NAV_LABELS: Record<'home' | 'docs', string> = {
  home: '聊天',
  docs: '文档',
}

export const NAV_VIEW_IDS = ['home', 'docs'] as const

export function normalizeViewId(value: string): AppViewId {
  const head = value.split('/')[0] ?? ''
  return head === 'docs' || head === 'settings' ? head : 'home'
}

export function viewFromLocation(): AppViewId {
  const head = window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  return normalizeViewId(head)
}

export function settingsCategoryFromLocation(): SettingsCategoryId {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] !== 'settings') return DEFAULT_SETTINGS_CATEGORY
  const sub = parts[1]
  return sub === 'appearance' ? 'appearance' : DEFAULT_SETTINGS_CATEGORY
}
