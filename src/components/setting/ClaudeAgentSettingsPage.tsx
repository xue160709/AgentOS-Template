/**
 * Claude Agent 多提供商模型配置 UI。
 * Multi-provider Claude Agent credentials UI backed by `claudeChat.getSettings`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClaudeAgentConfigSource,
  ClaudeAgentModelProvider,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../../claude-chat-types'
import { CLAUDE_AGENT_SETTINGS_CHANGED_EVENT } from '../../app-events'
import { IconInline } from '../../icon-inline'
import { getInitialLocale, translate, useI18n } from '../../i18n/i18n'

const IS_DEV_BUILD = import.meta.env.DEV

// --- Snapshot helpers / 快照辅助 ---

function cloneSettingsSnapshot(snapshot: ClaudeAgentSettingsSnapshot): ClaudeAgentSettingsSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ClaudeAgentSettingsSnapshot
}

function isSettingsDirty(
  configSource: ClaudeAgentConfigSource,
  activeProviderId: string,
  activeAnthropicModel: string,
  providers: ClaudeAgentModelProvider[],
  snapshot: ClaudeAgentSettingsSnapshot,
): boolean {
  const { settings } = snapshot
  if (configSource !== settings.configSource) return true
  if (activeProviderId !== settings.activeProviderId) return true
  if ((activeAnthropicModel ?? '') !== (settings.activeAnthropicModel ?? '')) return true
  return JSON.stringify(providers) !== JSON.stringify(settings.providers)
}

type EditableProviderField = Exclude<keyof ClaudeAgentModelProvider, 'id'>

// --- Settings page / 模型设置页面 ---

/** `#settings/general` Claude Agent UI / Claude credentials UI route */
export function ClaudeAgentSettingsPage() {
  const { t } = useI18n()
  const [configSource, setConfigSource] = useState<ClaudeAgentConfigSource>('settings')
  const [providers, setProviders] = useState<ClaudeAgentModelProvider[]>(() => [createModelProvider()])
  /** 手风琴展开 id（编辑 UX）；非聊天激活条目 / Accordion UX id not tied to chat-active provider */
  const [expandedProviderId, setExpandedProviderId] = useState('')
  /** 持久化字段：与聊天输入框模型菜单一致，保存设置时不得被「编辑中」条目覆盖 */
  const [chatActiveProviderId, setChatActiveProviderId] = useState('')
  /** 选中的实际请求模型；空则沿用该条目的默认模型字段 */
  const [chatActiveAnthropicModel, setChatActiveAnthropicModel] = useState('')
  const [envStatusTags, setEnvStatusTags] = useState<string[]>(() => [translate(getInitialLocale(), 'settings.models.envNotLoaded')])
  const [status, setStatus] = useState('')
  const [saveDisabled, setSaveDisabled] = useState(false)
  const [busy, setBusy] = useState(false)

  const latestRef = useRef({
    providers,
    configSource,
    chatActiveProviderId,
    chatActiveAnthropicModel,
  })
  const saveSeqRef = useRef(0)
  /** 相对磁盘是否有未落盘的本地编辑（用于切回窗口时是否静默重新拉取） */
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  /** 最近一次成功 load / save 的快照，用于「取消」恢复当前厂商条目 */
  const lastSyncedSnapshotRef = useRef<ClaudeAgentSettingsSnapshot | null>(null)
  const [lastSyncedSeq, setLastSyncedSeq] = useState(0)
  const [deleteConfirmDialogOpen, setDeleteConfirmDialogOpen] = useState(false)
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState('')
  const deleteConfirmDialogRef = useRef<HTMLDialogElement>(null)
  const effectiveConfigSource = IS_DEV_BUILD ? configSource : 'settings'

  useEffect(() => {
    latestRef.current = { providers, configSource, chatActiveProviderId, chatActiveAnthropicModel }
  }, [providers, configSource, chatActiveProviderId, chatActiveAnthropicModel])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const isDirty = useMemo(() => {
    const snap = lastSyncedSnapshotRef.current
    if (!snap) return false
    return isSettingsDirty(configSource, chatActiveProviderId, chatActiveAnthropicModel, providers, snap)
  }, [chatActiveAnthropicModel, chatActiveProviderId, configSource, providers, lastSyncedSeq])

  useEffect(() => {
    const snap = lastSyncedSnapshotRef.current
    dirtyRef.current = snap ? isSettingsDirty(configSource, chatActiveProviderId, chatActiveAnthropicModel, providers, snap) : false
  }, [chatActiveAnthropicModel, chatActiveProviderId, configSource, providers, lastSyncedSeq])

  const applySnapshot = useCallback((snapshot: ClaudeAgentSettingsSnapshot) => {
    const nextProviders = snapshot.settings.providers.length
      ? snapshot.settings.providers.map((provider) => ({ ...provider }))
      : [createModelProvider()]
    const nextChatActiveId = nextProviders.some((provider) => provider.id === snapshot.settings.activeProviderId)
      ? snapshot.settings.activeProviderId
      : nextProviders[0].id

    setConfigSource(IS_DEV_BUILD ? snapshot.settings.configSource : 'settings')
    setProviders(nextProviders)
    setChatActiveProviderId(nextChatActiveId)
    setChatActiveAnthropicModel(snapshot.settings.activeAnthropicModel ?? '')
    setExpandedProviderId((prev) =>
      nextProviders.some((provider) => provider.id === prev) ? prev : nextProviders[0]?.id ?? '',
    )
    setEnvStatusTags(createEnvStatusTags(snapshot, t))
  }, [t])

  const persist = useCallback(async () => {
    if (!window.claudeChat) {
      setStatus(t('settings.models.bridgeUnavailable'))
      return
    }
    const { providers: pList, configSource: src, chatActiveProviderId: chatId, chatActiveAnthropicModel: overlayRaw } =
      latestRef.current
    const nextProviders = pList.length ? pList : [createModelProvider()]
    const persistedChatId = nextProviders.some((provider) => provider.id === chatId)
      ? chatId
      : nextProviders[0].id
    const overlay = pruneStoredAnthropicOverlay(nextProviders, persistedChatId, overlayRaw)
    const payload: ClaudeAgentSettings = {
      configSource: IS_DEV_BUILD ? src : 'settings',
      activeProviderId: persistedChatId,
      activeAnthropicModel: overlay,
      providers: nextProviders,
    }

    const seq = ++saveSeqRef.current
    setBusy(true)
    setStatus(t('settings.models.saving'))
    try {
      const snapshot = await window.claudeChat.saveSettings(payload)
      if (seq !== saveSeqRef.current) return
      applySnapshot(snapshot)
      lastSyncedSnapshotRef.current = cloneSettingsSnapshot(snapshot)
      setLastSyncedSeq((n) => n + 1)
      window.dispatchEvent(new CustomEvent(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, { detail: snapshot }))
      setStatus(t('settings.models.saved'))
    } catch (error) {
      if (seq === saveSeqRef.current) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (seq === saveSeqRef.current) {
        setBusy(false)
      }
    }
  }, [applySnapshot, t])

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true
      if (!window.claudeChat) {
        setStatus(t('settings.models.bridgeUnavailable'))
        setSaveDisabled(true)
        return
      }
      if (!silent) {
        setStatus(t('settings.models.loading'))
      }
      try {
        const snapshot = await window.claudeChat.getSettings()
        applySnapshot(snapshot)
        lastSyncedSnapshotRef.current = cloneSettingsSnapshot(snapshot)
        setLastSyncedSeq((n) => n + 1)
        setSaveDisabled(false)
        if (!silent) {
          setStatus(t('settings.models.loaded'))
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    },
    [applySnapshot, t],
  )

  const addProvider = () => {
    const provider = createModelProvider()
    setProviders((current) => [...current, provider])
    setExpandedProviderId(provider.id)
    setStatus(t('settings.models.addedProvider'))
  }

  const removeProvider = useCallback(
    (providerId: string) => {
      if (providers.length <= 1) return

      const nextProviders = providers.filter((provider) => provider.id !== providerId)
      setProviders(nextProviders)
      setExpandedProviderId((prev) => (prev === providerId ? nextProviders[0]?.id ?? '' : prev))
      if (chatActiveProviderId === providerId) {
        setChatActiveProviderId(nextProviders[0]?.id ?? '')
      }
      setStatus(t('settings.models.removedProvider'))
    },
    [chatActiveProviderId, providers, t],
  )

  const confirmDeleteProvider = useCallback(() => {
    const id = pendingDeleteProviderId
    if (id) {
      removeProvider(id)
    }
    deleteConfirmDialogRef.current?.close()
  }, [pendingDeleteProviderId, removeProvider])

  const updateProvider = <K extends EditableProviderField>(
    providerId: string,
    field: K,
    value: ClaudeAgentModelProvider[K],
  ) => {
    setProviders((current) =>
      current.map((provider) => (provider.id === providerId ? { ...provider, [field]: value } : provider)),
    )
  }

  const toggleProviderExpanded = (providerId: string) => {
    setExpandedProviderId((prev) => (prev === providerId ? '' : providerId))
  }

  const cancelExpandedProviderEdits = useCallback(() => {
    const snap = lastSyncedSnapshotRef.current
    if (!snap || !expandedProviderId) return
    const eid = expandedProviderId
    const saved = snap.settings.providers.find((p) => p.id === eid)

    let nextProviders: ClaudeAgentModelProvider[]
    let nextChatActiveId = chatActiveProviderId

    if (saved) {
      nextProviders = providers.map((p) => (p.id === eid ? { ...saved } : p))
    } else if (providers.length > 1) {
      nextProviders = providers.filter((p) => p.id !== eid)
      if (chatActiveProviderId === eid) {
        nextChatActiveId = nextProviders[0]?.id ?? ''
      }
    } else {
      nextProviders =
        snap.settings.providers.length > 0
          ? snap.settings.providers.map((p) => ({ ...p }))
          : [createModelProvider()]
      nextChatActiveId = nextProviders[0]?.id ?? ''
    }

    setProviders(nextProviders)
    if (nextChatActiveId !== chatActiveProviderId) {
      setChatActiveProviderId(nextChatActiveId)
    }
    setStatus(t('settings.models.editorReverted'))
  }, [chatActiveProviderId, expandedProviderId, providers, t])

  useEffect(() => {
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<ClaudeAgentSettingsSnapshot>).detail
      const id = detail.settings.activeProviderId
      if (detail.settings.providers.some((provider) => provider.id === id)) {
        setChatActiveProviderId(id)
        setChatActiveAnthropicModel(detail.settings.activeAnthropicModel ?? '')
      }
    }
    window.addEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, onExternal)
    return () => window.removeEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, onExternal)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (dirtyRef.current || busyRef.current || saveDisabled) return
      void load({ silent: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load, saveDisabled])

  useEffect(() => {
    const el = deleteConfirmDialogRef.current
    if (!el) return
    if (deleteConfirmDialogOpen) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      el.close()
    }
  }, [deleteConfirmDialogOpen])

  const pendingDeleteProvider = useMemo(
    () => (pendingDeleteProviderId ? providers.find((p) => p.id === pendingDeleteProviderId) : undefined),
    [pendingDeleteProviderId, providers],
  )

  const openDeleteConfirmDialog = useCallback((providerId: string) => {
    setPendingDeleteProviderId(providerId)
    setDeleteConfirmDialogOpen(true)
  }, [])

  const closeDeleteConfirmDialog = useCallback(() => {
    setDeleteConfirmDialogOpen(false)
    setPendingDeleteProviderId('')
  }, [])

  return (
    <section className="app-main-inner settings-page settings-page--models" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">{t('settings.models.pageTitle')}</h1>
        <p className="settings-lede">{t('settings.models.pageLede')}</p>
      </header>

      <form
        className="settings-stack"
        id="claude-settings-form"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        {IS_DEV_BUILD ? (
          <section className="settings-section" aria-labelledby="settings-section-source-heading">
            <h2 id="settings-section-source-heading" className="settings-section-heading">
              {t('settings.models.configSource')}
            </h2>
            <div className="settings-group">
              <div className="settings-select-row">
                <div className="settings-field-row__meta">
                  <p className="settings-select-row__lede">
                    {configSource === 'settings'
                      ? t('settings.models.settingsFirstDesc')
                      : t('settings.models.envOnlyDesc')}
                  </p>
                </div>
                <div className="settings-select-wrap">
                  <select
                    id="claude-config-source"
                    className="settings-input settings-select"
                    value={configSource}
                    aria-labelledby="settings-section-source-heading"
                    aria-label={t('settings.models.configSourceRadiogroup')}
                    onChange={(event) => {
                      setConfigSource(event.target.value as ClaudeAgentConfigSource)
                    }}
                  >
                    <option value="settings">{t('settings.models.settingsFirst')}</option>
                    <option value="env">{t('settings.models.envOnly')}</option>
                  </select>
                  <span className="settings-select-wrap__chevron" aria-hidden>
                    <IconInline name="chevron" />
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {effectiveConfigSource === 'settings' ? (
          <section className="settings-section" aria-labelledby="settings-section-providers-heading">
            <div className="settings-section-header">
              <h2 id="settings-section-providers-heading" className="settings-section-heading">
                {t('settings.models.providersHeading')}
              </h2>
              <button type="button" className="btn btn-ghost btn-compact" onClick={addProvider}>
                <IconInline name="plus" />
                <span>{t('settings.models.add')}</span>
              </button>
            </div>
            <p className="settings-section-caption">{t('settings.models.providersCaption')}</p>
            <div className="settings-provider-list" role="list" aria-label={t('settings.models.providerListAria')}>
              {providers.map((provider) => {
                const isExpanded = provider.id === expandedProviderId
                const bodyId = `provider-body-${provider.id}`
                const triggerId = `provider-trigger-${provider.id}`
                const pid = provider.id
                const modelRows = [
                  {
                    field: 'defaultHaikuModel' as const,
                    supportField: 'defaultHaikuSupportsImages' as const,
                    inputId: `claude-haiku-model-${pid}`,
                    toggleId: `claude-haiku-images-${pid}`,
                    label: t('settings.models.fieldHaiku'),
                    hint: t('settings.models.fieldHaikuHint'),
                    placeholder: 'glm-4.7',
                    value: provider.defaultHaikuModel,
                    supportsImages: provider.defaultHaikuSupportsImages,
                  },
                  {
                    field: 'defaultSonnetModel' as const,
                    supportField: 'defaultSonnetSupportsImages' as const,
                    inputId: `claude-sonnet-model-${pid}`,
                    toggleId: `claude-sonnet-images-${pid}`,
                    label: t('settings.models.fieldSonnet'),
                    hint: t('settings.models.fieldSonnetHint'),
                    placeholder: 'glm-5',
                    value: provider.defaultSonnetModel,
                    supportsImages: provider.defaultSonnetSupportsImages,
                  },
                  {
                    field: 'defaultOpusModel' as const,
                    supportField: 'defaultOpusSupportsImages' as const,
                    inputId: `claude-opus-model-${pid}`,
                    toggleId: `claude-opus-images-${pid}`,
                    label: t('settings.models.fieldOpus'),
                    hint: t('settings.models.fieldOpusHint'),
                    placeholder: 'glm-5.1',
                    value: provider.defaultOpusModel,
                    supportsImages: provider.defaultOpusSupportsImages,
                  },
                ]
                return (
                  <div
                    key={provider.id}
                    className={['settings-provider-accordion', isExpanded ? 'is-expanded' : ''].filter(Boolean).join(' ')}
                    role="listitem"
                  >
                    <div className="settings-provider-row">
                      <button
                        type="button"
                        className="settings-provider-select"
                        id={triggerId}
                        aria-expanded={isExpanded}
                        aria-controls={bodyId}
                        onClick={() => toggleProviderExpanded(provider.id)}
                      >
                        <span className="settings-provider-chevron" aria-hidden="true">
                          <IconInline name="chevron" />
                        </span>
                        <span className="settings-provider-copy">
                          <span className="settings-provider-model">{providerDisplayName(provider, t)}</span>
                          <span className="settings-provider-meta">{providerMeta(provider, t)}</span>
                        </span>
                      </button>
                    </div>
                    {isExpanded ? (
                      <div
                        className="settings-provider-body"
                        id={bodyId}
                        role="region"
                        aria-labelledby={triggerId}
                      >
                        <h3 className="settings-provider-body__title">{t('settings.models.detailHeading')}</h3>
                        <p className="settings-section-caption settings-provider-body__caption">
                          {t('settings.models.detailCaption')}
                        </p>
                        <div className="settings-group settings-group--provider-fields">
                          <div className="settings-field-row">
                            <div className="settings-field-row__meta">
                              <label htmlFor={`claude-provider-name-${pid}`} className="settings-field-row__label">
                                <IconInline name="settings" />
                                {t('settings.models.fieldName')}
                              </label>
                              <p className="settings-field-row__hint">{t('settings.models.fieldNameHint')}</p>
                            </div>
                            <input
                              id={`claude-provider-name-${pid}`}
                              type="text"
                              className="settings-input"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={t('settings.models.fieldNamePlaceholder')}
                              value={provider.name}
                              onChange={(event) => updateProvider(pid, 'name', event.target.value)}
                            />
                          </div>
                          <div className="settings-field-row">
                            <div className="settings-field-row__meta">
                              <label htmlFor={`claude-api-key-${pid}`} className="settings-field-row__label">
                                <IconInline name="key" />
                                {t('settings.models.fieldApiKey')}
                              </label>
                              <p className="settings-field-row__hint">{t('settings.models.fieldApiKeyHint')}</p>
                            </div>
                            <input
                              id={`claude-api-key-${pid}`}
                              type="password"
                              className="settings-input"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="sk-ant-..."
                              value={provider.apiKey}
                              onChange={(event) => updateProvider(pid, 'apiKey', event.target.value)}
                            />
                          </div>
                          <div className="settings-field-row">
                            <div className="settings-field-row__meta">
                              <label htmlFor={`claude-base-url-${pid}`} className="settings-field-row__label">
                                <IconInline name="server" />
                                {t('settings.models.fieldBaseUrl')}
                              </label>
                              <p className="settings-field-row__hint">{t('settings.models.fieldBaseUrlHint')}</p>
                            </div>
                            <input
                              id={`claude-base-url-${pid}`}
                              type="url"
                              className="settings-input"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="https://open.bigmodel.cn/api/anthropic"
                              value={provider.baseUrl}
                              onChange={(event) => updateProvider(pid, 'baseUrl', event.target.value)}
                            />
                          </div>
                          <div className="settings-model-map" aria-label={t('settings.models.modelMappingsAria')}>
                            {modelRows.map((row) => (
                              <div className="settings-field-row settings-model-row" key={row.field}>
                                <div className="settings-field-row__meta">
                                  <label htmlFor={row.inputId} className="settings-field-row__label">
                                    <IconInline name="chip" />
                                    {row.label}
                                  </label>
                                  <p className="settings-field-row__hint">{row.hint}</p>
                                </div>
                                <input
                                  id={row.inputId}
                                  type="text"
                                  className="settings-input"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder={row.placeholder}
                                  value={row.value}
                                  onChange={(event) => updateProvider(pid, row.field, event.target.value)}
                                />
                                <label
                                  className="settings-model-image-toggle"
                                  title={t('settings.models.modelImageToggleTitle', { slot: row.label })}
                                >
                                  <span className="settings-model-image-toggle__glyph" aria-hidden="true">
                                    <IconInline name="image" />
                                  </span>
                                  <span className="settings-switch-control">
                                    <input
                                      id={row.toggleId}
                                      type="checkbox"
                                      className="settings-switch-input"
                                      checked={row.supportsImages}
                                      aria-label={t('settings.models.modelImageToggleAria', { slot: row.label })}
                                      onChange={(event) => updateProvider(pid, row.supportField, event.target.checked)}
                                    />
                                    <span className="settings-switch-track" aria-hidden="true">
                                      <span className="settings-switch-thumb" />
                                    </span>
                                  </span>
                                </label>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="settings-provider-body__actions" aria-label={t('settings.models.editorActionsAria')}>
                          <p className="settings-provider-body__actions-hint">{t('settings.models.editorActionsHint')}</p>
                          <div className="settings-provider-body__actions-row">
                            <button
                              type="button"
                              className="btn btn-primary btn-compact"
                              disabled={!isDirty || busy || saveDisabled}
                              onClick={() => void persist()}
                            >
                              {t('settings.models.editorConfirm')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-compact"
                              disabled={!isDirty || busy}
                              onClick={cancelExpandedProviderEdits}
                            >
                              {t('settings.models.editorCancel')}
                            </button>
                            <button
                              type="button"
                              className="settings-provider-delete-link"
                              disabled={providers.length <= 1 || busy}
                              title={providers.length <= 1 ? t('settings.models.deleteKeepOne') : undefined}
                              onClick={() => openDeleteConfirmDialog(pid)}
                            >
                              {t('settings.models.deleteProviderEntry')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        {effectiveConfigSource === 'env' ? (
          <section className="settings-section" aria-labelledby="settings-section-env-heading">
            <h2 id="settings-section-env-heading" className="settings-section-heading">
              {t('settings.models.envHeading')}
            </h2>
            <p id="settings-section-env-desc" className="settings-section-caption">
              {t('settings.models.envCaption')}
            </p>
            <ul className="settings-env-tags" aria-describedby="settings-section-env-desc">
              {envStatusTags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="settings-footer">
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={!isDirty || busy || saveDisabled}
              onClick={() => void persist()}
              aria-controls="claude-settings-form"
            >
              {t('settings.models.saveChanges')}
            </button>
            <span className="settings-status" id="claude-settings-status" role="status" aria-live="polite">
              {status}
            </span>
          </div>
        </div>
      </form>
      {effectiveConfigSource === 'settings' ? (
        <dialog
          ref={deleteConfirmDialogRef}
          className="settings-restart-dialog"
          aria-labelledby="claude-provider-delete-dialog-title"
          onClose={closeDeleteConfirmDialog}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              deleteConfirmDialogRef.current?.close()
            }
          }}
        >
          <div className="settings-restart-dialog__panel" onClick={(event) => event.stopPropagation()}>
            <h3 id="claude-provider-delete-dialog-title" className="settings-restart-dialog__title">
              {t('settings.models.deleteDialogTitle')}
            </h3>
            <p className="settings-restart-dialog__body">
              {pendingDeleteProvider
                ? t('settings.models.deleteDialogBody', { name: providerDisplayName(pendingDeleteProvider, t) })
                : t('settings.models.deleteDialogBodyFallback')}
            </p>
            <div className="settings-restart-dialog__actions">
              <button type="button" className="btn btn-ghost" onClick={() => deleteConfirmDialogRef.current?.close()}>
                {t('settings.models.deleteDialogDismiss')}
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmDeleteProvider}>
                {t('settings.models.deleteDialogConfirm')}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
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
  const pool = [provider.model, provider.defaultHaikuModel, provider.defaultSonnetModel, provider.defaultOpusModel]
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
    modelSupportsImages: false,
    defaultHaikuModel: '',
    defaultHaikuSupportsImages: false,
    defaultOpusModel: '',
    defaultOpusSupportsImages: false,
    defaultSonnetModel: '',
    defaultSonnetSupportsImages: false,
  }
}

function createProviderId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function providerDisplayName(
  provider: ClaudeAgentModelProvider,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string {
  return provider.model || provider.name || t('settings.models.unnamedModel')
}

function providerMeta(
  provider: ClaudeAgentModelProvider,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string {
  const parts = [
    provider.name && provider.model ? provider.name : '',
    provider.baseUrl,
    providerImageSupportSummary(provider, t),
    provider.apiKey ? t('settings.models.apiKeySet') : '',
  ].filter(Boolean)

  return parts.length ? parts.join(' · ') : t('settings.models.metaNoCredentials')
}

function providerImageSupportSummary(
  provider: ClaudeAgentModelProvider,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string {
  const rows = [
    { model: provider.defaultHaikuModel, supportsImages: provider.defaultHaikuSupportsImages },
    { model: provider.defaultSonnetModel, supportsImages: provider.defaultSonnetSupportsImages },
    { model: provider.defaultOpusModel, supportsImages: provider.defaultOpusSupportsImages },
  ].filter((row) => row.model.trim())
  const enabled = rows.filter((row) => row.supportsImages).length
  if (!enabled) return ''
  return t('settings.models.metaSupportsImageCount', { enabled, total: rows.length || 3 })
}

function createEnvStatusTags(
  snapshot: ClaudeAgentSettingsSnapshot,
  t: (path: string, vars?: Record<string, string | number>) => string,
): string[] {
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
      ? t('settings.models.envApiKeySet')
      : env.hasAuthToken
        ? t('settings.models.envAuthTokenSet')
        : t('settings.models.envCredentialsUnset'),
    env.baseUrl ? t('settings.models.envBaseUrlValue', { value: env.baseUrl }) : t('settings.models.envBaseUrlDefault'),
    env.model ? t('settings.models.envModelValue', { value: env.model }) : t('settings.models.envModelDefault'),
    env.supportsImages ? t('settings.models.envImagesOn') : t('settings.models.envImagesOff'),
    modelMapping ? t('settings.models.envMappingValue', { value: modelMapping }) : t('settings.models.envMappingDefault'),
  ]
}
