/**
 * Agent Mode 项目设置持久化（开关与 USER/IDENTITY 回退读取）。
 * Persist Agent Mode per-project toggles with USER/IDENTITY.md fallbacks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatModelPick } from '../src/claude-chat-types'
import type { AgentModeProjectSettings, AgentModeSettingsResult } from '../src/desktop-types'

type StoredAgentModeSettings = {
  enabled?: boolean
  todoEnabled?: boolean
  user?: string
  identity?: string
  projectModelPick?: ChatModelPick
  skillModelOverrides?: Record<string, ChatModelPick>
}

type AgentModeSettingsFile = {
  projects: Record<string, StoredAgentModeSettings>
}

const SETTINGS_FILE_NAME = 'agent-mode-settings.json'

/** userData 中的 Agent Mode 设置仓库 / Agent Mode settings store in userData */
export class AgentModeSettingsStore {
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, SETTINGS_FILE_NAME)
  }

  async getResult(rootPath: string): Promise<AgentModeSettingsResult> {
    const root = resolveWorkspacePath(rootPath)
    try {
      return {
        ok: true,
        rootPath: root,
        settings: await this.resolve(root),
      }
    } catch (error) {
      return {
        ok: false,
        rootPath: root,
        message: error instanceof Error ? error.message : '无法读取 Agent 模式设置',
      }
    }
  }

  async resolve(rootPath: string): Promise<AgentModeProjectSettings> {
    const root = resolveWorkspacePath(rootPath)
    const stored = this.readEntry(root)
    return {
      enabled: stored.enabled === true,
      todoEnabled: stored.todoEnabled === true,
      user: typeof stored.user === 'string' ? stored.user : await readOptionalText(path.join(root, 'USER.md')),
      identity:
        typeof stored.identity === 'string' ? stored.identity : await readOptionalText(path.join(root, 'IDENTITY.md')),
      projectModelPick: stored.projectModelPick,
      skillModelOverrides: stored.skillModelOverrides ?? {},
    }
  }

  async saveSettings(rootPath: string, payload: Partial<Pick<AgentModeProjectSettings, 'user' | 'identity' | 'projectModelPick' | 'skillModelOverrides'>>): Promise<AgentModeSettingsResult> {
    return this.save(rootPath, {
      ...(typeof payload.user === 'string' ? { user: payload.user } : {}),
      ...(typeof payload.identity === 'string' ? { identity: payload.identity } : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, 'projectModelPick') ? { projectModelPick: normalizeModelPick(payload.projectModelPick) } : {}),
      ...(payload.skillModelOverrides ? { skillModelOverrides: normalizeSkillModelOverrides(payload.skillModelOverrides) } : {}),
    })
  }

  async saveState(
    rootPath: string,
    payload: Partial<Pick<AgentModeProjectSettings, 'enabled' | 'todoEnabled'>>,
  ): Promise<AgentModeSettingsResult> {
    return this.save(rootPath, payload)
  }

  private async save(rootPath: string, partial: StoredAgentModeSettings): Promise<AgentModeSettingsResult> {
    const root = resolveWorkspacePath(rootPath)
    try {
      const current = await this.resolve(root)
      const next: AgentModeProjectSettings = {
        ...current,
        ...partial,
      }
      const file = this.readFile()
      file.projects[root] = next
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      return { ok: true, rootPath: root, settings: next }
    } catch (error) {
      return {
        ok: false,
        rootPath: root,
        message: error instanceof Error ? error.message : '保存 Agent 模式设置失败',
      }
    }
  }

  private readEntry(rootPath: string): StoredAgentModeSettings {
    return this.readFile().projects[resolveWorkspacePath(rootPath)] ?? {}
  }

  private readFile(): AgentModeSettingsFile {
    if (!existsSync(this.filePath)) return { projects: {} }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') return { projects: {} }
      const projectsRaw = (raw as Record<string, unknown>).projects
      if (!projectsRaw || typeof projectsRaw !== 'object') return { projects: {} }
      const projects: Record<string, StoredAgentModeSettings> = {}
      for (const [key, value] of Object.entries(projectsRaw)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as Record<string, unknown>
        projects[resolveWorkspacePath(key)] = {
          enabled: entry.enabled === true,
          todoEnabled: entry.todoEnabled === true,
          user: typeof entry.user === 'string' ? entry.user : undefined,
          identity: typeof entry.identity === 'string' ? entry.identity : undefined,
          projectModelPick: normalizeModelPick(entry.projectModelPick),
          skillModelOverrides: normalizeSkillModelOverrides(entry.skillModelOverrides),
        }
      }
      return { projects }
    } catch {
      return { projects: {} }
    }
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return ''
    throw error
  }
}

function resolveWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed.startsWith('~/')) return path.resolve(path.join(os.homedir(), trimmed.slice(2)))
  return path.resolve(trimmed)
}

function normalizeModelPick(value: unknown): ChatModelPick | undefined {
  if (!value || typeof value !== 'object') return undefined
  const pick = value as Record<string, unknown>
  const providerId = typeof pick.providerId === 'string' ? pick.providerId.trim() : ''
  const anthropicModel = typeof pick.anthropicModel === 'string' ? pick.anthropicModel.trim() : ''
  if (!providerId || !anthropicModel) return undefined
  return { providerId, anthropicModel }
}

function normalizeSkillModelOverrides(value: unknown): Record<string, ChatModelPick> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, ChatModelPick> = {}
  for (const [pathKey, rawPick] of Object.entries(value as Record<string, unknown>)) {
    if (!pathKey.trim() || !rawPick || typeof rawPick !== 'object') continue
    const modelPick = normalizeModelPick(rawPick)
    if (modelPick) out[pathKey] = modelPick
  }
  return out
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
