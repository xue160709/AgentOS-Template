import { FormEvent, useCallback, useEffect, useState } from 'react'
import type {
  ClaudeAgentConfigSource,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../claude-chat-types'
import type { SettingsCategoryId } from './types'
import { IconInline } from '../icon-inline'

type SettingsPageProps = { hidden: boolean; settingsCategory: SettingsCategoryId }

export function SettingsPage({ hidden, settingsCategory }: SettingsPageProps) {
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
    if (hidden || settingsCategory !== 'general') return
    void load()
  }, [hidden, load, settingsCategory])

  if (hidden) {
    return null
  }

  if (settingsCategory === 'appearance') {
    return (
      <section className="app-main-inner settings-page" id="panel-settings" aria-hidden={false}>
        <header className="settings-page-header">
          <div className="app-main-eyebrow">设置</div>
          <h1 className="app-main-heading">外观</h1>
          <p className="settings-lede">该分类尚未接入，后续可在此配置主题、字体与窗口效果等选项。</p>
        </header>
      </section>
    )
  }

  return (
    <section className="app-main-inner settings-page" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <div className="app-main-eyebrow">设置</div>
        <h1 className="app-main-heading">Claude Agent</h1>
        <p className="settings-lede">
          选择凭据与环境变量的优先级；下方表单值可覆盖同名环境变量，留空字段则继续沿用环境中的配置。
        </p>
      </header>

      <form className="settings-stack" id="claude-settings-form" onSubmit={handleSubmit}>
        <section className="settings-section" aria-labelledby="settings-section-source-heading">
          <h2 id="settings-section-source-heading" className="settings-section-heading">
            配置来源
          </h2>
          <div className="settings-segmented" role="radiogroup" aria-label="Claude 配置来源">
            <label className={configSource === 'settings' ? 'settings-segment is-selected' : 'settings-segment'}>
              <input
                type="radio"
                name="configSource"
                value="settings"
                className="settings-segment-input"
                checked={configSource === 'settings'}
                onChange={() => setConfigSource('settings')}
              />
              <span className="settings-segment-body">
                <span className="settings-segment-top">
                  <span className="settings-segment-title">
                    <IconInline name="settings" />
                    <span>设置优先</span>
                  </span>
                  <span className="settings-segment-radio" aria-hidden="true" />
                </span>
                <span className="settings-segment-desc">表单可覆盖同名环境变量，未填字段回退环境值。</span>
              </span>
            </label>
            <label className={configSource === 'env' ? 'settings-segment is-selected' : 'settings-segment'}>
              <input
                type="radio"
                name="configSource"
                value="env"
                className="settings-segment-input"
                checked={configSource === 'env'}
                onChange={() => setConfigSource('env')}
              />
              <span className="settings-segment-body">
                <span className="settings-segment-top">
                  <span className="settings-segment-title">
                    <IconInline name="server" />
                    <span>仅环境变量</span>
                  </span>
                  <span className="settings-segment-radio" aria-hidden="true" />
                </span>
                <span className="settings-segment-desc">只读取 Electron 主进程环境中的 ANTHROPIC_*。</span>
              </span>
            </label>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-section-connection-heading">
          <h2 id="settings-section-connection-heading" className="settings-section-heading">
            连接与模型
          </h2>
          <div className="settings-group">
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-api-key" className="settings-field-row__label">
                  <IconInline name="key" />
                  API Key
                </label>
                <p className="settings-field-row__hint">保存在本地偏好中；不会在聊天 UI 明文展示。</p>
              </div>
              <input
                id="claude-api-key"
                type="password"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-base-url" className="settings-field-row__label">
                  <IconInline name="server" />
                  Base URL
                </label>
                <p className="settings-field-row__hint">自定义网关或服务端点时填写；默认留空可走官方终结点。</p>
              </div>
              <input
                id="claude-base-url"
                type="url"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.anthropic.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-model" className="settings-field-row__label">
                  <IconInline name="chip" />
                  Model
                </label>
                <p className="settings-field-row__hint">与 CLI / API 可用的模型标识一致。</p>
              </div>
              <input
                id="claude-model"
                type="text"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="claude-sonnet-4-6"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-section-env-heading">
          <h2 id="settings-section-env-heading" className="settings-section-heading">
            进程环境可读状态
          </h2>
          <p id="settings-section-env-desc" className="settings-section-caption">
            下列为主进程环境下的当前摘要，仅供参考，不会因点击保存而改写。
          </p>
          <ul className="settings-env-tags" aria-describedby="settings-section-env-desc">
            <li id="env-api-key-status">{envApiKeyStatus}</li>
            <li id="env-base-url-status">{envBaseUrlStatus}</li>
            <li id="env-model-status">{envModelStatus}</li>
          </ul>
        </section>

        <div className="settings-footer">
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
        </div>
      </form>
    </section>
  )
}
