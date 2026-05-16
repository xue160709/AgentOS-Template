import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentModeFileChange,
  AgentModeFilesResult,
  AgentModeFileStatus,
  AgentModeProjectSettings,
  AgentModeStatusResult,
  AppUiLocale,
} from '../src/desktop-types'
import type { AgentModeSettingsStore } from './agent-mode-settings-store'
import { electronAgentCatalog } from './ui-locale'

const REQUIRED_CONTEXT_FILES = ['SOUL.md', 'MEMORY.md'] as const
const INSTRUCTION_FILE = 'AGENT.md'
const AGENT_MODE_MARKER_START = '<!-- AgentOS Agent Mode: start -->'
const AGENT_MODE_MARKER_END = '<!-- AgentOS Agent Mode: end -->'
const TODO_MODE_MARKER_START = '<!-- AgentOS TODO Mode: start -->'
const TODO_MODE_MARKER_END = '<!-- AgentOS TODO Mode: end -->'

export async function getAgentModeStatus(
  rootPath: string,
  settingsStore: AgentModeSettingsStore,
  locale: AppUiLocale,
): Promise<AgentModeStatusResult> {
  const msgs = electronAgentCatalog(locale).messages
  const root = resolveWorkspacePath(rootPath)
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: root, message: msgs.notDirectory }
    }

    const settings = await settingsStore.resolve(root)
    const instructionFile = INSTRUCTION_FILE
    const missingFiles: string[] = []
    if (!(await exists(path.join(root, instructionFile)))) missingFiles.push(instructionFile)
    for (const fileName of REQUIRED_CONTEXT_FILES) {
      if (!(await exists(path.join(root, fileName)))) missingFiles.push(fileName)
    }
    if (!(await exists(path.join(root, 'memory')))) missingFiles.push('memory/')

    return {
      ok: true,
      rootPath: root,
      enabled: settings.enabled,
      todoEnabled: settings.todoEnabled,
      instructionFile,
      missingFiles,
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: root,
      message: error instanceof Error ? error.message : msgs.readStatusFailed,
    }
  }
}

export async function ensureAgentModeFiles(
  rootPath: string,
  settingsStore: AgentModeSettingsStore,
  locale: AppUiLocale,
): Promise<AgentModeFilesResult> {
  const msgs = electronAgentCatalog(locale).messages
  const root = resolveWorkspacePath(rootPath)
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: root, message: msgs.notDirectory }
    }

    const files: AgentModeFileChange[] = []
    const settings = await settingsStore.resolve(root)
    const instructionFile = INSTRUCTION_FILE
    const instructionPath = path.join(root, instructionFile)
    const instructionStatus = await ensureInstructionFile(instructionPath, instructionFile, locale)
    files.push(fileChange(root, instructionPath, instructionStatus))

    for (const fileName of REQUIRED_CONTEXT_FILES) {
      const filePath = path.join(root, fileName)
      const status = await writeFileIfMissing(filePath, contextFileTemplate(fileName, locale))
      files.push(fileChange(root, filePath, status))
    }

    const memoryDirectory = path.join(root, 'memory')
    files.push(fileChange(root, memoryDirectory, await ensureDirectory(memoryDirectory)))

    const todayPath = path.join(memoryDirectory, `${formatLocalDate(new Date())}.md`)
    files.push(fileChange(root, todayPath, await writeFileIfMissing(todayPath, dailyMemoryTemplate(locale))))
    if (settings.todoEnabled) await ensureTodoMode(root, locale)
    await settingsStore.saveState(root, { enabled: true })

    return {
      ok: true,
      rootPath: root,
      instructionFile,
      files,
      message: msgs.ensureSuccess,
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: root,
      message: error instanceof Error ? error.message : msgs.ensureFailed,
    }
  }
}

export async function setAgentModeState(
  rootPath: string,
  partial: Partial<Pick<AgentModeProjectSettings, 'enabled' | 'todoEnabled'>>,
  settingsStore: AgentModeSettingsStore,
  locale: AppUiLocale,
): Promise<AgentModeStatusResult> {
  const root = resolveWorkspacePath(rootPath)
  if (partial.enabled === true) {
    const result = await ensureAgentModeFiles(root, settingsStore, locale)
    if (!result.ok) return { ok: false, rootPath: root, message: result.message }
  }

  if (partial.todoEnabled === true) {
    await ensureTodoMode(root, locale)
  } else if (partial.todoEnabled === false) {
    await disableTodoMode(root)
  }

  await settingsStore.saveState(root, partial)
  return getAgentModeStatus(root, settingsStore, locale)
}

