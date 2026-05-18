/**
 * 应用壳路由片段、侧栏存储键与导航元数据。
 * App shell route fragments, sidebar storage keys, and nav metadata.
 */

import type { IconName } from '../icons'
import type { AppViewId, SettingsCategoryId } from './types'

/** localStorage：侧栏像素宽度 / localStorage key for sidebar width px */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'CodeX-UI-Template-sidebar-width-px'

/** localStorage：侧栏项目技能展开状态 / Sidebar project skills expansion blob */
export const SIDEBAR_PROJECT_SKILLS_STORAGE_KEY = 'CodeX-UI-Template-sidebar-project-skills-v1'

/** localStorage：按项目隐藏的技能路径列表 / Per-project hidden skill paths */
export const SIDEBAR_HIDDEN_SKILLS_STORAGE_KEY = 'CodeX-UI-Template-sidebar-hidden-skills-v1'

/** 侧栏最大宽度占视口比例 / Max sidebar width as viewport ratio */
export const SIDEBAR_MAX_RATIO = 0.3

/**
 * 项目内 Home Plugins 根目录（相对项目根）。
 * Used to decide whether opening the customization thread should auto-submit the bootstrap prompt.
 */
export const HOME_PLUGINS_DIR_RELATIVE = '.agents/home-plugins'

/** 默认设置分类 / Default settings category */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = 'general'

/** 设置侧栏导航（文案键 + 图标）/ Settings sidebar nav entries (i18n keys + icons) */
export const SETTINGS_SIDEBAR_NAV: {
  id: SettingsCategoryId
  labelKey: string
  icon: IconName
  disabled?: boolean
}[] = [
  { id: 'general', labelKey: 'settingsCategory.models', icon: 'settings' },
  { id: 'skills', labelKey: 'settingsCategory.general', icon: 'chip' },
  { id: 'agent', labelKey: 'settingsCategory.agentMode', icon: 'agent' },
]

/** 非设置视图标题所用 i18n 键 / Heading keys for non-settings views */
export const VIEW_HEADING_KEYS: Record<Exclude<AppViewId, 'settings'>, string> = {
  home: 'shell.viewHome',
  docs: 'shell.viewDocs',
}

/** 设置分类对应的工作区标题键 / Workspace title key per settings category */
export function settingsWorkspaceTitleKey(category: SettingsCategoryId): string {
  if (category === 'skills') return 'shell.workspaceSettingsGeneral'
  if (category === 'agent') return 'shell.workspaceSettingsAgentMode'
  return 'shell.workspaceSettingsModels'
}

/** 主导航标签 i18n 键 / Primary nav label keys */
export const NAV_LABEL_KEYS: Record<'home' | 'docs', string> = {
  home: 'nav.home',
  docs: 'nav.docs',
}

/** URL hash 中识别的视图集合 / View ids derived from hash routing */
export const NAV_VIEW_IDS = ['home', 'docs'] as const

/** 将任意 hash 头部规范为主视图 / Normalize hash head to primary AppViewId */
export function normalizeViewId(value: string): AppViewId {
  const head = value.split('/')[0] ?? ''
  return head === 'docs' || head === 'settings' ? head : 'home'
}

/** 读取当前 location hash 对应视图 / Read AppViewId from window.location.hash */
export function viewFromLocation(): AppViewId {
  const head = window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  return normalizeViewId(head)
}

/** 解析 `#settings/<category>` / Parse settings category from hash */
export function settingsCategoryFromLocation(): SettingsCategoryId {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] !== 'settings') return DEFAULT_SETTINGS_CATEGORY
  const sub = parts[1]
  if (sub === 'skills') return 'skills'
  if (sub === 'agent') return 'agent'
  return DEFAULT_SETTINGS_CATEGORY
}
