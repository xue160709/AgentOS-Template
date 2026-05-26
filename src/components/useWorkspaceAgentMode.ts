/**
 * 针对单个项目同步 Agent Mode 状态（IPC + 本地文案）。
 * Hook syncing Agent Mode flags for one workspace project via desktop IPC.
 */

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/i18n'
import type { AgentModeStatusResult } from '../desktop-types'
import type { WorkspaceProject } from './types'

/** 读取/切换 Agent Mode，暴露加载态与提示语 / Fetch toggles, loaders, and status copy */
export function useWorkspaceAgentMode(project: WorkspaceProject) {
  const { t, locale } = useI18n()
  const [enabled, setEnabled] = useState(false)
  const [todoEnabled, setTodoEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const applyStatus = useCallback((status: AgentModeStatusResult) => {
    if (!status.ok) {
      setEnabled(false)
      setTodoEnabled(false)
      setMessage(status.message)
      return
    }
    setEnabled(status.enabled)
    setTodoEnabled(status.todoEnabled)
    setMessage(status.enabled ? t('workspace.agentModeReady') : t('workspace.agentModeNeedsSetup'))
  }, [t])

  useEffect(() => {
    setMessage('')
    const getAgentModeStatus = window.desktop?.getAgentModeStatus
    if (!getAgentModeStatus) {
      setEnabled(false)
      setTodoEnabled(false)
      setMessage(t('workspace.agentModeUnavailable'))
      return
    }

    void getAgentModeStatus(project.path, locale)
      .then(applyStatus)
      .catch(() => {
        setEnabled(false)
        setTodoEnabled(false)
        setMessage(t('workspace.agentModeUnavailable'))
      })
  }, [applyStatus, project.path, t, locale])

  const enableAgentMode = useCallback(
    async (opts?: { onSuccess?: () => void }) => {
      const ensureAgentModeFiles = window.desktop?.ensureAgentModeFiles
      if (!ensureAgentModeFiles) {
        setMessage(t('workspace.agentModeUnavailable'))
        return
      }

      setLoading(true)
      setMessage(t('workspace.agentModeEnabling'))
      try {
        const result = await ensureAgentModeFiles(project.path, locale)
        setEnabled(result.ok)
        setMessage(result.message)
        if (result.ok) {
          opts?.onSuccess?.()
          void window.desktop?.getAgentModeStatus?.(project.path, locale).then(applyStatus).catch(() => undefined)
        }
      } catch (error) {
        setEnabled(false)
        setMessage(error instanceof Error ? error.message : t('workspace.agentModeFailed'))
      } finally {
        setLoading(false)
      }
    },
    [applyStatus, locale, project.path, t],
  )

  const updateAgentModeState = useCallback(
    async (partial: { enabled?: boolean; todoEnabled?: boolean }) => {
      const setAgentModeState = window.desktop?.setAgentModeState
      if (!setAgentModeState) {
        setMessage(t('workspace.agentModeUnavailable'))
        return false
      }

      setLoading(true)
      setMessage(partial.todoEnabled === undefined ? t('workspace.agentModeDisabling') : t('workspace.todoModeUpdating'))
      try {
        const result = await setAgentModeState(project.path, partial, locale)
        applyStatus(result)
        if (result.ok && partial.enabled === false) {
          setMessage(t('workspace.agentModeDisabled'))
        }
        return result.ok
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t('workspace.agentModeFailed'))
        return false
      } finally {
        setLoading(false)
      }
    },
    [applyStatus, locale, project.path, t],
  )

  return {
    enabled,
    todoEnabled,
    loading,
    message,
    enableAgentMode,
    updateAgentModeState,
  }
}

/** Hook 返回值类型别名 / Alias for hook consumer props */
export type WorkspaceAgentModeState = ReturnType<typeof useWorkspaceAgentMode>
