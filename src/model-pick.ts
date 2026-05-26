/**
 * Shared helpers for concrete provider/model picks used by composer, threads, and Skill settings.
 */

import type { ChatModelPick, ClaudeAgentModelProvider, ClaudeAgentSettings } from './claude-chat-types'

export type ModelPickMenuRow = {
  pickKey: string
  providerId: string
  anthropicModelId: string
  useOverlayPick: boolean
  supportsImages: boolean
  headline: string
  metaLine: string
}

export function buildModelPickRows(
  providers: ClaudeAgentModelProvider[],
  slots: { primary: string; haiku: string; sonnet: string; opus: string },
  fallbackLabel: string,
): ModelPickMenuRow[] {
  const rows: ModelPickMenuRow[] = []
  for (const provider of providers) {
    const seen = new Set<string>()
    const base = providerMenuSubtitle(provider)
    const add = (raw: string, slotLabel: string, useOverlayPick: boolean, supportsImages: boolean) => {
      const modelId = raw.trim()
      if (!modelId || seen.has(modelId)) return
      seen.add(modelId)
      rows.push({
        pickKey: modelPickKey({ providerId: provider.id, anthropicModel: modelId }),
        providerId: provider.id,
        anthropicModelId: modelId,
        useOverlayPick,
        supportsImages,
        headline: compactModelName(modelId, fallbackLabel),
        metaLine: [base || null, slotLabel].filter(Boolean).join(' · '),
      })
    }

    add(provider.model, slots.primary, false, providerSupportsImagesForModel(provider, provider.model, false))
    add(provider.defaultHaikuModel, slots.haiku, true, providerSupportsImagesForModel(provider, provider.defaultHaikuModel, false))
    add(provider.defaultSonnetModel, slots.sonnet, true, providerSupportsImagesForModel(provider, provider.defaultSonnetModel, false))
    add(provider.defaultOpusModel, slots.opus, true, providerSupportsImagesForModel(provider, provider.defaultOpusModel, false))
  }
  return rows
}

export function modelPickFromRow(row: ModelPickMenuRow): ChatModelPick {
  return { providerId: row.providerId, anthropicModel: row.anthropicModelId }
}

export function modelPickKey(pick: ChatModelPick): string {
  return `${pick.providerId}:${pick.anthropicModel}`
}

export function sameModelPick(a: ChatModelPick | undefined, b: ChatModelPick | undefined): boolean {
  return (a?.providerId ?? '') === (b?.providerId ?? '') && (a?.anthropicModel ?? '') === (b?.anthropicModel ?? '')
}

export function normalizeModelPick(value: unknown): ChatModelPick | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const anthropicModel = typeof record.anthropicModel === 'string' ? record.anthropicModel.trim() : ''
  if (!providerId || !anthropicModel) return undefined
  return { providerId, anthropicModel }
}

export function resolveEffectiveModelPick(
  settings: ClaudeAgentSettings,
  preferredPick?: ChatModelPick,
): ChatModelPick | undefined {
  const preferred = preferredPick ? validateModelPick(settings, preferredPick) : undefined
  return preferred ?? defaultModelPickForSettings(settings)
}

export function validateModelPick(
  settings: ClaudeAgentSettings,
  pick: ChatModelPick | undefined,
): ChatModelPick | undefined {
  if (!pick) return undefined
  const provider = settings.providers.find((item) => item.id === pick.providerId)
  if (!provider || !providerAcceptsAnthropicId(provider, pick.anthropicModel)) return undefined
  return { providerId: provider.id, anthropicModel: pick.anthropicModel.trim() }
}

export function defaultModelPickForSettings(settings: ClaudeAgentSettings): ChatModelPick | undefined {
  const activeProvider =
    settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  const activeModel = settings.activeAnthropicModel.trim()
  if (activeProvider) {
    if (activeModel && providerAcceptsAnthropicId(activeProvider, activeModel)) {
      return { providerId: activeProvider.id, anthropicModel: activeModel }
    }
    const first = firstModelForProvider(activeProvider)
    if (first) return { providerId: activeProvider.id, anthropicModel: first }
  }

  for (const provider of settings.providers) {
    const model = firstModelForProvider(provider)
    if (model) return { providerId: provider.id, anthropicModel: model }
  }
  return undefined
}

export function modelRowForPick(rows: ModelPickMenuRow[], pick: ChatModelPick | undefined): ModelPickMenuRow | undefined {
  if (!pick) return undefined
  return rows.find((row) => row.providerId === pick.providerId && row.anthropicModelId === pick.anthropicModel)
}

export function displayModelForPick(
  settings: ClaudeAgentSettings,
  pick: ChatModelPick | undefined,
  fallbackLabel: string,
): string {
  const valid = validateModelPick(settings, pick)
  if (valid) return valid.anthropicModel
  return fallbackLabel
}

export function supportsImagesForPick(
  settings: ClaudeAgentSettings,
  pick: ChatModelPick | undefined,
  fallback: boolean,
): boolean {
  const valid = validateModelPick(settings, pick)
  if (!valid) return fallback
  const provider = settings.providers.find((item) => item.id === valid.providerId)
  return provider ? providerSupportsImagesForModel(provider, valid.anthropicModel, fallback) : fallback
}

export function providerAcceptsAnthropicId(provider: ClaudeAgentModelProvider, modelId: string): boolean {
  const normalized = modelId.trim()
  if (!normalized) return false
  return [
    provider.model,
    provider.defaultHaikuModel,
    provider.defaultSonnetModel,
    provider.defaultOpusModel,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(normalized)
}

export function providerSupportsImagesForModel(
  provider: ClaudeAgentModelProvider,
  modelId: string,
  fallback: boolean,
): boolean {
  const normalized = modelId.trim()
  if (!normalized) return fallback
  const matches = [
    { model: provider.model, supportsImages: provider.modelSupportsImages },
    { model: provider.defaultHaikuModel, supportsImages: provider.defaultHaikuSupportsImages },
    { model: provider.defaultSonnetModel, supportsImages: provider.defaultSonnetSupportsImages },
    { model: provider.defaultOpusModel, supportsImages: provider.defaultOpusSupportsImages },
  ].filter((row) => row.model.trim() === normalized)
  if (!matches.length) return fallback
  return matches.some((row) => row.supportsImages)
}

export function compactModelName(model: string, fallbackLabel: string): string {
  if (!/^claude-/i.test(model)) return model || fallbackLabel
  return model
    .replace(/^claude-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b(\w)/g, (letter) => letter.toUpperCase())
}

function firstModelForProvider(provider: ClaudeAgentModelProvider): string {
  return [
    provider.model,
    provider.defaultSonnetModel,
    provider.defaultOpusModel,
    provider.defaultHaikuModel,
  ]
    .map((value) => value.trim())
    .find(Boolean) ?? ''
}

function providerMenuSubtitle(provider: ClaudeAgentModelProvider): string {
  const parts = [
    provider.name.trim() && provider.model.trim() && provider.name.trim() !== provider.model.trim()
      ? provider.name.trim()
      : '',
    provider.baseUrl.trim(),
  ].filter(Boolean)
  return parts.join(' · ')
}
