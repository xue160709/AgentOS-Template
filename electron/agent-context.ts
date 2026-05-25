/**
 * 扫描 `.claude`/`.agent`/`.cursor` 等目录，组装技能、子 Agent 与指令上下文。
 * Discover slash skills, sub-agents, and instruction files under conventional folders.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatProjectPathError, resolveProjectPath } from './project-path'
import type {
  AgentContextAgentItem,
  AgentContextCatalog,
  AgentContextScope,
  AgentContextSlashItem,
  AgentContextSource,
  AgentContextResult,
  AgentInstructionFile,
  AgentKnowledgeSearchItem,
  AgentKnowledgeSearchKind,
  AgentKnowledgeSearchOptions,
  AgentKnowledgeSearchProject,
  AgentKnowledgeSearchResult,
  ProjectFileSearchItem,
  ProjectFileSearchResult,
} from '../src/claude-chat-types'
import type { AgentModeProjectSettings, AppUiLocale } from '../src/desktop-types'
import { GENERATIVE_UI_SYSTEM_PROMPT } from './generative-ui-prompt'
import { electronAgentCatalog } from './ui-locale'

type ContextSourceRoot = {
  directory: string
  scope: AgentContextScope
  source: AgentContextSource
  projectRoot: string
}

type ParsedMarkdown = {
  frontmatter: Record<string, string | string[]>
  body: string
}

type RuntimeContext = {
  catalog: AgentContextCatalog
  agents: Record<string, AgentDefinition>
  appendSystemPrompt?: string
}

type DiscoverAgentContextOptions = {
  agentModeEnabled?: boolean
}

const SOURCE_DIRECTORIES: Array<{ directoryName: string; source: AgentContextSource }> = [
  { directoryName: '.claude', source: 'claude' },
  { directoryName: '.agent', source: 'agent' },
  { directoryName: '.agents', source: 'agents' },
  { directoryName: '.cursor', source: 'cursor' },
]

const FILE_SEARCH_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.next',
  '.pnpm-store',
  '.svn',
  '.turbo',
  '.vite',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
  'release',
])

const MAX_CONTEXT_ROOT_ANCESTORS = 8
const MAX_SEARCH_ENTRIES = 5000
const MAX_SEARCH_RESULTS = 24
const MAX_SEARCH_DEPTH = 10
const MAX_KNOWLEDGE_FILE_CHARS = 16_000
const MAX_KNOWLEDGE_MEMORY_FILES = 160
const MAX_KNOWLEDGE_RESULTS = 48
const MAX_INSTRUCTION_FILE_CHARS = 24_000
const MAX_INSTRUCTION_TOTAL_CHARS = 72_000
const AGENT_MODE_ROOT_FILES = ['SOUL.md', 'MEMORY.md'] as const
const AGENT_MODE_MARKER_START = '<!-- AgentOS Agent Mode: start -->'
const AGENT_MODE_MARKER_END = '<!-- AgentOS Agent Mode: end -->'
const TODO_MODE_MARKER_START = '<!-- AgentOS TODO Mode: start -->'
const TODO_MODE_MARKER_END = '<!-- AgentOS TODO Mode: end -->'

// --- Discovery & catalog / 扫描与目录 ---

/** 列出项目内可用的 Agent 上下文目录快照 / Build AgentContext catalog for a project root */
export async function discoverAgentContext(
  rootPath: string,
  options: DiscoverAgentContextOptions = {},
): Promise<AgentContextResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  try {
    const stat = await fs.stat(resolvedRootPath)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, message: '当前项目路径不是文件夹' }
    }

    const sourceRoots = await collectContextSourceRoots(resolvedRootPath)
    const skills: AgentContextSlashItem[] = []
    const agents: AgentContextAgentItem[] = []
    const instructionFiles: AgentInstructionFile[] = []

    for (const sourceRoot of sourceRoots) {
      skills.push(...(await readSkillItems(sourceRoot)))
      skills.push(...(await readCommandItems(sourceRoot)))
      agents.push(...(await readAgentItems(sourceRoot)))
      instructionFiles.push(...(await readInstructionFiles(sourceRoot, options)))
    }

    return {
      ok: true,
      rootPath: resolvedRootPath,
      skills: sortSlashItems(dedupeSlashItems(skills)),
      agents: sortAgentItems(dedupeAgentItems(agents)),
      instructionFiles: sortInstructionFiles(dedupeInstructionFiles(instructionFiles)),
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      message: formatProjectPathError(error),
    }
  }
}

// --- Runtime assembly / 运行时拼装 ---

/** 将目录扫描结果转成 SDK 可用的 definitions 与追加 system prompt / Turn catalog into SDK defs + optional system append */
export async function buildRuntimeContext(
  rootPath: string,
  agentModeSettings?: AgentModeProjectSettings,
  uiLocale: AppUiLocale = 'zh',
): Promise<RuntimeContext> {
  const catalogResult = await discoverAgentContext(rootPath, {
    agentModeEnabled: agentModeSettings?.enabled,
  })
  const catalog: AgentContextCatalog =
    catalogResult.ok
      ? catalogResult
      : {
          ok: true,
          rootPath: catalogResult.rootPath,
          skills: [],
          agents: [],
          instructionFiles: [],
        }

  return {
    catalog,
    agents: await buildAgentDefinitions(catalog.agents),
    appendSystemPrompt: await buildAppendSystemPrompt(catalog, agentModeSettings, uiLocale),
  }
}

