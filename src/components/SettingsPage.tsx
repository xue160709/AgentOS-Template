import { AgentModeSettingsPage } from './AgentModeSettingsPage'
import { ClaudeAgentSettingsPage } from './ClaudeAgentSettingsPage'
import { ProjectSkillsSettingsPage } from './ProjectSkillsSettingsPage'
import type { SettingsCategoryId, WorkspaceProject } from './types'

type SettingsPageProps = {
  hidden: boolean
  settingsCategory: SettingsCategoryId
  activeProject: WorkspaceProject
  showProjectSkillsInSidebar: boolean
  onShowProjectSkillsInSidebarChange: (enabled: boolean) => void
}

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
