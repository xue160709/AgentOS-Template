import type { IconName } from '../icons'
import type { AppViewId, SettingsCategoryId } from './types'

export const SIDEBAR_WIDTH_STORAGE_KEY = 'CodeX-UI-Template-sidebar-width-px'
export const SIDEBAR_PROJECT_SKILLS_STORAGE_KEY = 'CodeX-UI-Template-sidebar-project-skills-v1'
/** projectId → skill.path[] 侧栏隐藏（不再显示） */
export const SIDEBAR_HIDDEN_SKILLS_STORAGE_KEY = 'CodeX-UI-Template-sidebar-hidden-skills-v1'
export const SIDEBAR_MAX_RATIO = 0.3

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = 'general'

/** Settings sidebar `#settings/<id>` — labels via `t(settingsCategory.*)` */
export const SETTINGS_SIDEBAR_NAV: {
  id: SettingsCategoryId
  labelKey: string
  icon: IconName
  disabled?: boolean
}[] = [
  { id: 'general', labelKey: 'settingsCategory.models', icon: 'settings' },
  { id: 'skills', labelKey: 'settingsCategory.general', icon: 'chip' },
]

/** i18n keys for workspace title when not on settings */
export const VIEW_HEADING_KEYS: Record<Exclude<AppViewId, 'settings'>, string> = {
  home: 'shell.viewHome',
  docs: 'shell.viewDocs',
}

export function settingsWorkspaceTitleKey(category: SettingsCategoryId): string {
  return category === 'skills' ? 'shell.workspaceSettingsGeneral' : 'shell.workspaceSettingsModels'
}

export const NAV_LABEL_KEYS: Record<'home' | 'docs', string> = {
  home: 'nav.home',
  docs: 'nav.docs',
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
  if (sub === 'skills') return 'skills'
  return DEFAULT_SETTINGS_CATEGORY
}
