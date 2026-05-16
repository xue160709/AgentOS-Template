import { useCallback, useEffect, useRef, useState } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { AgentModeFilesResult, AgentModeStatusResult } from '../desktop-types'
import type { WorkspaceProject } from './types'

type AgentModeMenuProps = {
  project: WorkspaceProject
}

export function AgentModeMenu({ project }: AgentModeMenuProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [todoEnabled, setTodoEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [lastResult, setLastResult] = useState<AgentModeFilesResult | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
    setLastResult(null)
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

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const enableAgentMode = async () => {
    const ensureAgentModeFiles = window.desktop?.ensureAgentModeFiles
    if (!ensureAgentModeFiles) {
      setMessage(t('workspace.agentModeUnavailable'))
      return
    }

    setLoading(true)
    setMessage(t('workspace.agentModeEnabling'))
    try {
      const result = await ensureAgentModeFiles(project.path, locale)
      setLastResult(result)
      setEnabled(result.ok)
      setMessage(result.message)
      if (result.ok) {
        void window.desktop?.getAgentModeStatus?.(project.path, locale).then(applyStatus).catch(() => undefined)
      }
    } catch (error) {
      setEnabled(false)
      setMessage(error instanceof Error ? error.message : t('workspace.agentModeFailed'))
    } finally {
      setLoading(false)
    }
  }

  const updateAgentModeState = async (partial: { enabled?: boolean; todoEnabled?: boolean }) => {
    const setAgentModeState = window.desktop?.setAgentModeState
    if (!setAgentModeState) {
      setMessage(t('workspace.agentModeUnavailable'))
      return
    }

    setLoading(true)
    setLastResult(null)
    setMessage(partial.todoEnabled === undefined ? t('workspace.agentModeDisabling') : t('workspace.todoModeUpdating'))
    try {
      const result = await setAgentModeState(project.path, partial, locale)
      applyStatus(result)
      if (result.ok && partial.enabled === false) {
        setMessage(t('workspace.agentModeDisabled'))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('workspace.agentModeFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="agent-mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-toolbar${open ? ' is-active' : ''}`}
        title={t('workspace.agentModeTitle')}
        aria-label={t('workspace.agentModeTitle')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconInline name="agent" />
      </button>
      {open ? (
        <div className="agent-mode-popover" role="dialog" aria-label={t('workspace.agentModeTitle')}>
          <div className="agent-mode-popover__header">
            <span>{t('workspace.agentModeTitle')}</span>
            <span>{project.name}</span>
          </div>
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
                  if (event.target.checked) void enableAgentMode()
                  else void updateAgentModeState({ enabled: false })
                }}
              />
              <span className="settings-switch-track" aria-hidden="true">
                <span className="settings-switch-thumb" />
              </span>
            </span>
          </label>
          {enabled ? (
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
                    void updateAgentModeState({ todoEnabled: event.target.checked })
                  }}
                />
                <span className="settings-switch-track" aria-hidden="true">
                  <span className="settings-switch-thumb" />
                </span>
              </span>
            </label>
          ) : null}
          <div className="agent-mode-popover__status" role="status" aria-live="polite">
            {message || t('workspace.agentModeNeedsSetup')}
          </div>
          {lastResult?.ok ? (
            <ul className="agent-mode-file-list">
              {lastResult.files.map((file) => (
                <li key={file.relativePath}>
                  <span>{file.relativePath}</span>
                  <span>{t(`workspace.agentModeFileStatus.${file.status}`)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