/** 展开斜杠调用为内联指令块（若命中技能）/ Expand `/command` invocations using skill markdown when matched */
export async function resolvePromptWithContext(
  prompt: string,
  catalog: AgentContextCatalog,
  options: { forcedSkillCommand?: string } = {},
): Promise<string> {
  const forcedSkillCommand = options.forcedSkillCommand?.trim()
  const invocation = parseSlashInvocation(prompt)
  if (forcedSkillCommand && invocation?.command !== forcedSkillCommand) {
    const forcedItem = findHostSkill(catalog, forcedSkillCommand)
    if (forcedItem) return expandSkillInvocation(forcedItem, prompt, true)
  }
  if (!invocation) return prompt

  const item = findHostSkill(catalog, invocation.command)
  if (!item) return prompt

  return expandSkillInvocation(item, invocation.argumentsText, false, invocation.command)
}

function findHostSkill(catalog: AgentContextCatalog, command: string): AgentContextSlashItem | undefined {
  return catalog.skills.find((candidate) => candidate.command === command || candidate.name === command)
}

async function expandSkillInvocation(
  item: AgentContextSlashItem,
  argumentsText: string,
  automatic: boolean,
  commandName = item.command,
): Promise<string> {
  const parsed = await readMarkdown(item.path)
  const body = applySlashArguments(parsed.body.trim(), argumentsText)
  return [
    automatic
      ? `The host automatically invoked the host-compatible slash command /${item.command} for this request.`
      : `The user invoked the host-compatible slash command /${commandName}.`,
    `Source: ${item.relativePath}`,
    '',
    '<slash_command_instructions>',
    body,
    '</slash_command_instructions>',
    '',
    argumentsText ? `User arguments: ${argumentsText}` : 'User arguments: none',
    '',
    'Carry out the slash command instructions for the user request above.',
  ].join('\n')
}

// --- File search / 项目文件搜索 ---

/** 在项目树内按前缀模糊查找路径（受限深度与条目数）/ Fuzzy path search with caps on depth and visited entries */
export async function searchProjectFiles(rootPath: string, query: string): Promise<ProjectFileSearchResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  try {
    const stat = await fs.stat(resolvedRootPath)
    if (!stat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, message: '当前项目路径不是文件夹' }
    }

    const normalizedQuery = normalizeQuery(query)
    const items: ProjectFileSearchItem[] = []
    let entriesRead = 0

    const walk = async (directoryPath: string, relativeBase: string, depth: number): Promise<void> => {
      if (depth > MAX_SEARCH_DEPTH || entriesRead >= MAX_SEARCH_ENTRIES) return
      const entries = await safeReadDir(directoryPath)
      entries.sort((a, b) => {
        const typeDiff = Number(b.isDirectory()) - Number(a.isDirectory())
        return typeDiff || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })

      for (const entry of entries) {
        if (entriesRead >= MAX_SEARCH_ENTRIES) break
        if (entry.isDirectory() && FILE_SEARCH_IGNORED_DIRECTORIES.has(entry.name)) continue
        const entryPath = path.join(directoryPath, entry.name)
        const relativePath = normalizeRelativePath(path.join(relativeBase, entry.name))
        entriesRead += 1

        if (entry.isDirectory()) {
          if (matchesQuery(entry.name, relativePath, normalizedQuery)) {
            items.push({
              label: entry.name,
              path: entryPath,
              relativePath,
              type: 'directory',
            })
          }
          await walk(entryPath, relativePath, depth + 1)
          continue
        }

        if ((entry.isFile() || entry.isSymbolicLink()) && matchesQuery(entry.name, relativePath, normalizedQuery)) {
          items.push({
            label: entry.name,
            path: entryPath,
            relativePath,
            type: 'file',
          })
        }
      }
    }

    await walk(resolvedRootPath, '', 0)

    return {
      ok: true,
      rootPath: resolvedRootPath,
      items: items
        .sort((a, b) => scoreFileSearchItem(b, normalizedQuery) - scoreFileSearchItem(a, normalizedQuery) || a.relativePath.localeCompare(b.relativePath))
        .slice(0, MAX_SEARCH_RESULTS),
    }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      message: formatProjectPathError(error),
    }
  }
}

/** 搜索 AgentOS 项目知识：memory、技能、命令、子 Agent 与 Home Plugin/task 元数据 / Search project knowledge documents */
export async function searchAgentKnowledge(
  projects: AgentKnowledgeSearchProject[],
  query: string,
  options: AgentKnowledgeSearchOptions = {},
): Promise<AgentKnowledgeSearchResult> {
  const normalizedQuery = normalizeQuery(query)
  const limit = normalizeKnowledgeLimit(options.limit)
  const allowedKinds = normalizeKnowledgeKinds(options.kinds)
  const since = typeof options.recentDays === 'number' && Number.isFinite(options.recentDays) && options.recentDays > 0
    ? Date.now() - options.recentDays * 86_400_000
    : undefined

  try {
    const documents: AgentKnowledgeSearchItem[] = []
    for (const project of projects) {
      const resolvedProject = {
        ...project,
        path: resolveProjectPath(project.path),
      }
      documents.push(...(await collectProjectKnowledge(resolvedProject)))
    }

    const items = documents
      .filter((item) => allowedKinds.size === 0 || allowedKinds.has(item.kind))
      .filter((item) => !since || !item.updatedAt || item.updatedAt >= since)
      .map((item) => scoreKnowledgeItem(item, normalizedQuery))
      .filter((item): item is AgentKnowledgeSearchItem => Boolean(item))
      .sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title))
      .slice(0, limit)

    return { ok: true, items }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Knowledge search failed' }
  }
}

