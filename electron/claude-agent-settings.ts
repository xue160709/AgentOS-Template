/**
 * Claude Agent 凭据与模型映射的持久化及解析（userData JSON）。
 * Persist and resolve Claude Agent credentials/model maps from userData JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ActiveChatPickPayload,
  ClaudeAgentConfigSource,
  ClaudeAgentEnvSnapshot,
  ClaudeAgentModelProvider,
  ClaudeAgentResolvedConfig,
  ClaudeAgentSettings,
  ClaudeAgentSettingsSnapshot,
} from '../src/claude-chat-types'

const SETTINGS_FILE_NAME = 'claude-agent-settings.json'
const DEFAULT_PROVIDER_ID = 'default-provider'

/** `claude-agent-settings.json` 读写与 env/settings 融合解析 / Settings store merging env vs UI sources */
export class ClaudeAgentSettingsStore {
  private readonly settingsFilePath: string

  constructor(userDataPath: string) {
    this.settingsFilePath = path.join(userDataPath, SETTINGS_FILE_NAME)
    console.info('[ClaudeAgentSettingsStore] using settings file', this.settingsFilePath)
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
      return normalizeSettings(raw)
    } catch {
      return createDefaultSettings()
    }
  }

  save(settings: unknown): ClaudeAgentSettingsSnapshot {
    const normalized = normalizeSettings(settings)
    mkdirSync(path.dirname(this.settingsFilePath), { recursive: true })
    writeFileSync(this.settingsFilePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    console.info('[ClaudeAgentSettingsStore] saved settings', summarizeSettingsForLog(normalized))
    return this.getSnapshot()
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

  resolve(): ClaudeAgentResolvedConfig {
    const settings = this.read()
    const env = this.getEnvSnapshot()

    if (settings.configSource === 'env') {
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
      console.info('[ClaudeAgentSettingsStore] resolved env config', summarizeResolvedConfigForLog(resolved))
      return resolved
    }

    const provider = selectActiveProvider(settings)
    const providerApiKey = provider?.apiKey ?? ''
    const envApiKey = readEnv('ANTHROPIC_API_KEY')

    const overlay = normalizeString(settings.activeAnthropicModel)
    const primaryModel = normalizeString(provider?.model ?? '')
    const effectiveOverlay =
      overlay && provider && providerAcceptsModel(provider, overlay) ? overlay : ''
    const resolvedModel = effectiveOverlay || primaryModel || env.model

    const resolved: ClaudeAgentResolvedConfig = {
      configSource: 'settings',
      apiKey: providerApiKey || envApiKey,
      authToken: providerApiKey || envApiKey ? '' : readEnv('ANTHROPIC_AUTH_TOKEN'),
      baseUrl: provider?.baseUrl || env.baseUrl,
      model: resolvedModel,
      supportsImages: provider
        ? providerSupportsImagesForModel(provider, resolvedModel, env.supportsImages)
        : env.supportsImages,
      defaultHaikuModel: provider?.defaultHaikuModel || env.defaultHaikuModel,
      defaultOpusModel: provider?.defaultOpusModel || env.defaultOpusModel,
      defaultSonnetModel: provider?.defaultSonnetModel || env.defaultSonnetModel,
    }
    console.info('[ClaudeAgentSettingsStore] resolved settings config', {
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
      envFallbacks: {
        hasEnvApiKey: Boolean(envApiKey),
        envBaseUrl: env.baseUrl,
        envModel: env.model,
      },
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

function normalizeSettings(raw: unknown): ClaudeAgentSettings {
  if (!isRecord(raw)) return createDefaultSettings()

  const configSource = normalizeSource(raw.configSource)
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

  const providers = normalized.length ? normalized : [createDefaultProvider()]
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

  return {
    id: normalizeString(raw.id) || fallbackId,
    name: normalizeString(raw.name) || normalizeString(raw.label) || normalizeString(raw.providerName),
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
  const provider = createDefaultProvider()
  return {
    configSource: 'settings',
    activeProviderId: provider.id,
    activeAnthropicModel: '',
    providers: [provider],
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

function normalizeSource(value: unknown): ClaudeAgentConfigSource {
  return value === 'env' ? 'env' : 'settings'
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
      name: provider.name,
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