function wrappedAgentModeBlock(locale: AppUiLocale): string {
  const body = electronAgentCatalog(locale).blocks.agentMode.join('\n')
  return `${AGENT_MODE_MARKER_START}\n${body}\n${AGENT_MODE_MARKER_END}`
}

function wrappedTodoModeBlock(locale: AppUiLocale): string {
  const body = electronAgentCatalog(locale).blocks.todoMode.join('\n')
  return `${TODO_MODE_MARKER_START}\n${body}\n${TODO_MODE_MARKER_END}`
}

async function ensureInstructionFile(
  filePath: string,
  fileName: string,
  locale: AppUiLocale,
): Promise<AgentModeFileStatus> {
  if (!(await exists(filePath))) {
    await fs.writeFile(filePath, defaultAgentsTemplate(fileName, locale), 'utf8')
    return 'created'
  }

  const content = await fs.readFile(filePath, 'utf8')
  if (content.includes(AGENT_MODE_MARKER_START)) return 'exists'
  const next = `${content.trimEnd()}\n\n${wrappedAgentModeBlock(locale)}\n`
  await fs.writeFile(filePath, next, 'utf8')
  return 'updated'
}

async function writeFileIfMissing(filePath: string, content: string): Promise<AgentModeFileStatus> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
    return 'created'
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return 'exists'
    throw error
  }
}

async function ensureDirectory(directoryPath: string): Promise<AgentModeFileStatus> {
  if (await exists(directoryPath)) return 'exists'
  await fs.mkdir(directoryPath, { recursive: true })
  return 'created'
}

async function ensureTodoMode(root: string, locale: AppUiLocale): Promise<void> {
  const instructionPath = path.join(root, INSTRUCTION_FILE)
  await ensureInstructionFile(instructionPath, INSTRUCTION_FILE, locale)
  await ensureTodoInstruction(instructionPath, locale)
  await writeFileIfMissing(path.join(root, 'TODO.md'), todoFileTemplate(locale))
}

async function disableTodoMode(root: string): Promise<void> {
  await removeMarkedSection(path.join(root, INSTRUCTION_FILE), TODO_MODE_MARKER_START, TODO_MODE_MARKER_END)
  try {
    await fs.unlink(path.join(root, 'TODO.md'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
}

async function ensureTodoInstruction(filePath: string, locale: AppUiLocale): Promise<AgentModeFileStatus> {
  const content = await fs.readFile(filePath, 'utf8')
  if (content.includes(TODO_MODE_MARKER_START)) return 'exists'
  const next = `${content.trimEnd()}\n\n${wrappedTodoModeBlock(locale)}\n`
  await fs.writeFile(filePath, next, 'utf8')
  return 'updated'
}

async function removeMarkedSection(filePath: string, startMarker: string, endMarker: string): Promise<void> {
  if (!(await exists(filePath))) return
  const content = await fs.readFile(filePath, 'utf8')
  const next = stripMarkedSection(content, startMarker, endMarker)
  if (next !== content) await fs.writeFile(filePath, next, 'utf8')
}

function stripMarkedSection(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker)
  if (start < 0) return content
  const end = content.indexOf(endMarker, start)
  if (end < 0) return content
  const afterEnd = end + endMarker.length
  const before = content.slice(0, start).trimEnd()
  const after = content.slice(afterEnd).replace(/^\s*\n/, '').trimStart()
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '')
}

function defaultAgentsTemplate(fileName: string, locale: AppUiLocale): string {
  const d = electronAgentCatalog(locale).defaults
  return `# ${fileName} - ${d.workspaceTitleSuffix}

${d.agentsLead}

${wrappedAgentModeBlock(locale)}
`
}

function contextFileTemplate(fileName: (typeof REQUIRED_CONTEXT_FILES)[number], locale: AppUiLocale): string {
  const b = electronAgentCatalog(locale).blocks
  if (fileName === 'SOUL.md') return b.soul.join('\n')
  return b.memory.join('\n')
}

function dailyMemoryTemplate(locale: AppUiLocale): string {
  const d = electronAgentCatalog(locale).defaults
  const date = formatLocalDate(new Date())
  return `# ${date}

${d.dailySessionHeading}

${d.dailyInitializedBullet}
`
}

function todoFileTemplate(locale: AppUiLocale): string {
  return electronAgentCatalog(locale).blocks.todoFile.join('\n')
}

function fileChange(root: string, filePath: string, status: AgentModeFileStatus): AgentModeFileChange {
  return {
    relativePath: normalizeRelativePath(path.relative(root, filePath)),
    path: filePath,
    status,
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function resolveWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed.startsWith('~/')) return path.resolve(path.join(os.homedir(), trimmed.slice(2)))
  return path.resolve(trimmed)
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
