/**
 * Agent Mode 双开关 UI（嵌入式或弹出层变体）。
 * Agent Mode toggle cluster for embedded toolbar vs popover layouts.
 */

import { useI18n } from '../i18n/i18n'

type AgentModeControlsProps = {
  variant: 'popover' | 'embedded'
  enabled: boolean
  todoEnabled: boolean
  loading: boolean
  onAgentSwitchChange: (checked: boolean) => void
  onTodoSwitchChange: (checked: boolean) => void
  onCustomizeHome?: () => void
}

/** Agent/TODO 开关控件 / Dual switches for Agent Mode + TODO scaffold */
export function AgentModeControls({
  variant,
  enabled,
  todoEnabled,
  loading,
  onAgentSwitchChange,
  onTodoSwitchChange,
  onCustomizeHome,
}: AgentModeControlsProps) {
  const { t } = useI18n()

  return (
    <div
      className={`agent-mode-controls${variant === 'embedded' ? ' agent-mode-controls--embedded' : ''}`}
      aria-busy={loading}
    >
      <label className="agent-mode-switch">
        <span className="agent-mode-switch__copy">
          <span>{t('workspace.agentModeToggle')}</span>
          <span>{t('workspace.agentModeToggleDesc')}</span>
        </span>
        <span className="settings-switch-control">
          <input
            className="settings-switch-input"
            type="checkbox"
            checked={enabled}
            disabled={loading}
            onChange={(event) => {
              onAgentSwitchChange(event.target.checked)
            }}
          />
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-thumb" />
          </span>
        </span>
      </label>
      {enabled ? (
        <>
          <label className="agent-mode-switch">
            <span className="agent-mode-switch__copy">
              <span>{t('workspace.todoModeToggle')}</span>
              <span>{t('workspace.todoModeToggleDesc')}</span>
            </span>
            <span className="settings-switch-control">
              <input
                className="settings-switch-input"
                type="checkbox"
                checked={todoEnabled}
                disabled={loading}
                onChange={(event) => {
                  onTodoSwitchChange(event.target.checked)
                }}
              />
              <span className="settings-switch-track" aria-hidden="true">
                <span className="settings-switch-thumb" />
              </span>
            </span>
          </label>
          {onCustomizeHome ? (
            <button
              type="button"
              className="agent-mode-customize-home"
              disabled={loading}
              onClick={onCustomizeHome}
            >
              {t('workspace.customizeAgentPanel')}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
