/**
 * 设置 · 开发者模式：仅开发构建可见的测试数据清理入口。
 * Settings · Developer mode: test-data cleanup tools visible only in dev builds.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CHAT_WORKSPACE_STORAGE_KEY } from '../../chat-workspace-persistence'
import { CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, CHAT_WORKSPACE_CLEARED_EVENT } from '../../app-events'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'

type DeveloperClearTarget = 'workspace' | 'claude'

/** `#settings/developer` 开发者设置页 / Developer settings route (dev builds only) */
export function DeveloperSettingsPage() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [dialogTarget, setDialogTarget] = useState<DeveloperClearTarget | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const workspaceMeta = {
    target: 'workspace' as const,
    title: t('settings.developer.workspaceTitle'),
    boundary: t('settings.developer.workspaceBoundary'),
    impact: t('settings.developer.workspaceImpact'),
    button: t('settings.developer.workspaceAction'),
    dialogTitle: t('settings.developer.workspaceDialogTitle'),
    dialogBody: t('settings.developer.dialogBody'),
    dialogConfirm: t('settings.developer.dialogConfirm'),
    statusClearing: t('settings.developer.workspaceClearing'),
    statusCleared: t('settings.developer.workspaceCleared'),
  }
  const claudeMeta = {
    target: 'claude' as const,
    title: t('settings.developer.claudeTitle'),
    boundary: t('settings.developer.claudeBoundary'),
    impact: t('settings.developer.claudeImpact'),
    button: t('settings.developer.claudeAction'),
    dialogTitle: t('settings.developer.claudeDialogTitle'),
    dialogBody: t('settings.developer.dialogBody'),
    dialogConfirm: t('settings.developer.dialogConfirm'),
    statusClearing: t('settings.developer.claudeClearing'),
    statusCleared: t('settings.developer.claudeCleared'),
  }
  const dialogMeta = dialogTarget === 'workspace' ? workspaceMeta : dialogTarget === 'claude' ? claudeMeta : null

  const openDialog = useCallback(
    (target: DeveloperClearTarget) => {
      if (busy) return
      setDialogTarget(target)
      setStatus('')
    },
    [busy],
  )

  const closeDialog = useCallback(() => {
    setDialogTarget(null)
  }, [])

  const runClear = useCallback(
    async (target: DeveloperClearTarget) => {
      if (busy) return
      setBusy(true)
      let clearedWorkspace = false
      try {
        if (target === 'workspace') {
          setStatus(workspaceMeta.statusClearing)
          await window.desktop?.clearChatWorkspaceData?.()
          try {
            localStorage.removeItem(CHAT_WORKSPACE_STORAGE_KEY)
          } catch {
            /* ignore */
          }
          setStatus(workspaceMeta.statusCleared)
          closeDialog()
          setBusy(false)
          clearedWorkspace = true
          window.dispatchEvent(new CustomEvent(CHAT_WORKSPACE_CLEARED_EVENT))
          window.location.hash = ''
        } else {
          setStatus(claudeMeta.statusClearing)
          await window.desktop?.clearClaudeAgentSettings?.()
          const snapshot = await window.claudeChat?.getSettings?.()
          if (snapshot) {
            window.dispatchEvent(new CustomEvent(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, { detail: snapshot }))
          }
          setStatus(claudeMeta.statusCleared)
          closeDialog()
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      } finally {
        if (!clearedWorkspace) {
          setBusy(false)
        }
      }
    },
    [busy, claudeMeta.statusCleared, claudeMeta.statusClearing, closeDialog, workspaceMeta.statusCleared, workspaceMeta.statusClearing],
  )

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (dialogTarget) {
      if (!el.open) el.showModal()
      return
    }
    if (el.open) el.close()
  }, [dialogTarget])

  const onDialogClose = useCallback(() => {
    closeDialog()
  }, [closeDialog])

  return (
    <section className="app-main-inner settings-page" id="panel-settings-developer" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">{t('settings.developer.pageTitle')}</h1>
        <p className="settings-lede">{t('settings.developer.pageLede')}</p>
      </header>

      <div className="settings-stack">
        <div className="settings-group" role="list" aria-label={t('settings.developer.groupAria')}>
          {[workspaceMeta, claudeMeta].map((item) => (
            <div className="settings-field-row settings-field-row--action" key={item.target} role="listitem">
              <div className="settings-field-row__meta">
                <p className="settings-field-row__label">{item.title}</p>
                <p className="settings-field-row__hint">{item.boundary}</p>
                <p className="settings-field-row__hint">{item.impact}</p>
              </div>
              <div className="settings-field-row__controls">
                <button
                  type="button"
                  className="btn btn-danger btn-compact"
                  disabled={busy}
                  onClick={() => openDialog(item.target)}
                >
                  <IconInline name="trash" />
                  <span>{item.button}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
        {status ? (
          <p className="settings-switch-status" role="status" aria-live="polite">
            {status}
          </p>
        ) : null}
        <dialog
          ref={dialogRef}
          className="settings-restart-dialog"
          aria-labelledby="developer-clear-dialog-title"
          onClose={onDialogClose}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              dialogRef.current?.close()
            }
          }}
        >
          <div className="settings-restart-dialog__panel" onClick={(event) => event.stopPropagation()}>
            <h3 id="developer-clear-dialog-title" className="settings-restart-dialog__title">
              {dialogMeta?.dialogTitle ?? ''}
            </h3>
            <p className="settings-restart-dialog__body">{dialogMeta?.dialogBody ?? ''}</p>
            <div className="settings-dev-dialog__summary">
              <p className="settings-dev-dialog__line">
                <strong>{t('settings.developer.boundaryLabel')}</strong>
                <span>{dialogMeta?.boundary ?? ''}</span>
              </p>
              <p className="settings-dev-dialog__line">
                <strong>{t('settings.developer.impactLabel')}</strong>
                <span>{dialogMeta?.impact ?? ''}</span>
              </p>
            </div>
            <div className="settings-restart-dialog__actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => dialogRef.current?.close()}
              >
                {t('settings.developer.dialogDismiss')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!dialogMeta || busy}
                onClick={() => {
                  if (!dialogTarget) return
                  void runClear(dialogTarget)
                }}
              >
                <IconInline name="trash" />
                <span>{dialogMeta?.dialogConfirm ?? ''}</span>
              </button>
            </div>
          </div>
        </dialog>
      </div>
    </section>
  )
}
