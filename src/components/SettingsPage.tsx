import { FormEvent, useCallback, useEffect, useState } from 'react'
import type {
  ClaudeAgentConfigSource,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../claude-chat-types'
import { IconInline } from '../icon-inline'

type SettingsPageProps = { hidden: boolean }

export function SettingsPage({ hidden }: SettingsPageProps) {
  const [configSource, setConfigSource] = useState<ClaudeAgentConfigSource>('settings')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [envApiKeyStatus, setEnvApiKeyStatus] = useState('API Key: 未读取')
  const [envBaseUrlStatus, setEnvBaseUrlStatus] = useState('Base URL: 未读取')
  const [envModelStatus, setEnvModelStatus] = useState('Model: 未读取')
  const [status, setStatus] = useState('')
  const [saveDisabled, setSaveDisabled] = useState(false)
  const [busy, setBusy] = useState(false)

  const applySnapshot = useCallback((snapshot: ClaudeAgentSettingsSnapshot) => {
    setConfigSource(snapshot.settings.configSource)
    setApiKey(snapshot.settings.apiKey)
    setBaseUrl(snapshot.settings.baseUrl)
    setModel(snapshot.settings.model)
    setEnvApiKeyStatus(
      snapshot.env.hasApiKey
        ? 'ENV API Key: 已设置'
        : snapshot.env.hasAuthToken
          ? 'ENV Auth Token: 已设置'
          : 'ENV API Key: 未设置',
    )
    setEnvBaseUrlStatus(snapshot.env.baseUrl ? `ENV Base URL: ${snapshot.env.baseUrl}` : 'ENV Base URL: 默认')
    setEnvModelStatus(snapshot.env.model ? `ENV Model: ${snapshot.env.model}` : 'ENV Model: 默认')
  }, [])

  const load = useCallback(async () => {
    if (!window.claudeChat) {
      setStatus('Claude bridge 不可用')
      setSaveDisabled(true)
      return
    }
    setStatus('读取中')
    try {
      applySnapshot(await window.claudeChat.getSettings())
      setSaveDisabled(false)
      setStatus('已读取')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }, [applySnapshot])

  const save = useCallback(async () => {
    if (!window.claudeChat) {
      setStatus('Claude bridge 不可用')
      return
    }
    setBusy(true)
    setStatus('保存中')
    const payload: ClaudeAgentSettings = {
      configSource,
      apiKey,
      baseUrl,
      model,
    }
    try {
      applySnapshot(await window.claudeChat.saveSettings(payload))
      setStatus('已保存')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [applySnapshot, apiKey, baseUrl, configSource, model])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void save()
  }

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="app-main-inner settings-page" id="panel-settings" hidden={hidden} aria-hidden={hidden}>
      <div className="app-main-eyebrow">设置</div>
      <h1 className="app-main-heading">Claude Agent</h1>
      <section className="app-panel settings-panel">
        <form className="settings-form" id="claude-settings-form" onSubmit={handleSubmit}>
          <div className="settings-source-grid" role="radiogroup" aria-label="Claude 配置来源">
            <label className="settings-source-card">
              <input
                type="radio"
                name="configSource"
                value="settings"
                checked={configSource === 'settings'}
                onChange={() => setConfigSource('settings')}
              />
              <span className="settings-source-card__title">
                <IconInline name="settings" />
                <span>设置页优先</span>
              </span>
              <span className="settings-source-card__copy">表单里的值会覆盖同名环境变量，空字段继续沿用环境变量。</span>
            </label>
            <label className="settings-source-card">
              <input
                type="radio"
                name="configSource"
                value="env"
                checked={configSource === 'env'}
                onChange={() => setConfigSource('env')}
              />
              <span className="settings-source-card__title">
                <IconInline name="server" />
                <span>环境变量</span>
              </span>
              <span className="settings-source-card__copy">只从 Electron 主进程环境读取 ANTHROPIC_* 配置。</span>
            </label>
          </div>

          <label className="settings-field">
            <span>
              <IconInline name="key" />
              <span>API Key</span>
            </span>
            <input
              className="settings-input"
              id="claude-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>
              <IconInline name="server" />
              <span>Base URL</span>
            </span>
            <input
              className="settings-input"
              id="claude-base-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>
              <IconInline name="chip" />
              <span>Model</span>
            </span>
            <input
              className="settings-input"
              id="claude-model"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="claude-sonnet-4-6"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>

          <div className="settings-env-summary" aria-label="环境变量状态">
            <span id="env-api-key-status">{envApiKeyStatus}</span>
            <span id="env-base-url-status">{envBaseUrlStatus}</span>
            <span id="env-model-status">{envModelStatus}</span>
          </div>

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" id="btn-save-claude-settings" disabled={saveDisabled || busy}>
              <IconInline name="save" />
              <span>保存</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              id="btn-reload-claude-settings"
              onClick={() => void load()}
            >
              <IconInline name="refresh" />
              <span>重新读取</span>
            </button>
            <span className="settings-status" id="claude-settings-status" role="status">
              {status}
            </span>
          </div>
        </form>
      </section>
    </section>
  )
}