async function collectProjectKnowledge(project: AgentKnowledgeSearchProject): Promise<AgentKnowledgeSearchItem[]> {
  const stat = await fs.stat(project.path)
  if (!stat.isDirectory()) return []

  const catalogResult = await discoverAgentContext(project.path, { agentModeEnabled: true })
  const items: AgentKnowledgeSearchItem[] = []
  const seenPaths = new Set<string>()

  const fileItems = await collectKnowledgeFileItems(project)
  for (const item of fileItems) {
    if (item.path) seenPaths.add(normalizeFilesystemPath(item.path))
    items.push(item)
  }

  if (catalogResult.ok) {
    for (const file of catalogResult.instructionFiles) {
      const normalizedPath = normalizeFilesystemPath(file.path)
      if (seenPaths.has(normalizedPath)) continue
      const item = await createKnowledgeFileItem(project, file.path, file.relativePath, {
        scope: file.scope,
        source: file.source,
        loadMode: file.loadMode,
      })
      if (item.path) seenPaths.add(normalizedPath)
      items.push(item)
    }

    for (const skill of catalogResult.skills) {
      items.push(await createSlashKnowledgeItem(project, skill))
    }
    for (const agent of catalogResult.agents) {
      items.push(await createAgentKnowledgeItem(project, agent))
    }
  }

  items.push(...(await collectHomePluginKnowledgeItems(project)))
  return items
}

async function collectKnowledgeFileItems(project: AgentKnowledgeSearchProject): Promise<AgentKnowledgeSearchItem[]> {
  const items: AgentKnowledgeSearchItem[] = []
  const candidates = ['AGENT.md', 'AGENTS.md', 'SOUL.md', 'MEMORY.md', 'memory.md', 'TODO.md']
  for (const candidate of candidates) {
    const filePath = path.join(project.path, candidate)
    if (await exists(filePath)) {
      items.push(await createKnowledgeFileItem(project, filePath, normalizeRelativePath(candidate), { source: 'project-root' }))
    }
  }

  const memoryDir = path.join(project.path, 'memory')
  const memoryFiles = await readKnowledgeMarkdownFiles(memoryDir)
  for (const filePath of memoryFiles.slice(0, MAX_KNOWLEDGE_MEMORY_FILES)) {
    items.push(await createKnowledgeFileItem(project, filePath, normalizeRelativePath(path.relative(project.path, filePath)), { source: 'memory' }))
  }
  return items
}

async function readKnowledgeMarkdownFiles(directoryPath: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (currentPath: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_KNOWLEDGE_MEMORY_FILES) return
    const entries = await safeReadDir(currentPath)
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const entry of entries) {
      if (files.length >= MAX_KNOWLEDGE_MEMORY_FILES) break
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1)
      } else if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }
  await walk(directoryPath, 0)
  return files
}

async function createKnowledgeFileItem(
  project: AgentKnowledgeSearchProject,
  filePath: string,
  relativePath: string,
  metadata: Record<string, unknown>,
): Promise<AgentKnowledgeSearchItem> {
  const [content, stat] = await Promise.all([
    readTextFile(filePath, MAX_KNOWLEDGE_FILE_CHARS).catch(() => ''),
    fs.stat(filePath).catch(() => null),
  ])
  const parsed = parseMarkdown(content)
  const title = readFrontmatterString(parsed.frontmatter, 'title') || path.basename(filePath)
  const body = [frontmatterSearchText(parsed.frontmatter), parsed.body].filter(Boolean).join('\n')
  return {
    id: `knowledge:memory:${project.id}:${relativePath}`,
    kind: 'memory',
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    title,
    subtitle: relativePath,
    body,
    snippet: firstParagraph(body),
    path: filePath,
    relativePath,
    score: 0,
    updatedAt: stat?.mtimeMs,
    metadata,
  }
}

async function createSlashKnowledgeItem(
  project: AgentKnowledgeSearchProject,
  item: AgentContextSlashItem,
): Promise<AgentKnowledgeSearchItem> {
  const parsed = await readMarkdown(item.path).catch(() => ({ frontmatter: {}, body: '' }))
  const stat = await fs.stat(item.path).catch(() => null)
  const body = [item.description, item.argumentHint, frontmatterSearchText(parsed.frontmatter), parsed.body].filter(Boolean).join('\n')
  return {
    id: `knowledge:${item.kind}:${project.id}:${item.path}`,
    kind: item.kind,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    title: item.title,
    subtitle: [item.description, item.relativePath].filter(Boolean).join(' · '),
    body,
    snippet: firstParagraph(body || item.description),
    path: item.path,
    relativePath: item.relativePath,
    command: item.command,
    scope: item.scope,
    source: item.source,
    score: 0,
    updatedAt: stat?.mtimeMs,
    metadata: {
      name: item.name,
      native: item.native,
      argumentHint: item.argumentHint,
    },
  }
}

