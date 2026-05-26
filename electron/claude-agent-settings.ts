/**
 * Claude Agent 凭据与模型映射的持久化及解析（userData JSON）。
 * Persist and resolve Claude Agent credentials/model maps from userData JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ActiveChatPickPayload,
  ChatModelPick,
  ClaudeAgentConfigSource,
  ClaudeAgentEnvSnapshot,
  ClaudeAgentModelProvider,
  ClaudeAgentProviderAuthMode,
  ClaudeAgentProviderTestResult,
  ClaudeAgentResolvedConfig,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../src/claude-chat-types'
import { safeConsoleInfo } from './safe-console'
import providerPresetCatalog from '../src/model-provider-presets.json'

const SETTINGS_FILE_NAME = 'claude-agent-settings.json'
const DEFAULT_PROVIDER_ID = 'default-provider'

/** `claude-agent-settings.json` 读写与 env/settings 融合解析 / Settings store merging env vs UI sources */
export class ClaudeAgentSettingsStore {
  private readonly settingsFilePath: string
  private readonly allowEnvConfigSource: boolean

  constructor(userDataPath: string, options?: { allowEnvConfigSource?: boolean }) {
    this.settingsFilePath = path.join(userDataPath, SETTINGS_FILE_NAME)
    this.allowEnvConfigSource = options?.allowEnvConfigSource ?? true
    safeConsoleInfo('[ClaudeAgentSettingsStore] using settings file', this.settingsFilePath)
  }

  getSnapshot(): ClaudeAgentSettingsSnapshot {
    return {
      settings: this.read(),
      env: this.getEnvSnapshot(),
    }
  }

  read(): ClaudeAgentSettings {
    if (!existsSync(this.settingsFilePath)) return createDefaultSettings()

    try {
      const raw = JSON.parse(readFileSync(this.settingsFilePath, 'utf8')) as unknown
      return normalizeSettings(raw, this.allowEnvConfigSource)
    } catch {
      return createDefaultSettings()
    }
  }

