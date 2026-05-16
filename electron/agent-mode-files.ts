import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentModeFileChange,
  AgentModeFilesResult,
  AgentModeFileStatus,
  AgentModeProjectSettings,
  AgentModeStatusResult,
} from '../src/desktop-types'
import type { AgentModeSettingsStore } from './agent-mode-settings-store'

const REQUIRED_CONTEXT_FILES = ['SOUL.md', 'MEMORY.md'] as const
const INSTRUCTION_FILE = 'AGENT.md'
const AGENT_MODE_MARKER_START = '<!-- AgentOS Agent Mode: start -->'
const AGENT_MODE_MARKER_END = '<!-- AgentOS Agent Mode: end -->'
const TODO_MODE_MARKER_START = '<!-- AgentOS TODO Mode: start -->'
const TODO_MODE_MARKER_END = '<!-- AgentOS TODO Mode: end -->'

export async function getAgentModeStatus(
  rootPath: string,
  settingsStore: AgentModeSettingsStore,
): Promise<AgentModeStatusResult> {
  const root = resolveWorkspacePath(rootPath)
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: root, message: '当前项目路径不是文件夹' }
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
      message: error instanceof Error ? error.message : '无法读取 Agent 模式状态',
    }
  }
}

export async function ensureAgentModeFiles(
  rootPath: string,
  settingsStore: AgentModeSettingsStore,
): Promise<AgentModeFilesResult> {
  const root = resolveWorkspacePath(rootPath)
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: root, message: '当前项目路径不是文件夹' }
    }

    const files: AgentModeFileChange[] = []
    const settings = await settingsStore.resolve(root)
    const instructionFile = INSTRUCTION_FILE
    const instructionPath = path.join(root, instructionFile)
    const instructionStatus = await ensureInstructionFile(instructionPath, instructionFile)
    files.push(fileChange(root, instructionPath, instructionStatus))

    for (const fileName of REQUIRED_CONTEXT_FILES) {
      const filePath = path.join(root, fileName)
      const status = await writeFileIfMissing(filePath, contextFileTemplate(fileName))
      files.push(fileChange(root, filePath, status))
    }

    const memoryDirectory = path.join(root, 'memory')
    files.push(fileChange(root, memoryDirectory, await ensureDirectory(memoryDirectory)))

    const todayPath = path.join(memoryDirectory, `${formatLocalDate(new Date())}.md`)
    files.push(fileChange(root, todayPath, await writeFileIfMissing(todayPath, dailyMemoryTemplate())))
    if (settings.todoEnabled) await ensureTodoMode(root)
    await settingsStore.saveState(root, { enabled: true })

    return {
      ok: true,
      rootPath: root,
      instructionFile,
      files,
      message: 'Agent 模式已开启，身份设置和记忆文件已准备好。',
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: root,
      message: error instanceof Error ? error.message : '开启 Agent 模式失败',
    }
  }
}

export async function setAgentModeState(
  rootPath: string,
  partial: Partial<Pick<AgentModeProjectSettings, 'enabled' | 'todoEnabled'>>,
  settingsStore: AgentModeSettingsStore,
): Promise<AgentModeStatusResult> {
  const root = resolveWorkspacePath(rootPath)
  if (partial.enabled === true) {
    const result = await ensureAgentModeFiles(root, settingsStore)
    if (!result.ok) return { ok: false, rootPath: root, message: result.message }
  }

  if (partial.todoEnabled === true) {
    await ensureTodoMode(root)
  } else if (partial.todoEnabled === false) {
    await disableTodoMode(root)
  }

  await settingsStore.saveState(root, partial)
  return getAgentModeStatus(root, settingsStore)
}

