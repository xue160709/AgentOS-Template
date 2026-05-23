/**
 * Shared model-provider preset helpers for Settings and first-run setup.
 * 模型厂商预置共享工具：供设置页与首次初始化复用。
 */

import type { ClaudeAgentModelProvider, ClaudeAgentProviderAuthMode } from './claude-chat-types'
import type { AppLocale } from './i18n/i18n'
import localProviderPresetCatalog from './model-provider-presets.json'

export type ProviderPreset = {
  id: string
  name: string
  nameCandidates: string[]
  apiKeyUrl: string
  authMode: ClaudeAgentProviderAuthMode
  baseUrl: string
  model: string
  modelSupportsImages: boolean
  defaultHaikuModel: string
  defaultHaikuSupportsImages: boolean
  defaultOpusModel: string
  defaultOpusSupportsImages: boolean
  defaultSonnetModel: string
  defaultSonnetSupportsImages: boolean
}

export type ProviderPresetCatalog = {
  version: string
  providers: ProviderPreset[]
}

export const LOCAL_PROVIDER_PRESET_CATALOG = localProviderPresetCatalog as unknown as ProviderPresetCatalog

export function createModelProvider(preset?: ProviderPreset): ClaudeAgentModelProvider {
  return {
    id: createProviderId(),
    presetId: preset?.id ?? '',
    name: preset?.name ?? '',
    apiKeyUrl: preset?.apiKeyUrl ?? '',
    authMode: preset?.authMode ?? 'apiKey',
    apiKey: '',
    authToken: '',
    baseUrl: preset?.baseUrl ?? '',
    model: preset?.model ?? '',
    modelSupportsImages: preset?.modelSupportsImages ?? false,
    defaultHaikuModel: preset?.defaultHaikuModel ?? '',
    defaultHaikuSupportsImages: preset?.defaultHaikuSupportsImages ?? false,
    defaultOpusModel: preset?.defaultOpusModel ?? '',
    defaultOpusSupportsImages: preset?.defaultOpusSupportsImages ?? false,
    defaultSonnetModel: preset?.defaultSonnetModel ?? '',
    defaultSonnetSupportsImages: preset?.defaultSonnetSupportsImages ?? false,
  }
}

export function normalizePresetCatalog(raw: unknown, locale: AppLocale): ProviderPresetCatalog {
  const fallbackProviders = Array.isArray(LOCAL_PROVIDER_PRESET_CATALOG.providers)
    ? LOCAL_PROVIDER_PRESET_CATALOG.providers
        .map((provider) => normalizeProviderPreset(provider, locale))
        .filter((preset): preset is ProviderPreset => Boolean(preset))
    : []
  if (!isRecord(raw)) {
    return { version: LOCAL_PROVIDER_PRESET_CATALOG.version, providers: fallbackProviders }
  }
  const version = normalizePresetString(raw.version) || LOCAL_PROVIDER_PRESET_CATALOG.version
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map((provider) => normalizeProviderPreset(provider, locale)).filter((preset): preset is ProviderPreset => Boolean(preset))
    : []
  return {
    version,
    providers: providers.length ? providers : fallbackProviders,
  }
}

export function localizeProviderPresetName(
  provider: ClaudeAgentModelProvider,
  presets: ProviderPreset[],
): ClaudeAgentModelProvider {
  const preset = presets.find((item) => item.id === provider.presetId)
  if (!preset) return { ...provider }
  if (provider.name && !preset.nameCandidates.includes(provider.name)) return { ...provider }
  return { ...provider, name: preset.name }
}

function createProviderId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeProviderPreset(raw: unknown, locale: AppLocale): ProviderPreset | undefined {
  if (!isRecord(raw)) return undefined
  const id = normalizePresetString(raw.id)
  const name = normalizeLocalizedPresetName(raw.name, locale)
  const baseUrl = normalizePresetString(raw.baseUrl)
  if (!id || !name || !baseUrl) return undefined
  const supportsImages = normalizePresetBoolean(raw.supportsImages, false)
  return {
    id,
    name,
    nameCandidates: getLocalizedPresetNameCandidates(raw.name),
    apiKeyUrl: normalizePresetString(raw.apiKeyUrl),
    authMode: raw.authMode === 'authToken' ? 'authToken' : 'apiKey',
    baseUrl,
    model: normalizePresetString(raw.model),
    modelSupportsImages: normalizePresetBoolean(raw.modelSupportsImages, supportsImages),
    defaultHaikuModel: normalizePresetString(raw.defaultHaikuModel),
    defaultHaikuSupportsImages: normalizePresetBoolean(raw.defaultHaikuSupportsImages, supportsImages),
    defaultOpusModel: normalizePresetString(raw.defaultOpusModel),
    defaultOpusSupportsImages: normalizePresetBoolean(raw.defaultOpusSupportsImages, supportsImages),
    defaultSonnetModel: normalizePresetString(raw.defaultSonnetModel),
    defaultSonnetSupportsImages: normalizePresetBoolean(raw.defaultSonnetSupportsImages, supportsImages),
  }
}

function normalizeLocalizedPresetName(value: unknown, locale: AppLocale): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  return normalizePresetString(value[locale]) || normalizePresetString(value.zh) || normalizePresetString(value.en)
}

function getLocalizedPresetNameCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean)
  if (!isRecord(value)) return []
  return [normalizePresetString(value.zh), normalizePresetString(value.en)].filter(Boolean)
}

function normalizePresetString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePresetBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