async function createAgentKnowledgeItem(
  project: AgentKnowledgeSearchProject,
  item: AgentContextAgentItem,
): Promise<AgentKnowledgeSearchItem> {
  const parsed = await readMarkdown(item.path).catch(() => ({ frontmatter: {}, body: '' }))
  const stat = await fs.stat(item.path).catch(() => null)
  const body = [item.description, item.model, item.tools.join(', '), frontmatterSearchText(parsed.frontmatter), parsed.body].filter(Boolean).join('\n')
  return {
    id: `knowledge:agent:${project.id}:${item.path}`,
    kind: 'agent',
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    title: item.name,
    subtitle: [item.description, item.relativePath].filter(Boolean).join(' · '),
    body,
    snippet: firstParagraph(body || item.description),
    path: item.path,
    relativePath: item.relativePath,
    scope: item.scope,
    source: item.source,
    score: 0,
    updatedAt: stat?.mtimeMs,
    metadata: {
      model: item.model,
      tools: item.tools,
      native: item.native,
    },
  }
}

async function collectHomePluginKnowledgeItems(project: AgentKnowledgeSearchProject): Promise<AgentKnowledgeSearchItem[]> {
  const pluginRootPath = path.join(project.path, '.agents/home-plugins')
  const entries = await safeReadDir(pluginRootPath)
  const items: AgentKnowledgeSearchItem[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = normalizeCommandName(entry.name)
    if (!slug) continue
    const pluginPath = path.join(pluginRootPath, entry.name)
    const [manifestRaw, taskRaw, runtimeRaw, stat] = await Promise.all([
      readJsonIfExists(path.join(pluginPath, 'manifest.json')),
      readJsonIfExists(path.join(pluginPath, 'task.json')),
      readJsonIfExists(path.join(pluginPath, 'runtime.json')),
      fs.stat(pluginPath).catch(() => null),
    ])
    if (!manifestRaw && !taskRaw) continue
    const manifest = isRecord(manifestRaw) ? manifestRaw : {}
    const task = isRecord(taskRaw) ? taskRaw : {}
    const runtime = isRecord(runtimeRaw) ? runtimeRaw : {}
    const kind: AgentKnowledgeSearchKind = taskRaw || manifest.kind === 'task' ? 'task' : 'home-plugin'
    const title = stringField(task.title) || stringField(manifest.name) || titleFromSlug(slug)
    const threadId = stringField(runtime.threadId) || stringField(manifest.threadId)
    const body = [
      stringField(manifest.description),
      stringField(task.mode),
      stringField(runtime.status),
      stringField(runtime.summary),
      stringField(runtime.detail),
      stringField(runtime.lastResult),
      stringField(runtime.lastError),
      stringField(runtime.threadTitle),
      skillStepsText(task.skillSteps),
    ]
      .filter(Boolean)
      .join('\n')
    items.push({
      id: `knowledge:${kind}:${project.id}:${slug}`,
      kind,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      title,
      subtitle: [kind === 'task' ? 'Task' : 'Home Plugin', slug, stringField(runtime.status)].filter(Boolean).join(' · '),
      body,
      snippet: firstParagraph(body || stringField(manifest.description)),
      path: pluginPath,
      relativePath: normalizeRelativePath(path.relative(project.path, pluginPath)),
      threadId,
      slug,
      score: 0,
      updatedAt: Date.parse(stringField(runtime.updatedAt) || stringField(task.updatedAt) || stringField(manifest.updatedAt)) || stat?.mtimeMs,
      metadata: {
        manifest,
        task,
        runtime,
      },
    })
  }
  return items
}

function scoreKnowledgeItem(item: AgentKnowledgeSearchItem, query: string): AgentKnowledgeSearchItem | null {
  if (!query) return { ...item, score: baseKnowledgeScore(item), snippet: item.snippet || firstParagraph(item.body) }
  const titleScore = scoreKnowledgeText(item.title, query, 3)
  const subtitleScore = scoreKnowledgeText(item.subtitle, query, 1.5)
  const pathScore = scoreKnowledgeText([item.relativePath, item.command, item.projectName].filter(Boolean).join(' '), query, 1.2)
  const bodyScore = scoreKnowledgeText(item.body, query, 1)
  const score = titleScore + subtitleScore + pathScore + bodyScore
  if (score <= 0) return null
  return {
    ...item,
    score: score + baseKnowledgeScore(item) + recencyKnowledgeScore(item.updatedAt),
    snippet: makeKnowledgeSnippet(item, query),
  }
}

function scoreKnowledgeText(value: string | undefined, query: string, weight: number): number {
  const normalized = normalizeQuery(value ?? '')
  if (!normalized || !query) return 0
  if (normalized === query) return 140 * weight
  if (normalized.startsWith(query)) return 95 * weight
  const index = normalized.indexOf(query)
  if (index >= 0) return Math.max(20, 70 - Math.min(index, 180) / 4) * weight
  return fuzzyPathScore(normalized, query) * 0.5 * weight
}

function makeKnowledgeSnippet(item: AgentKnowledgeSearchItem, query: string): string {
  const source = compactSearchText(item.body || item.subtitle || item.title, 2400)
  const normalizedSource = normalizeQuery(source)
  const index = normalizedSource.indexOf(query)
  if (index < 0) return firstParagraph(source)
  const start = Math.max(0, index - 56)
  const end = Math.min(source.length, start + 180)
  return `${start > 0 ? '... ' : ''}${source.slice(start, end).trim()}${end < source.length ? ' ...' : ''}`
}

