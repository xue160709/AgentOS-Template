import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { AgentModeProjectSettings } from '../desktop-types'
import type { WorkspaceProject } from './types'

type AgentModeSettingsPageProps = {
  project: WorkspaceProject
}

export function AgentModeSettingsPage({ project }: AgentModeSettingsPageProps) {
  const { t } = useI18n()
  const [user, setUser] = useState('')
  const [identity, setIdentity] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveDisabled, setSaveDisabled] = useState(false)
  const savedRef = useRef<Pick<AgentModeProjectSettings, 'user' | 'identity'>>({ user: '', identity: '' })

  const isDirty = useMemo(
    () => user !== savedRef.current.user || identity !== savedRef.current.identity,
    [identity, user],
  )

  const applySettings = useCallback((settings: AgentModeProjectSettings) => {
    const next = { user: settings.user, identity: settings.identity }
    savedRef.current = next
    setUser(next.user)
    setIdentity(next.identity)
  }, [])

  const load = useCallback(async () => {
    const getAgentModeSettings = window.desktop?.getAgentModeSettings
    if (!getAgentModeSettings) {
      setSaveDisabled(true)
      setStatus(t('settings.agentMode.bridgeUnavailable'))
      return
    }

    setBusy(true)
    setStatus(t('settings.agentMode.loading'))
    try {
      const result = await getAgentModeSettings(project.path)
      if (!result.ok) {
        setStatus(result.message)
        return
      }
      applySettings(result.settings)
      setSaveDisabled(false)
      setStatus(t('settings.agentMode.loaded'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [applySettings, project.path, t])

  const save = useCallback(async () => {
    const saveAgentModeSettings = window.desktop?.saveAgentModeSettings
    if (!saveAgentModeSettings) {
      setStatus(t('settings.agentMode.bridgeUnavailable'))
      return
    }

    setBusy(true)
    setStatus(t('settings.agentMode.saving'))
    try {
      const result = await saveAgentModeSettings(project.path, { user, identity })
      if (!result.ok) {
        setStatus(result.message)
        return
      }
      applySettings(result.settings)
      setStatus(t('settings.agentMode.saved'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [applySettings, identity, project.path, t, user])

  const cancel = useCallback(() => {
    setUser(savedRef.current.user)
    setIdentity(savedRef.current.identity)
    setStatus(t('settings.agentMode.reverted'))
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="app-main-inner settings-page settings-page--agent-mode" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">{t('settings.agentMode.pageTitle')}</h1>
        <p className="settings-lede">{t('settings.agentMode.pageLede', { name: project.name })}</p>
      </header>

      <form
        className="settings-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <section className="settings-section" aria-labelledby="agent-mode-context-heading">
          <h2 id="agent-mode-context-heading" className="settings-section-heading">
            {t('settings.agentMode.contextHeading')}
          </h2>
          <p className="settings-section-caption">{t('settings.agentMode.contextCaption')}</p>

          <div className="settings-group">
            <div className="settings-field-row settings-field-row--textarea">
              <div className="settings-field-row__meta">
                <label htmlFor="agent-mode-user" className="settings-field-row__label">
                  <IconInline name="user" />
                  {t('settings.agentMode.userLabel')}
                </label>
                <p className="settings-field-row__hint">{t('settings.agentMode.userHint')}</p>
              </div>
              <textarea
                id="agent-mode-user"
                className="settings-input settings-textarea"
                rows={10}
                value={user}
                spellCheck={false}
                placeholder={t('settings.agentMode.userPlaceholder')}
                onChange={(event) => setUser(event.target.value)}
              />
            </div>

            <div className="settings-field-row settings-field-row--textarea">
              <div className="settings-field-row__meta">
                <label htmlFor="agent-mode-identity" className="settings-field-row__label">
                  <IconInline name="agent" />
                  {t('settings.agentMode.identityLabel')}
                </label>
                <p className="settings-field-row__hint">{t('settings.agentMode.identityHint')}</p>
              </div>
              <textarea
                id="agent-mode-identity"
                className="settings-input settings-textarea"
                rows={10}
                value={identity}
                spellCheck={false}
                placeholder={t('settings.agentMode.identityPlaceholder')}
                onChange={(event) => setIdentity(event.target.value)}
              />
            </div>
          </div>
        </section>

        <div className="settings-editor-actions" aria-label={t('settings.agentMode.actionsAria')}>
          <p className="settings-editor-actions__hint">{t('settings.agentMode.actionsHint')}</p>
          <div className="settings-editor-actions__buttons">
            <button type="button" className="btn btn-ghost" disabled={busy || !isDirty} onClick={cancel}>
              {t('settings.agentMode.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || saveDisabled || !isDirty}>
              <IconInline name="save" />
              <span>{t('settings.agentMode.confirm')}</span>
            </button>
          </div>
        </div>

        {/* <p className="settings-switch-status" role="status" aria-live="polite">
          {status}
        </p> */}
      </form>
    </section>
  )
}
