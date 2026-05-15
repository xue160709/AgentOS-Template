import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ClaudeAgentConfigSource,
  ClaudeAgentModelProvider,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../claude-chat-types'
import type { SettingsCategoryId } from './types'
import { IconInline } from '../icon-inline'

const SETTINGS_CHANGED_EVENT = 'claude-agent-settings:changed'

type SettingsPageProps = { hidden: boolean; settingsCategory: SettingsCategoryId }
type EditableProviderField = Exclude<keyof ClaudeAgentModelProvider, 'id'>

export function SettingsPage({ hidden, settingsCategory }: SettingsPageProps) {
  const [configSource, setConfigSource] = useState<ClaudeAgentConfigSource>('settings')
  const [providers, setProviders] = useState<ClaudeAgentModelProvider[]>(() => [createModelProvider()])
  /** 左侧列表：仅决定下方表单在编辑哪一条，与聊天使用的条目无关 */
  const [editingProviderId, setEditingProviderId] = useState('')
  /** 持久化字段：与聊天输入框模型菜单一致，保存设置时不得被「编辑中」条目覆盖 */
  const [chatActiveProviderId, setChatActiveProviderId] = useState('')
  /** 选中主 Model 之外的实际请求模型；空则用该条目 Model 字段 */
  const [chatActiveAnthropicModel, setChatActiveAnthropicModel] = useState('')
  const [envStatusTags, setEnvStatusTags] = useState(['ENV: 未读取'])
  const [status, setStatus] = useState('')
  const [saveDisabled, setSaveDisabled] = useState(false)
  const [busy, setBusy] = useState(false)

  const editingProvider = useMemo(
    () => providers.find((provider) => provider.id === editingProviderId) ?? providers[0],
    [editingProviderId, providers],
  )

  const applySnapshot = useCallback((snapshot: ClaudeAgentSettingsSnapshot) => {
    const nextProviders = snapshot.settings.providers.length
      ? snapshot.settings.providers.map((provider) => ({ ...provider }))
      : [createModelProvider()]
    const nextChatActiveId = nextProviders.some((provider) => provider.id === snapshot.settings.activeProviderId)
      ? snapshot.settings.activeProviderId
      : nextProviders[0].id

    setConfigSource(snapshot.settings.configSource)
    setProviders(nextProviders)
    setChatActiveProviderId(nextChatActiveId)
    setChatActiveAnthropicModel(snapshot.settings.activeAnthropicModel ?? '')
    setEditingProviderId((prev) =>
      nextProviders.some((provider) => provider.id === prev) ? prev : nextProviders[0].id,
    )
    setEnvStatusTags(createEnvStatusTags(snapshot))
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
    const nextProviders = providers.length ? providers : [createModelProvider()]
    const persistedChatId = nextProviders.some((provider) => provider.id === chatActiveProviderId)
      ? chatActiveProviderId
      : nextProviders[0].id
    const overlay = pruneStoredAnthropicOverlay(nextProviders, persistedChatId, chatActiveAnthropicModel)
    const payload: ClaudeAgentSettings = {
      configSource,
      activeProviderId: persistedChatId,
      activeAnthropicModel: overlay,
      providers: nextProviders,
    }

    setBusy(true)
    setStatus('保存中')
    try {
      const snapshot = await window.claudeChat.saveSettings(payload)
      applySnapshot(snapshot)
      window.dispatchEvent(new CustomEvent('claude-agent-settings:changed', { detail: snapshot }))
      setStatus('已保存')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [
    applySnapshot,
    chatActiveAnthropicModel,
    chatActiveProviderId,
    configSource,
    providers,
  ])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void save()
  }

  const addProvider = () => {
    const provider = createModelProvider()
    setProviders((current) => [...current, provider])
    setEditingProviderId(provider.id)
    setStatus('已添加模型配置')
  }

  const removeProvider = (providerId: string) => {
    if (providers.length <= 1) return

    const nextProviders = providers.filter((provider) => provider.id !== providerId)
    setProviders(nextProviders)
    if (editingProviderId === providerId) {
      setEditingProviderId(nextProviders[0]?.id ?? '')
    }
    if (chatActiveProviderId === providerId) {
      setChatActiveProviderId(nextProviders[0]?.id ?? '')
    }
    setStatus('已移除模型配置')
  }

  const updateEditingProvider = (field: EditableProviderField, value: string) => {
    if (!editingProvider) return
    setProviders((current) =>
      current.map((provider) => (provider.id === editingProvider.id ? { ...provider, [field]: value } : provider)),
    )
  }

  useEffect(() => {
    if (hidden || settingsCategory !== 'general') return
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<ClaudeAgentSettingsSnapshot>).detail
      const id = detail.settings.activeProviderId
      if (detail.settings.providers.some((provider) => provider.id === id)) {
        setChatActiveProviderId(id)
        setChatActiveAnthropicModel(detail.settings.activeAnthropicModel ?? '')
      }
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onExternal)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onExternal)
  }, [hidden, settingsCategory])

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
          在此处填写多条模型厂商配置。真正用于对话请求的条目须在聊天输入框旁的模型菜单中切换；条目中的 API Key、Base URL、Model 会与所选条目对齐。
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
                <span className="settings-segment-desc">
                  聊天里选中的条目若在此模式下，其非空字段会覆盖同名环境变量，空字段回退环境值。
                </span>
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

        <section className="settings-section" aria-labelledby="settings-section-providers-heading">
          <div className="settings-section-header">
            <h2 id="settings-section-providers-heading" className="settings-section-heading">
              模型厂商
            </h2>
            <button type="button" className="btn btn-ghost btn-compact" onClick={addProvider}>
              <IconInline name="plus" />
              <span>添加</span>
            </button>
          </div>
          <p className="settings-section-caption">
            点击某行仅打开下方表单进行填写，不会在设置页切换对话模型。主 Model、Haiku / Sonnet / Opus 映射里填写的标识符都会在聊天模型菜单中出现（同一标识符只展示一行）。
          </p>
          <div className="settings-provider-list" role="list" aria-label="模型厂商条目">
            {providers.map((provider) => {
              const isEditing = provider.id === editingProvider?.id
              return (
                <div
                  key={provider.id}
                  className={['settings-provider-row', isEditing ? 'is-editing' : ''].filter(Boolean).join(' ')}
                >
                  <button
                    type="button"
                    className="settings-provider-select"
                    aria-current={isEditing ? 'true' : undefined}
                    onClick={() => setEditingProviderId(provider.id)}
                  >
                    <span className="settings-provider-chevron" aria-hidden="true">
                      <IconInline name="chevron" />
                    </span>
                    <span className="settings-provider-copy">
                      <span className="settings-provider-model">{providerDisplayName(provider)}</span>
                      <span className="settings-provider-meta">{providerMeta(provider)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="settings-icon-button"
                    title={providers.length <= 1 ? '至少保留一个模型配置' : '删除模型配置'}
                    aria-label="删除模型配置"
                    disabled={providers.length <= 1}
                    onClick={() => removeProvider(provider.id)}
                  >
                    <IconInline name="trash" />
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-section-connection-heading">
          <h2 id="settings-section-connection-heading" className="settings-section-heading">
            填写条目详情
          </h2>
          <p id="settings-section-connection-desc" className="settings-section-caption">
            对应上方列表中当前高亮的条目；在此处修改不会切换聊天正在使用的厂商（请到聊天输入框旁的模型菜单切换）。
          </p>
          <div className="settings-group" aria-describedby="settings-section-connection-desc">
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-provider-name" className="settings-field-row__label">
                  <IconInline name="settings" />
                  配置名称
                </label>
                <p className="settings-field-row__hint">可选备注；用于在左侧列表中显示更易识别的标题。</p>
              </div>
              <input
                id="claude-provider-name"
                type="text"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="智谱 GLM"
                value={editingProvider?.name ?? ''}
                onChange={(event) => updateEditingProvider('name', event.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-api-key" className="settings-field-row__label">
                  <IconInline name="key" />
                  API Key
                </label>
                <p className="settings-field-row__hint">对应 ANTHROPIC_API_KEY；可与环境变量组合使用（见配置来源）。</p>
              </div>
              <input
                id="claude-api-key"
                type="password"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                value={editingProvider?.apiKey ?? ''}
                onChange={(event) => updateEditingProvider('apiKey', event.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-base-url" className="settings-field-row__label">
                  <IconInline name="server" />
                  Base URL
                </label>
                <p className="settings-field-row__hint">对应 ANTHROPIC_BASE_URL，留空则继续使用环境变量。</p>
              </div>
              <input
                id="claude-base-url"
                type="url"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://open.bigmodel.cn/api/anthropic"
                value={editingProvider?.baseUrl ?? ''}
                onChange={(event) => updateEditingProvider('baseUrl', event.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-haiku-model" className="settings-field-row__label">
                  <IconInline name="chip" />
                  Haiku Model
                </label>
                <p className="settings-field-row__hint">对应 ANTHROPIC_DEFAULT_HAIKU_MODEL。</p>
              </div>
              <input
                id="claude-haiku-model"
                type="text"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="glm-4.7"
                value={editingProvider?.defaultHaikuModel ?? ''}
                onChange={(event) => updateEditingProvider('defaultHaikuModel', event.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-sonnet-model" className="settings-field-row__label">
                  <IconInline name="chip" />
                  Sonnet Model
                </label>
                <p className="settings-field-row__hint">对应 ANTHROPIC_DEFAULT_SONNET_MODEL。</p>
              </div>
              <input
                id="claude-sonnet-model"
                type="text"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="glm-5"
                value={editingProvider?.defaultSonnetModel ?? ''}
                onChange={(event) => updateEditingProvider('defaultSonnetModel', event.target.value)}
              />
            </div>
            <div className="settings-field-row">
              <div className="settings-field-row__meta">
                <label htmlFor="claude-opus-model" className="settings-field-row__label">
                  <IconInline name="chip" />
                  Opus Model
                </label>
                <p className="settings-field-row__hint">对应 ANTHROPIC_DEFAULT_OPUS_MODEL。</p>
              </div>
              <input
                id="claude-opus-model"
                type="text"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                placeholder="glm-5.1"
                value={editingProvider?.defaultOpusModel ?? ''}
                onChange={(event) => updateEditingProvider('defaultOpusModel', event.target.value)}
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
            {envStatusTags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
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

function pruneStoredAnthropicOverlay(
  providers: ClaudeAgentModelProvider[],
  activeProviderId: string,
  overlayRaw: string,
): string {
  const provider = providers.find((p) => p.id === activeProviderId)
  const overlay = overlayRaw.trim()
  if (!provider || !overlay) return ''
  const primary = provider.model.trim()
  if (overlay === primary || !providerKnowsAnthropicModelId(provider, overlay)) return ''
  return overlay
}

function providerKnowsAnthropicModelId(provider: ClaudeAgentModelProvider, id: string): boolean {
  const m = id.trim()
  if (!m) return false
  const pool = [
    provider.model,
    provider.defaultHaikuModel,
    provider.defaultSonnetModel,
    provider.defaultOpusModel,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
  return pool.includes(m)
}

function createModelProvider(): ClaudeAgentModelProvider {
  return {
    id: createProviderId(),
    name: '',
    apiKey: '',
    authToken: '',
    baseUrl: '',
    model: '',
    defaultHaikuModel: '',
    defaultOpusModel: '',
    defaultSonnetModel: '',
  }
}

function createProviderId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function providerDisplayName(provider: ClaudeAgentModelProvider): string {
  return provider.model || provider.name || '未命名模型'
}

function providerMeta(provider: ClaudeAgentModelProvider): string {
  const parts = [
    provider.name && provider.model ? provider.name : '',
    provider.baseUrl,
    provider.apiKey ? 'API Key 已设置' : '',
  ].filter(Boolean)

  return parts.length ? parts.join(' · ') : '尚未配置 API Key / Base URL'
}

function createEnvStatusTags(snapshot: ClaudeAgentSettingsSnapshot): string[] {
  const env = snapshot.env
  const modelMapping = [
    env.defaultHaikuModel ? `Haiku ${env.defaultHaikuModel}` : '',
    env.defaultSonnetModel ? `Sonnet ${env.defaultSonnetModel}` : '',
    env.defaultOpusModel ? `Opus ${env.defaultOpusModel}` : '',
  ]
    .filter(Boolean)
    .join(' / ')

  return [
    env.hasApiKey
      ? 'ENV API Key: 已设置'
      : env.hasAuthToken
        ? 'ENV Auth Token: 已设置'
        : 'ENV 凭据: 未设置',
    env.baseUrl ? `ENV Base URL: ${env.baseUrl}` : 'ENV Base URL: 默认',
    env.model ? `ENV Model: ${env.model}` : 'ENV Model: 默认',
    modelMapping ? `ENV 模型映射: ${modelMapping}` : 'ENV 模型映射: 默认',
  ]
}
