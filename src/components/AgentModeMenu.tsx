/**
 * Agent Mode toolbar switch.
 */

import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { WorkspaceAgentModeState } from './useWorkspaceAgentMode'

type AgentModeMenuProps = {
  agent: WorkspaceAgentModeState
}

/** 右上角 Agent Mode 开关 / Toolbar switch that only toggles Agent Mode readiness */
export function AgentModeMenu({ agent }: AgentModeMenuProps) {
  const { t } = useI18n()

  const toggle = (checked: boolean) => {
    if (checked) {
      void agent.enableAgentMode()
    } else {
      void agent.updateAgentModeState({ enabled: false })
    }
  }

  return (
    <label
      className={`agent-mode-toolbar-switch${agent.enabled ? ' is-on' : ''}${agent.loading ? ' is-loading' : ''}`}
      title={agent.enabled ? t('workspace.agentModeReady') : t('workspace.agentModeTitle')}
      aria-label={t('workspace.agentModeTitle')}
    >
      <input
        className="agent-mode-toolbar-switch__input"
        type="checkbox"
        checked={agent.enabled}
        disabled={agent.loading}
        onChange={(event) => toggle(event.target.checked)}
      />
      <span className="agent-mode-toolbar-switch__track" aria-hidden="true">
        <span className="agent-mode-toolbar-switch__thumb">
          <IconInline name="agent" />
        </span>
      </span>
    </label>
  )
}