function baseKnowledgeScore(item: AgentKnowledgeSearchItem): number {
  if (item.kind === 'memory') return 20
  if (item.kind === 'task') return 18
  if (item.kind === 'skill' || item.kind === 'command') return 16
  if (item.kind === 'agent') return 14
  return 12
}

function recencyKnowledgeScore(updatedAt: number | undefined): number {
  if (!updatedAt) return 0
  const ageDays = Math.max(0, Date.now() - updatedAt) / 86_400_000
  return Math.max(0, 20 - ageDays)
}

function normalizeKnowledgeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MAX_SEARCH_RESULTS
  return Math.max(1, Math.min(MAX_KNOWLEDGE_RESULTS, Math.trunc(limit)))
}

function normalizeKnowledgeKinds(kinds: AgentKnowledgeSearchKind[] | undefined): Set<AgentKnowledgeSearchKind> {
  const output = new Set<AgentKnowledgeSearchKind>()
  for (const kind of kinds ?? []) {
    if (kind === 'agent' || kind === 'command' || kind === 'home-plugin' || kind === 'memory' || kind === 'skill' || kind === 'task') {
      output.add(kind)
    }
  }
  return output
}

function frontmatterSearchText(frontmatter: Record<string, string | string[]>): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('\n')
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

function skillStepsText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter(isRecord)
    .map((step) => [stringField(step.title), stringField(step.command), stringField(step.description)].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
}

function stringField(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function compactSearchText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(0, maxLength - 4)).trimEnd()} ...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function collectContextSourceRoots(projectRoot: string): Promise<ContextSourceRoot[]> {
  const roots: ContextSourceRoot[] = []
  const projectAncestors = await collectProjectAncestors(projectRoot)
  const userSourceDirectoryPaths = new Set<string>()
  for (const source of SOURCE_DIRECTORIES) {
    const directory = path.join(os.homedir(), source.directoryName)
    userSourceDirectoryPaths.add(normalizeFilesystemPath(directory))
    roots.push({
      directory,
      projectRoot,
      scope: 'user',
      source: source.source,
    })
  }

  const bundledAgentsDirectories = [
    path.join(process.cwd(), '.agents'),
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.agents'),
  ]
  const seenBundledDirectories = new Set<string>()
  for (const bundledAgentsDirectory of bundledAgentsDirectories) {
    const bundledRoot = path.dirname(bundledAgentsDirectory)
    if (projectAncestors.includes(bundledRoot) || seenBundledDirectories.has(bundledAgentsDirectory)) continue
    seenBundledDirectories.add(bundledAgentsDirectory)
    if (await exists(path.join(bundledAgentsDirectory, 'skills', 'a2ui-project-home-panel', 'SKILL.md'))) {
      roots.push({
        directory: bundledAgentsDirectory,
        projectRoot,
        scope: 'user',
        source: 'agents',
      })
    }
  }

  for (const directory of projectAncestors) {
    for (const source of SOURCE_DIRECTORIES) {
      const sourceDirectory = path.join(directory, source.directoryName)
      if (userSourceDirectoryPaths.has(normalizeFilesystemPath(sourceDirectory))) continue
      roots.push({
        directory: sourceDirectory,
        projectRoot,
        scope: 'project',
        source: source.source,
      })
    }
  }

  return roots
}

function normalizeFilesystemPath(value: string): string {
  return path.resolve(value)
}