async function ensureInstructionFile(filePath: string, fileName: string): Promise<AgentModeFileStatus> {
  if (!(await exists(filePath))) {
    await fs.writeFile(filePath, defaultAgentsTemplate(fileName), 'utf8')
    return 'created'
  }

  const content = await fs.readFile(filePath, 'utf8')
  if (content.includes(AGENT_MODE_MARKER_START)) return 'exists'
  const next = `${content.trimEnd()}\n\n${agentModeInstructionSection()}\n`
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

async function ensureTodoMode(root: string): Promise<void> {
  const instructionPath = path.join(root, INSTRUCTION_FILE)
  await ensureInstructionFile(instructionPath, INSTRUCTION_FILE)
  await ensureTodoInstruction(instructionPath)
  await writeFileIfMissing(path.join(root, 'TODO.md'), todoTemplate())
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

async function ensureTodoInstruction(filePath: string): Promise<AgentModeFileStatus> {
  const content = await fs.readFile(filePath, 'utf8')
  if (content.includes(TODO_MODE_MARKER_START)) return 'exists'
  const next = `${content.trimEnd()}\n\n${todoModeInstructionSection()}\n`
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

function defaultAgentsTemplate(fileName: string): string {
  return `# ${fileName} - AgentOS Workspace

This folder is the assistant workspace. Treat Markdown files here as durable project context.

${agentModeInstructionSection()}
`
}

function agentModeInstructionSection(): string {
  return `${AGENT_MODE_MARKER_START}
## AgentOS Agent Mode

### Session Startup

- Read \`SOUL.md\` and \`MEMORY.md\` before responding.
- Read today and yesterday in \`memory/\` when those daily notes exist.
- Treat USER and IDENTITY as injected settings from the host system prompt, not project files.
- Treat these files as persistent context. Explicit user instructions for the current turn still take priority.

### Memory Discipline

- Daily notes live in \`memory/YYYY-MM-DD.md\`.
- Long-term memory lives in \`MEMORY.md\`.
- After every completed operation, update today's daily memory file with what changed, decisions made, files touched, and open loops.
- Promote durable preferences, project facts, and decisions into \`MEMORY.md\` when they will matter in future sessions.
- Do not store secrets unless the user explicitly asks you to remember them.

### Identity Stack

- \`SOUL.md\` defines internal values, tone, and boundaries.
- USER settings store stable human context and preferences.
- IDENTITY settings define public name and presentation.
- \`MEMORY.md\` stores curated long-term memory.

### Safety

- Do not exfiltrate private data.
- Do not run destructive commands unless explicitly asked.
- Ask before external actions such as sending messages, publishing, or changing remote services.
${AGENT_MODE_MARKER_END}`
}

function todoModeInstructionSection(): string {
  return `${TODO_MODE_MARKER_START}
## AgentOS TODO Mode

- Read \`TODO.md\` before starting implementation work.
- Treat \`TODO.md\` as the active task plan and source of truth for execution order.
- When completing work, update the relevant checkbox or note the blocker in \`TODO.md\`.
${TODO_MODE_MARKER_END}`
}

function contextFileTemplate(fileName: (typeof REQUIRED_CONTEXT_FILES)[number]): string {
  if (fileName === 'SOUL.md') return soulTemplate()
  return memoryTemplate()
}

function soulTemplate(): string {
  return `# SOUL.md - Who You Are

You are a capable coding companion with continuity. You are direct, careful, curious, and willing to take ownership.

## Core Truths

- Be genuinely helpful, not performatively helpful.
- Be resourceful before asking. Read the files, inspect the context, and try the obvious checks first.
- Earn trust through competence. Internal exploration is encouraged; external actions need care.
- Have judgment. You may disagree when the evidence calls for it.

## Boundaries

- Private things stay private.
- Ask before acting outside the local workspace.
- If you change this file, tell the user.

## Vibe

Concise when the task is simple, thorough when the stakes are high. Warm, calm, and practical.

## Continuity

Each session starts fresh. These files are your continuity. Read them, update them, and keep them useful.
`
}

function memoryTemplate(): string {
  return `# MEMORY.md - Long-Term Memory

Use this file for durable facts, preferences, decisions, and project context that should survive across sessions.

## Stable Preferences

- None recorded yet.

## Project Facts

- None recorded yet.

## Decisions

- None recorded yet.

## Open Loops

- None recorded yet.
`
}

function dailyMemoryTemplate(): string {
  const date = formatLocalDate(new Date())
  return `# ${date}

## Session Notes

- Agent Mode initialized for this workspace.
`
}

function todoTemplate(): string {
  return `# TODO.md

## Current Plan

- [ ] Add tasks for this project.
`
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
