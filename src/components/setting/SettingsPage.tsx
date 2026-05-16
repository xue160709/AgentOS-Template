/**
 * 设置路由分发器：模型 / 技能 / Agent Mode 子页。
 * Router component switching settings categories (models, skills, agent mode).
 */

import { AgentModeSettingsPage } from './AgentModeSettingsPage'
import { ClaudeAgentSettingsPage } from './ClaudeAgentSettingsPage'
import { ProjectSkillsSettingsPage } from './ProjectSkillsSettingsPage'
import type { SettingsCategoryId, WorkspaceProject } from '../types'

type SettingsPageProps = {
  hidden: boolean
  settingsCategory: SettingsCategoryId
  activeProject: WorkspaceProject
  showProjectSkillsInSidebar: boolean
  onShowProjectSkillsInSidebarChange: (enabled: boolean) => void
}

/** `#settings/<category>` 容器 / Host for hash-routed settings sections */
export function SettingsPage({
  hidden,
  settingsCategory,
  activeProject,
  showProjectSkillsInSidebar,
  onShowProjectSkillsInSidebarChange,
}: SettingsPageProps) {
  if (hidden) {
    return null
  }

  if (settingsCategory === 'skills') {
    return (
      <ProjectSkillsSettingsPage
        enabled={showProjectSkillsInSidebar}
        onEnabledChange={onShowProjectSkillsInSidebarChange}
      />
    )
  }

  if (settingsCategory === 'agent') {
    return <AgentModeSettingsPage project={activeProject} />
  }

  return <ClaudeAgentSettingsPage />
}