async function collectProjectAncestors(projectRoot: string): Promise<string[]> {
  const roots: string[] = []
  let current = projectRoot
  for (let depth = 0; depth < MAX_CONTEXT_ROOT_ANCESTORS; depth += 1) {
    roots.push(current)
    if (await exists(path.join(current, '.git'))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

async function readSkillItems(sourceRoot: ContextSourceRoot): Promise<AgentContextSlashItem[]> {
  const skillsDirectory = path.join(sourceRoot.directory, 'skills')
  const entries = await safeReadDir(skillsDirectory)
  const items: AgentContextSlashItem[] = []

  for (const entry of entries) {
    const entryPath = path.join(skillsDirectory, entry.name)
    if (entry.isDirectory()) {
      const skillPath = path.join(entryPath, 'SKILL.md')
      if (!(await exists(skillPath))) continue
      items.push(await createSlashItem(skillPath, sourceRoot, 'skill', entry.name))
      continue
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      items.push(await createSlashItem(entryPath, sourceRoot, 'skill', path.basename(entry.name, path.extname(entry.name))))
    }
  }

  return items
}

async function readCommandItems(sourceRoot: ContextSourceRoot): Promise<AgentContextSlashItem[]> {
  const commandFiles = await readMarkdownFiles(path.join(sourceRoot.directory, 'commands'))
  return Promise.all(
    commandFiles.map((commandPath) =>
      createSlashItem(commandPath, sourceRoot, 'command', path.basename(commandPath, path.extname(commandPath))),
    ),
  )
}

async function readAgentItems(sourceRoot: ContextSourceRoot): Promise<AgentContextAgentItem[]> {
  const agentFiles = [
    ...(await readMarkdownFiles(path.join(sourceRoot.directory, 'agents'))),
    ...(await readSkillAgentFiles(sourceRoot)),
  ]
  return Promise.all(agentFiles.map((agentPath) => createAgentItem(agentPath, sourceRoot)))
}

async function readSkillAgentFiles(sourceRoot: ContextSourceRoot): Promise<string[]> {
  const skillsDirectory = path.join(sourceRoot.directory, 'skills')
  const entries = await safeReadDir(skillsDirectory)
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    files.push(...(await readMarkdownFiles(path.join(skillsDirectory, entry.name, 'agents'))))
  }
  return files
}

async function readInstructionFiles(
  sourceRoot: ContextSourceRoot,
  options: DiscoverAgentContextOptions,
): Promise<AgentInstructionFile[]> {
  const files: AgentInstructionFile[] = []
  const scopedCandidates = [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENT.md',
    'AGENTS.md',
    path.join('rules', 'project.mdc'),
  ]

  for (const candidate of scopedCandidates) {
    const filePath = path.join(sourceRoot.directory, candidate)
    await pushInstructionFile(files, filePath, sourceRoot, candidate)
  }

  if (sourceRoot.scope === 'project' && sourceRoot.source === 'claude') {
    const projectDirectory = path.dirname(sourceRoot.directory)
    for (const candidate of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENT.md', 'AGENTS.md']) {
      const filePath = path.join(projectDirectory, candidate)
      await pushInstructionFile(files, filePath, sourceRoot, candidate)
    }
    if (options.agentModeEnabled !== false) {
      for (const candidate of AGENT_MODE_ROOT_FILES) {
        const filePath = path.join(projectDirectory, candidate)
        await pushInstructionFile(files, filePath, sourceRoot, candidate)
      }
      if (!(await exists(path.join(projectDirectory, 'MEMORY.md')))) {
        await pushInstructionFile(files, path.join(projectDirectory, 'memory.md'), sourceRoot, 'memory.md')
      }
      for (const candidate of recentDailyMemoryFileNames()) {
        const filePath = path.join(projectDirectory, 'memory', candidate)
        await pushInstructionFile(files, filePath, sourceRoot, candidate)
      }
    }
  }

  const cursorRuleFiles =
    sourceRoot.source === 'cursor' ? await readMarkdownFiles(path.join(sourceRoot.directory, 'rules')) : []
  for (const filePath of cursorRuleFiles) {
    if (!filePath.toLowerCase().endsWith('.mdc')) continue
    files.push({
      name: path.basename(filePath),
      path: filePath,
      relativePath: formatContextRelativePath(filePath, sourceRoot),
      scope: sourceRoot.scope,
      source: sourceRoot.source,
      loadMode: 'host',
    })
  }

  return files
}

async function pushInstructionFile(
  files: AgentInstructionFile[],
  filePath: string,
  sourceRoot: ContextSourceRoot,
  candidate: string,
): Promise<void> {
  if (!(await exists(filePath))) return
  files.push({
    name: path.basename(filePath),
    path: filePath,
    relativePath: formatContextRelativePath(filePath, sourceRoot),
    scope: sourceRoot.scope,
    source: sourceRoot.source,
    loadMode: sourceRoot.source === 'claude' && candidate.toLowerCase().includes('claude') ? 'sdk' : 'host',
  })
}

async function createSlashItem(
  filePath: string,
  sourceRoot: ContextSourceRoot,
  kind: 'skill' | 'command',
  fallbackName: string,
): Promise<AgentContextSlashItem> {
  const parsed = await readMarkdown(filePath)
  const name = normalizeCommandName(readFrontmatterString(parsed.frontmatter, 'name') || fallbackName)
  const description =
    readFrontmatterString(parsed.frontmatter, 'description') ||
    readFrontmatterString(parsed.frontmatter, 'when_to_use') ||
    firstParagraph(parsed.body)
  return {
    kind,
    name,
    command: name,
    title: `/${name}`,
    description,
    argumentHint:
      readFrontmatterString(parsed.frontmatter, 'argument-hint') ||
      readFrontmatterString(parsed.frontmatter, 'argument_hint') ||
      '',
    path: filePath,
    relativePath: formatContextRelativePath(filePath, sourceRoot),
    scope: sourceRoot.scope,
    source: sourceRoot.source,
    native: sourceRoot.source === 'claude',
  }
}

async function createAgentItem(filePath: string, sourceRoot: ContextSourceRoot): Promise<AgentContextAgentItem> {
  const parsed = await readMarkdown(filePath)
  const name = normalizeCommandName(readFrontmatterString(parsed.frontmatter, 'name') || path.basename(filePath, path.extname(filePath)))
  const description = readFrontmatterString(parsed.frontmatter, 'description') || firstParagraph(parsed.body)
  const tools = readFrontmatterArray(parsed.frontmatter, 'tools').concat(readFrontmatterArray(parsed.frontmatter, 'allowed-tools'))
  return {
    kind: 'agent',
    name,
    description,
    path: filePath,
    relativePath: formatContextRelativePath(filePath, sourceRoot),
    scope: sourceRoot.scope,
    source: sourceRoot.source,
    native: sourceRoot.source === 'claude',
    model: readFrontmatterString(parsed.frontmatter, 'model') || undefined,
    tools: [...new Set(tools)],
  }
}

async function buildAgentDefinitions(items: AgentContextAgentItem[]): Promise<Record<string, AgentDefinition>> {
  const definitions: Record<string, AgentDefinition> = {}
  for (const item of items) {
    const parsed = await readMarkdown(item.path)
    const prompt = parsed.body.trim() || item.description
    if (!prompt || !item.description) continue
    const tools = item.tools.length > 0 ? item.tools.filter((tool) => tool !== 'Agent' && tool !== 'Task') : undefined
    const skills = readFrontmatterArray(parsed.frontmatter, 'skills')
    definitions[item.name] = {
      description: item.description,
      prompt,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(skills.length > 0 ? { skills } : {}),
    }
  }
  return definitions
}

async function buildAppendSystemPrompt(
  catalog: AgentContextCatalog,
  agentModeSettings?: AgentModeProjectSettings,
  uiLocale: AppUiLocale = 'zh',
): Promise<string | undefined> {
  const promptCopy = electronAgentCatalog(uiLocale).prompt
  const hostInstructionFiles = catalog.instructionFiles.filter((file) => file.loadMode === 'host')
  const hostSkills = catalog.skills
  const hasAgentModeSettings =
    agentModeSettings?.enabled === true &&
    (Boolean(agentModeSettings.user.trim()) || Boolean(agentModeSettings.identity.trim()))
  const hasHostContext = hostInstructionFiles.length > 0 || hostSkills.length > 0 || hasAgentModeSettings

  let remaining = MAX_INSTRUCTION_TOTAL_CHARS
  const sections = hasHostContext ? [promptCopy.hostLoadedIntro, GENERATIVE_UI_SYSTEM_PROMPT] : [GENERATIVE_UI_SYSTEM_PROMPT]

  if (hostSkills.length > 0) {
    sections.push(
      [
        promptCopy.hostSlashIntro,
        ...hostSkills.map((skill) => `- /${skill.command} (${formatScope(skill.scope)}, ${skill.source}): ${skill.description || skill.relativePath}`),
      ].join('\n'),
    )
  }

  for (const file of hostInstructionFiles) {
    if (remaining <= 0) break
    const rawContent = await readTextFile(file.path, Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining))
    const content = sanitizeInstructionContent(file, rawContent, agentModeSettings)
    if (!content.trim()) continue
    remaining -= content.length
    sections.push([`## ${file.relativePath}`, content.trim()].join('\n'))
  }

  if (agentModeSettings?.enabled === true) {
    const identity = agentModeSettings.identity.trim()
    const user = agentModeSettings.user.trim()
    if (identity) sections.push([promptCopy.identityHeading, identity].join('\n'))
    if (user) sections.push([promptCopy.userHeading, user].join('\n'))
  }

  return sections.join('\n\n')
}

function sanitizeInstructionContent(
  file: AgentInstructionFile,
  content: string,
  agentModeSettings?: AgentModeProjectSettings,
): string {
  if (!isAgentInstructionFile(file)) return content
  let next = content
  if (agentModeSettings?.enabled === false) {
    next = stripMarkedSection(next, AGENT_MODE_MARKER_START, AGENT_MODE_MARKER_END)
    next = stripMarkedSection(next, TODO_MODE_MARKER_START, TODO_MODE_MARKER_END)
    return next
  }
  if (agentModeSettings?.todoEnabled === false) {
    next = stripMarkedSection(next, TODO_MODE_MARKER_START, TODO_MODE_MARKER_END)
  }
  return next
}

function isAgentInstructionFile(file: AgentInstructionFile): boolean {
  const name = path.basename(file.path).toLowerCase()
  return name === 'agent.md' || name === 'agents.md'
}

function stripMarkedSection(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker)
  if (start < 0) return content
  const end = content.indexOf(endMarker, start)
  if (end < 0) return content
  const before = content.slice(0, start).trimEnd()
  const after = content.slice(end + endMarker.length).replace(/^\s*\n/, '').trimStart()
  return [before, after].filter(Boolean).join('\n\n')
}

