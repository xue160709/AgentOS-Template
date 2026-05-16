/**
 * Agent Mode 弹出菜单：侧栏联动与嵌入式控件挂载点。
 * Popover + toolbar wiring for Agent Mode state and side panel tab focus.
 */

import { useEffect, useRef, useState } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { WorkspaceSidePanelTab } from './AppWorkspaceSidePanel'
import { AgentModeControls } from './AgentModeControls'
import type { WorkspaceAgentModeState } from './useWorkspaceAgentMode'

type AgentModeMenuProps = {
  agent: WorkspaceAgentModeState
  sidePanelOpen: boolean
  sidePanelTab: WorkspaceSidePanelTab
  onToggleSidePanelTab: (tab: WorkspaceSidePanelTab) => void
  onAgentEnabledFromPopover: () => void
}

/** 工具栏 Agent chip：打开 Agent/TODO 面板或弹出设置 / Toolbar Agent chip opening panel or popover */
export function AgentModeMenu({
  agent,
  sidePanelOpen,
  sidePanelTab,
  onToggleSidePanelTab,
  onAgentEnabledFromPopover,
}: AgentModeMenuProps) {
  const { t } = useI18n()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (agent.enabled) setPopoverOpen(false)
  }, [agent.enabled])

  useEffect(() => {
    if (!popoverOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      setPopoverOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [popoverOpen])

  const toolbarActive = agent.enabled ? sidePanelOpen && sidePanelTab === 'agent' : popoverOpen

  return (
    <div className="agent-mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-toolbar${toolbarActive ? ' is-active' : ''}`}
        title={t('workspace.agentModeTitle')}
        aria-label={t('workspace.agentModeTitle')}
        aria-haspopup={agent.enabled ? undefined : 'dialog'}
        aria-expanded={toolbarActive}
        onClick={() => {
          if (agent.enabled) {
            onToggleSidePanelTab('agent')
          } else {
            setPopoverOpen((value) => !value)
          }
        }}
      >
        <IconInline name="agent" />
      </button>
      {!agent.enabled && popoverOpen ? (
        <div className="agent-mode-popover" role="dialog" aria-label={t('workspace.agentModeTitle')}>
          <AgentModeControls
            variant="popover"
            enabled={agent.enabled}
            todoEnabled={agent.todoEnabled}
            loading={agent.loading}
            onAgentSwitchChange={(checked) => {
              if (checked) void agent.enableAgentMode({ onSuccess: onAgentEnabledFromPopover })
              else void agent.updateAgentModeState({ enabled: false })
            }}
            onTodoSwitchChange={(checked) => {
              void agent.updateAgentModeState({ todoEnabled: checked })
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
