import { ClaudeAgentSettingsPage } from './ClaudeAgentSettingsPage'
import { ProjectSkillsSettingsPage } from './ProjectSkillsSettingsPage'
import type { SettingsCategoryId } from './types'

type SettingsPageProps = {
  hidden: boolean
  settingsCategory: SettingsCategoryId
  showProjectSkillsInSidebar: boolean
  onShowProjectSkillsInSidebarChange: (enabled: boolean) => void
}

export function SettingsPage({
  hidden,
  settingsCategory,
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

  return <ClaudeAgentSettingsPage />
}