async function readMarkdownFiles(directoryPath: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (currentPath: string): Promise<void> => {
    const entries = await safeReadDir(currentPath)
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }
  await walk(directoryPath)
  return files
}

async function readMarkdown(filePath: string): Promise<ParsedMarkdown> {
  return parseMarkdown(await readTextFile(filePath, MAX_INSTRUCTION_FILE_CHARS))
}

function parseMarkdown(content: string): ParsedMarkdown {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content }
  const closeIndex = content.indexOf('\n---', 3)
  if (closeIndex < 0) return { frontmatter: {}, body: content }
  const frontmatterText = content.slice(3, closeIndex)
  const body = content.slice(closeIndex + 4).replace(/^\r?\n/, '')
  return { frontmatter: parseFrontmatter(frontmatterText), body }
}

function parseFrontmatter(value: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {}
  const lines = value.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].trim()
    const rawValue = match[2].trim()
    if (rawValue.length > 0) {
      output[key] = parseFrontmatterScalarOrList(rawValue)
      continue
    }

    const list: string[] = []
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1]
      const itemMatch = /^\s*-\s*(.+)$/.exec(nextLine)
      if (!itemMatch) break
      list.push(stripYamlQuotes(itemMatch[1].trim()))
      index += 1
    }
    output[key] = list
  }
  return output
}

function parseFrontmatterScalarOrList(value: string): string | string[] {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => stripYamlQuotes(item.trim()))
      .filter(Boolean)
  }
  if (value.includes(',') && /^[A-Za-z0-9_./:* -]+$/.test(value)) {
    return value
      .split(',')
      .map((item) => stripYamlQuotes(item.trim()))
      .filter(Boolean)
  }
  return stripYamlQuotes(value)
}