  save(settings: unknown): ClaudeAgentSettingsSnapshot {
    const normalized = normalizeSettings(settings, this.allowEnvConfigSource)
    mkdirSync(path.dirname(this.settingsFilePath), { recursive: true })
    writeFileSync(this.settingsFilePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    safeConsoleInfo('[ClaudeAgentSettingsStore] saved settings', summarizeSettingsForLog(normalized))
    return this.getSnapshot()
  }

  async testProvider(provider: unknown): Promise<ClaudeAgentProviderTestResult> {
    const normalized = normalizeProvider(provider, 'test-provider')
    if (!normalized) {
      return { ok: false, message: '配置格式无效。' }
    }

    const apiKey = normalizeString(normalized.apiKey)
    const baseUrl = normalizeString(normalized.baseUrl)
    const model = selectProviderTestModel(normalized)
    if (!apiKey) return { ok: false, message: '请先填写 API Key。' }
    if (!baseUrl) return { ok: false, message: '请先填写 Base URL。' }
    if (!model) return { ok: false, message: '请至少填写一个可测试的模型。' }

    let endpoint: string
    try {
      endpoint = buildAnthropicMessagesEndpoint(baseUrl)
    } catch {
      return { ok: false, message: 'Base URL 不是有效的 HTTP(S) 地址。' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }
    if (normalized.authMode === 'authToken') {
      headers.authorization = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: controller.signal,
      })
      if (response.ok) {
        return { ok: true, status: response.status, message: `连接成功，已验证 ${model}。` }
      }
      const message = await readProviderTestError(response)
      return {
        ok: false,
        status: response.status,
        message: message ? `连接失败（${response.status}）：${message}` : `连接失败（${response.status}）。`,
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '连接超时，请检查网络、Base URL 或厂商服务状态。'
          : error instanceof Error
            ? error.message
            : String(error)
      return { ok: false, message }
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 仅切换当前提供商与可选模型 ID（聊天下拉）/ Switch active provider and optional concrete model id from chat picker */
  setActiveChatPick(payload: ActiveChatPickPayload): ClaudeAgentSettingsSnapshot {
    const settings = this.read()
    const id = normalizeString(payload.providerId)
    const provider = settings.providers.find((p) => p.id === id)
    if (!id || !provider) {
      throw new Error(`Unknown provider id: ${payload.providerId}`)
    }
    const incoming = payload.anthropicModel != null ? normalizeString(payload.anthropicModel) : ''
    const primaryModel = normalizeString(provider.model)
    let activeAnthropicModel = ''
    if (incoming && providerAcceptsModel(provider, incoming)) {
      activeAnthropicModel = incoming === primaryModel ? '' : incoming
    }
    return this.save({ ...settings, activeProviderId: id, activeAnthropicModel })
  }

  resolve(modelPick?: ChatModelPick): ClaudeAgentResolvedConfig {
    const settings = this.read()
    const env = this.getEnvSnapshot()

    const pickedProvider = modelPick ? selectProviderForPick(settings, modelPick) : undefined
    if (pickedProvider) {
      const resolved = resolveProviderConfig(pickedProvider.provider, pickedProvider.model)
      safeConsoleInfo('[ClaudeAgentSettingsStore] resolved model-pick config', {
        settingsFilePath: this.settingsFilePath,
        requestedProviderId: modelPick?.providerId ?? '',
        requestedModel: modelPick?.anthropicModel ?? '',
        providerName: pickedProvider.provider.name,
        resolved: summarizeResolvedConfigForLog(resolved),
      })
      return resolved
    }

    if (this.allowEnvConfigSource && settings.configSource === 'env') {
      const resolved: ClaudeAgentResolvedConfig = {
        configSource: 'env',
        apiKey: readEnv('ANTHROPIC_API_KEY'),
        authToken: readEnv('ANTHROPIC_AUTH_TOKEN'),
        baseUrl: env.baseUrl,
        model: env.model,
        supportsImages: env.supportsImages,
        defaultHaikuModel: env.defaultHaikuModel,
        defaultOpusModel: env.defaultOpusModel,
        defaultSonnetModel: env.defaultSonnetModel,
      }
      safeConsoleInfo('[ClaudeAgentSettingsStore] resolved env config', summarizeResolvedConfigForLog(resolved))
      return resolved
    }

    const provider = selectActiveProvider(settings)
    const overlay = normalizeString(settings.activeAnthropicModel)
    const primaryModel = normalizeString(provider?.model ?? '')
    const effectiveOverlay =
      overlay && provider && providerAcceptsModel(provider, overlay) ? overlay : ''
    const resolvedModel = effectiveOverlay || primaryModel

    const resolved = provider ? resolveProviderConfig(provider, resolvedModel) : {
      configSource: 'settings' as ClaudeAgentConfigSource,
      apiKey: '',
      authToken: '',
      baseUrl: '',
      model: '',
      supportsImages: false,
      defaultHaikuModel: '',
      defaultOpusModel: '',
      defaultSonnetModel: '',
    }
    safeConsoleInfo('[ClaudeAgentSettingsStore] resolved settings config', {
      settingsFilePath: this.settingsFilePath,
      activeProviderId: settings.activeProviderId,
      activeProviderName: provider?.name || '',
      activeAnthropicModel: settings.activeAnthropicModel,
      providerModels: {
        model: provider?.model || '',
        haiku: provider?.defaultHaikuModel || '',
        sonnet: provider?.defaultSonnetModel || '',
        opus: provider?.defaultOpusModel || '',
      },
      resolved: summarizeResolvedConfigForLog(resolved),
    })
    return resolved
  }

  private getEnvSnapshot(): ClaudeAgentEnvSnapshot {
    return {
      hasApiKey: Boolean(readEnv('ANTHROPIC_API_KEY')),
      hasAuthToken: Boolean(readEnv('ANTHROPIC_AUTH_TOKEN')),
      baseUrl: readEnv('ANTHROPIC_BASE_URL'),
      model: readEnv('ANTHROPIC_MODEL') || readEnv('CLAUDE_MODEL'),
      supportsImages: readEnvBoolean('ANTHROPIC_SUPPORTS_IMAGES', true),
      defaultHaikuModel: readEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
      defaultOpusModel: readEnv('ANTHROPIC_DEFAULT_OPUS_MODEL'),
      defaultSonnetModel: readEnv('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    }
  }
}

function resolveProviderConfig(provider: ClaudeAgentModelProvider, model: string): ClaudeAgentResolvedConfig {
  const providerApiKey = provider.apiKey ?? ''
  return {
    configSource: 'settings',
    apiKey: providerApiKey
      ? provider.authMode === 'authToken'
        ? ''
        : providerApiKey
      : '',
    authToken: providerApiKey
      ? provider.authMode === 'authToken'
        ? providerApiKey
        : ''
      : '',
    baseUrl: provider.baseUrl || '',
    model: model || provider.model || '',
    supportsImages: providerSupportsImagesForModel(provider, model || provider.model || '', false),
    defaultHaikuModel: provider.defaultHaikuModel || '',
    defaultOpusModel: provider.defaultOpusModel || '',
    defaultSonnetModel: provider.defaultSonnetModel || '',
  }
}

function selectProviderForPick(
  settings: ClaudeAgentSettings,
  pick: ChatModelPick,
): { provider: ClaudeAgentModelProvider; model: string } | undefined {
  const provider = settings.providers.find((item) => item.id === normalizeString(pick.providerId))
  const model = normalizeString(pick.anthropicModel)
  if (!provider || !model || !providerAcceptsModel(provider, model)) return undefined
  return { provider, model }
}

function normalizeSettings(raw: unknown, allowEnvConfigSource: boolean): ClaudeAgentSettings {
  if (!isRecord(raw)) return createDefaultSettings()

  const configSource = normalizeSource(raw.configSource, allowEnvConfigSource)
  const providers = normalizeProviders(raw)
  const activeProviderId = providers.some((provider) => provider.id === normalizeString(raw.activeProviderId))
    ? normalizeString(raw.activeProviderId)
    : providers[0].id

  const activeAnthropicModelRaw = normalizeString(raw.activeAnthropicModel)

  return pruneSettings({
    configSource,
    activeProviderId,
    activeAnthropicModel: activeAnthropicModelRaw,
    providers,
  })
}

function normalizeProviders(raw: Record<string, unknown>): ClaudeAgentModelProvider[] {
  const normalized = Array.isArray(raw.providers)
    ? raw.providers
        .map((provider, index) => normalizeProvider(provider, `provider-${index + 1}`))
        .filter((provider): provider is ClaudeAgentModelProvider => Boolean(provider))
    : [normalizeProvider(raw, DEFAULT_PROVIDER_ID)].filter((provider): provider is ClaudeAgentModelProvider =>
        Boolean(provider),
      )

  const providers = normalized.length ? normalized : createDefaultProviders()
  return dedupeProviderIds(providers)
}

function normalizeProvider(raw: unknown, fallbackId: string): ClaudeAgentModelProvider | undefined {
  if (!isRecord(raw)) return undefined

  const legacySupportsImages = normalizeBoolean(raw.supportsImages, false)
  const apiKey =
    normalizeString(raw.apiKey) ||
    normalizeString(raw.ANTHROPIC_API_KEY) ||
    normalizeString(raw.authToken) ||
    normalizeString(raw.ANTHROPIC_AUTH_TOKEN)
  const authMode = normalizeAuthMode(
    raw.authMode,
    normalizeString(raw.authToken) || normalizeString(raw.ANTHROPIC_AUTH_TOKEN) ? 'authToken' : 'apiKey',
  )

  return {
    id: normalizeString(raw.id) || fallbackId,
    presetId: normalizeString(raw.presetId),
    name:
      normalizeLocalizedString(raw.name) ||
      normalizeString(raw.label) ||
      normalizeString(raw.providerName),
    apiKeyUrl: normalizeString(raw.apiKeyUrl),
    authMode,
    apiKey,
    authToken: '',
    baseUrl: normalizeString(raw.baseUrl) || normalizeString(raw.ANTHROPIC_BASE_URL),
    model: normalizeString(raw.model) || normalizeString(raw.ANTHROPIC_MODEL),
    modelSupportsImages: normalizeBoolean(raw.modelSupportsImages, legacySupportsImages),
    defaultHaikuModel:
      normalizeString(raw.defaultHaikuModel) || normalizeString(raw.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    defaultHaikuSupportsImages: normalizeBoolean(raw.defaultHaikuSupportsImages, legacySupportsImages),
    defaultOpusModel: normalizeString(raw.defaultOpusModel) || normalizeString(raw.ANTHROPIC_DEFAULT_OPUS_MODEL),
    defaultOpusSupportsImages: normalizeBoolean(raw.defaultOpusSupportsImages, legacySupportsImages),
    defaultSonnetModel:
      normalizeString(raw.defaultSonnetModel) || normalizeString(raw.ANTHROPIC_DEFAULT_SONNET_MODEL),
    defaultSonnetSupportsImages: normalizeBoolean(raw.defaultSonnetSupportsImages, legacySupportsImages),
  }
}

function dedupeProviderIds(providers: ClaudeAgentModelProvider[]): ClaudeAgentModelProvider[] {
  const seen = new Set<string>()

  return providers.map((provider, index) => {
    let id = provider.id || `provider-${index + 1}`
    if (seen.has(id)) id = `${id}-${index + 1}`
    seen.add(id)
    return { ...provider, id }
  })
}

function selectActiveProvider(settings: ClaudeAgentSettings): ClaudeAgentModelProvider | undefined {
  return (
    settings.providers.find((provider) => provider.id === settings.activeProviderId) ??
    settings.providers[0]
  )
}

function createDefaultSettings(): ClaudeAgentSettings {
  const providers = createDefaultProviders()
  const provider = providers[0]
  return {
    configSource: 'settings',
    activeProviderId: provider.id,
    activeAnthropicModel: '',
    providers,
  }
}

function pruneSettings(settings: ClaudeAgentSettings): ClaudeAgentSettings {
  const provider = selectActiveProvider(settings)
  const overlay = normalizeString(settings.activeAnthropicModel)
  if (!overlay || !provider || !providerAcceptsModel(provider, overlay)) {
    return { ...settings, activeAnthropicModel: '' }
  }
  const primary = normalizeString(provider.model)
  return {
    ...settings,
    activeAnthropicModel: overlay === primary ? '' : overlay,
  }
}

function createDefaultProvider(): ClaudeAgentModelProvider {
  return {
    id: DEFAULT_PROVIDER_ID,
    presetId: '',
    name: '',
    apiKeyUrl: '',
    authMode: 'apiKey',
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

function createDefaultProviders(): ClaudeAgentModelProvider[] {
  const rawProviders = isRecord(providerPresetCatalog) && Array.isArray(providerPresetCatalog.providers)
    ? providerPresetCatalog.providers
    : []
  const providers = rawProviders
    .map((provider, index) => normalizeProvider(provider, `provider-${index + 1}`))
    .filter((provider): provider is ClaudeAgentModelProvider => Boolean(provider))
  return providers.length ? dedupeProviderIds(providers) : [createDefaultProvider()]
}

function normalizeSource(value: unknown, allowEnvConfigSource: boolean): ClaudeAgentConfigSource {
  if (!allowEnvConfigSource) return 'settings'
  return value === 'env' ? 'env' : 'settings'
}

function normalizeAuthMode(value: unknown, fallback: ClaudeAgentProviderAuthMode): ClaudeAgentProviderAuthMode {
  return value === 'authToken' || value === 'apiKey' ? value : fallback
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLocalizedString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  return normalizeString(value.zh) || normalizeString(value.en)
}

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  const raw = readEnv(name).toLowerCase()
  if (!raw) return fallback
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return fallback
}

function summarizeSettingsForLog(settings: ClaudeAgentSettings): Record<string, unknown> {
  const activeProvider = selectActiveProvider(settings)
  return {
    configSource: settings.configSource,
    activeProviderId: settings.activeProviderId,
    activeProviderName: activeProvider?.name || '',
    activeAnthropicModel: settings.activeAnthropicModel,
    providerCount: settings.providers.length,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      presetId: provider.presetId,
      name: provider.name,
      apiKeyUrl: provider.apiKeyUrl,
      authMode: provider.authMode,
      hasApiKey: Boolean(provider.apiKey),
      apiKey: redactSecret(provider.apiKey),
      baseUrl: provider.baseUrl,
      model: provider.model,
      defaultHaikuModel: provider.defaultHaikuModel,
      defaultSonnetModel: provider.defaultSonnetModel,
      defaultOpusModel: provider.defaultOpusModel,
      imageSupport: {
        model: provider.modelSupportsImages,
        haiku: provider.defaultHaikuSupportsImages,
        sonnet: provider.defaultSonnetSupportsImages,
        opus: provider.defaultOpusSupportsImages,
      },
    })),
  }
}

function summarizeResolvedConfigForLog(config: ClaudeAgentResolvedConfig): Record<string, unknown> {
  return {
    configSource: config.configSource,
    hasApiKey: Boolean(config.apiKey),
    apiKey: redactSecret(config.apiKey),
    hasAuthToken: Boolean(config.authToken),
    authToken: redactSecret(config.authToken),
    baseUrl: config.baseUrl,
    model: config.model,
    supportsImages: config.supportsImages,
    defaultHaikuModel: config.defaultHaikuModel,
    defaultSonnetModel: config.defaultSonnetModel,
    defaultOpusModel: config.defaultOpusModel,
  }
}

function redactSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return `***(${trimmed.length})`
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}(${trimmed.length})`
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function providerAcceptsModel(provider: ClaudeAgentModelProvider, modelId: string): boolean {
  const m = normalizeString(modelId)
  if (!m) return false
  const candidates = [
    normalizeString(provider.model),
    normalizeString(provider.defaultHaikuModel),
    normalizeString(provider.defaultSonnetModel),
    normalizeString(provider.defaultOpusModel),
  ].filter(Boolean)
  return candidates.includes(m)
}

function providerSupportsImagesForModel(
  provider: ClaudeAgentModelProvider,
  modelId: string,
  fallback: boolean,
): boolean {
  const m = normalizeString(modelId)
  if (!m) return fallback
  const matches = [
    { model: provider.model, supportsImages: provider.modelSupportsImages },
    { model: provider.defaultHaikuModel, supportsImages: provider.defaultHaikuSupportsImages },
    { model: provider.defaultSonnetModel, supportsImages: provider.defaultSonnetSupportsImages },
    { model: provider.defaultOpusModel, supportsImages: provider.defaultOpusSupportsImages },
  ].filter((row) => normalizeString(row.model) === m)
  if (!matches.length) return fallback
  return matches.some((row) => row.supportsImages)
}

function selectProviderTestModel(provider: ClaudeAgentModelProvider): string {
  return [
    provider.model,
    provider.defaultSonnetModel,
    provider.defaultOpusModel,
    provider.defaultHaikuModel,
  ]
    .map((value) => normalizeString(value))
    .find(Boolean) ?? ''
}

function buildAnthropicMessagesEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Unsupported protocol')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith('/v1') ? `${pathname}/messages` : `${pathname}/v1/messages`
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function readProviderTestError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as unknown
      const message = findProviderErrorMessage(data)
      if (message) return message.slice(0, 300)
    }
    const text = await response.text()
    return text.trim().replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

function findProviderErrorMessage(value: unknown): string {
  if (!isRecord(value)) return ''
  const direct = normalizeString(value.message)
  if (direct) return direct
  const error = value.error
  if (typeof error === 'string') return error.trim()
  if (isRecord(error)) {
    return normalizeString(error.message) || normalizeString(error.type) || normalizeString(error.code)
  }
  return ''
}