function readFrontmatterString(frontmatter: Record<string, string | string[]>, key: string): string {
  const value = frontmatter[key]
  if (Array.isArray(value)) return value.join(', ')
  return value?.trim() ?? ''
}

function readFrontmatterArray(frontmatter: Record<string, string | string[]>, key: string): string[] {
  const value = frontmatter[key]
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean)
  if (!value) return []
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function firstParagraph(value: string): string {
  return truncate(
    value
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '',
    180,
  )
}

function applySlashArguments(body: string, argumentsText: string): string {
  const args = splitCommandArguments(argumentsText)
  let output = body.replace(/\$ARGUMENTS/g, argumentsText)
  args.forEach((argument, index) => {
    output = output.replace(new RegExp(`\\$${index + 1}\\b`, 'g'), argument)
  })
  return output
}

function splitCommandArguments(value: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of value.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return args
}

function parseSlashInvocation(prompt: string): { command: string; argumentsText: string } | null {
  const trimmed = prompt.trimStart()
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  return {
    command: normalizeCommandName(match[1]),
    argumentsText: match[2]?.trim() ?? '',
  }
}

function dedupeSlashItems(items: AgentContextSlashItem[]): AgentContextSlashItem[] {
  const seen = new Set<string>()
  const output: AgentContextSlashItem[] = []
  for (const item of items) {
    const key = `${item.source}:${item.scope}:${item.command}:${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function dedupeAgentItems(items: AgentContextAgentItem[]): AgentContextAgentItem[] {
  const seen = new Set<string>()
  const output: AgentContextAgentItem[] = []
  for (const item of items) {
    const key = `${item.source}:${item.scope}:${item.name}:${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function dedupeInstructionFiles(items: AgentInstructionFile[]): AgentInstructionFile[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.path)) return false
    seen.add(item.path)
    return true
  })
}

function sortSlashItems(items: AgentContextSlashItem[]): AgentContextSlashItem[] {
  return [...items].sort(
    (a, b) =>
      scopeRank(a.scope) - scopeRank(b.scope) ||
      sourceRank(a.source) - sourceRank(b.source) ||
      a.command.localeCompare(b.command) ||
      a.relativePath.localeCompare(b.relativePath),
  )
}

function sortAgentItems(items: AgentContextAgentItem[]): AgentContextAgentItem[] {
  return [...items].sort(
    (a, b) =>
      scopeRank(a.scope) - scopeRank(b.scope) ||
      sourceRank(a.source) - sourceRank(b.source) ||
      a.name.localeCompare(b.name) ||
      a.relativePath.localeCompare(b.relativePath),
  )
}

function sortInstructionFiles(items: AgentInstructionFile[]): AgentInstructionFile[] {
  return [...items].sort(
    (a, b) =>
      scopeRank(a.scope) - scopeRank(b.scope) ||
      sourceRank(a.source) - sourceRank(b.source) ||
      a.relativePath.localeCompare(b.relativePath),
  )
}

function scopeRank(scope: AgentContextScope): number {
  return scope === 'project' ? 0 : 1
}

function sourceRank(source: AgentContextSource): number {
  if (source === 'claude') return 0
  if (source === 'agents') return 1
  if (source === 'agent') return 2
  return 3
}

function matchesQuery(name: string, relativePath: string, query: string): boolean {
  if (!query) return true
  return scorePathMatch(name, query) > 0 || scorePathMatch(relativePath, query) > 0
}

function scoreFileSearchItem(item: ProjectFileSearchItem, query: string): number {
  if (!query) return item.type === 'file' ? 2 : 1
  let score = scorePathMatch(item.label, query) * 1.7 + scorePathMatch(item.relativePath, query)
  if (item.type === 'directory') score += 8
  else score += 4
  score -= item.relativePath.length / 1000
  return score
}

function scorePathMatch(value: string, query: string): number {
  const normalizedValue = normalizeQuery(value)
  if (!query) return 1
  if (!normalizedValue) return 0
  if (normalizedValue === query) return 120
  if (normalizedValue.startsWith(query)) return 90
  const index = normalizedValue.indexOf(query)
  if (index >= 0) return 62 - Math.min(index, 42)
  return fuzzyPathScore(normalizedValue, query)
}

function fuzzyPathScore(value: string, query: string): number {
  let lastIndex = -1
  let score = 0
  for (const char of query) {
    const index = value.indexOf(char, lastIndex + 1)
    if (index === -1) return 0
    score += index === lastIndex + 1 ? 10 : 5
    if (index === 0 || '/-_ .'.includes(value[index - 1] ?? '')) score += 6
    lastIndex = index
  }
  return Math.max(1, score - value.length / 16)
}

function normalizeCommandName(value: string): string {
  return value
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/')
}

function formatContextRelativePath(filePath: string, sourceRoot: ContextSourceRoot): string {
  if (sourceRoot.scope === 'user') {
    return `~/${normalizeRelativePath(path.relative(os.homedir(), filePath))}`
  }
  return normalizeRelativePath(path.relative(sourceRoot.projectRoot, filePath))
}

function formatScope(scope: AgentContextScope): string {
  return scope === 'user' ? 'user' : 'project'
}

function recentDailyMemoryFileNames(): string[] {
  return [0, -1].map((offset) => `${formatLocalDate(addDays(new Date(), offset))}.md`)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function readTextFile(filePath: string, maxChars: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8')
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[truncated by host]` : content
}

async function safeReadDir(directoryPath: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
}
