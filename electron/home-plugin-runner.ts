/**
 * 项目首页 Home Plugin 只读运行器。
 * Read-only runner for per-project Home Plugins under `.agents/home-plugins/`.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { formatProjectPathError, resolveProjectPath } from './project-path'
import type {
  HomePluginCardSize,
  HomePluginCardLayoutItem,
  HomePluginDeleteResult,
  HomePluginManifest,
  HomePluginLayoutSaveResult,
  HomePluginOrderSaveResult,
  HomePluginRunItem,
  HomePluginRunOptions,
  HomePluginRunResult,
} from '../src/desktop-types'

const HOME_PLUGIN_ROOT_DIR = '.agents/home-plugins'
const HOME_PLUGIN_ENTRY = 'extractor.js'
const HOME_PLUGIN_MANIFEST = 'manifest.json'
const HOME_PLUGIN_ORDER = 'order.json'
const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json'
const HOME_SURFACE_ID = 'project-home'
const TODO_HOME_PLUGIN_SLUG = 'todo-md'
const TODO_HOME_PLUGIN_ID = 'agentos.todo-card'
const CARD_SIZES: HomePluginCardSize[] = ['small', 'medium', 'large']
const MAX_LIST_FILES = 1200
const MAX_READ_BYTES = 256 * 1024
const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024
const MAX_SQLITE_ROWS = 100
const MAX_SQLITE_OUTPUT_BYTES = 512 * 1024
const RUN_TIMEOUT_MS = 5000
const IGNORED_DIRECTORIES = new Set([
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

type HomePluginHost = {
  projectRoot: string
  today: string
  listFiles: (
    pathOrOptions?: string | HomePluginListOptions,
    options?: HomePluginListOptions,
  ) => Promise<HomePluginFileEntry[] | string[]>
  readText: (relativePath: string, maxChars?: number) => Promise<string>
  readJson: (relativePath: string, maxChars?: number) => Promise<unknown>
  querySqlite: (relativePath: string, sql: string, options?: { maxRows?: number }) => Promise<Record<string, unknown>[]>
  exists: (relativePath: string) => Promise<boolean>
  stat: (relativePath: string) => Promise<{ type: 'file' | 'directory'; size: number; modifiedAt: string } | null>
}

type HomePluginFileEntry = { path: string; type: 'file' | 'directory'; size?: number }
type HomePluginListOptions = { maxEntries?: number; maxDepth?: number; recursive?: boolean }

type HomePluginOutput = {
  version?: unknown
  messages?: unknown
  a2uiMessages?: unknown
  variants?: unknown
  diagnostics?: unknown
}

type TodoCardSummary = {
  phase: string
  progress: string
  currentTask: string
  nextStep: string
  blocker: string
  updatedAt: string
  completed: number
  total: number
  percent: number
  tasks: TodoCardTask[]
}

type TodoCardTask = {
  id: string
  title: string
  checked: boolean
  status: string
  priority: string
}

const outputHashCache = new Map<string, string>()
const execFileAsync = promisify(execFile)

/** 运行当前项目的 Home Plugin 卡片 / Run Home Plugin cards for the current project */
export async function runProjectHomePlugin(rootPath: string, options: HomePluginRunOptions = {}): Promise<HomePluginRunResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  const pluginRootPath = path.join(resolvedRootPath, HOME_PLUGIN_ROOT_DIR)

  try {
    const rootStat = await fs.stat(resolvedRootPath)
    if (!rootStat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, pluginPath: pluginRootPath, message: '当前项目路径不是文件夹' }
    }

    const builtinCards = await runBuiltInHomePluginCards(resolvedRootPath, options)

    if (!(await exists(pluginRootPath))) {
      clearPluginHashCache(resolvedRootPath)
      return {
        ok: true,
        rootPath: resolvedRootPath,
        pluginRootPath,
        status: builtinCards.length > 0 ? 'ready' : 'empty',
        plugins: builtinCards,
        order: builtinCards.map((plugin) => plugin.slug),
      }
    }

    const discovered = await discoverHomePlugins(resolvedRootPath, pluginRootPath)
    if (discovered.length === 0) {
      clearPluginHashCache(resolvedRootPath)
      return {
        ok: true,
        rootPath: resolvedRootPath,
        pluginRootPath,
        status: builtinCards.length > 0 ? 'ready' : 'empty',
        plugins: builtinCards,
        order: builtinCards.map((plugin) => plugin.slug),
      }
    }

    const order = await readHomePluginOrder(pluginRootPath)
    const plugins = sortPlugins(discovered, order)
    const runItems = [
      ...builtinCards,
      ...(await Promise.all(plugins.map((plugin) => runHomePluginCard(resolvedRootPath, plugin, options)))),
    ]
    const readyPlugins = runItems.filter((item) => item.status !== 'empty')
    const status = readyPlugins.length === 0 ? 'empty' : readyPlugins.every((item) => item.status === 'unchanged') ? 'unchanged' : 'ready'

    return {
      ok: true,
      rootPath: resolvedRootPath,
      pluginRootPath,
      status,
      plugins: runItems,
      order: [...builtinCards.map((plugin) => plugin.slug), ...plugins.map((plugin) => plugin.slug)],
    }
  } catch (error) {
    clearPluginHashCache(resolvedRootPath)
    return {
      ok: false,
      rootPath: resolvedRootPath,
      pluginPath: pluginRootPath,
      message: formatProjectPathError(error),
    }
  }
}

/** 保存 Home Plugin 卡片排序 / Persist Home Plugin card order */
export async function saveProjectHomePluginOrder(rootPath: string, order: unknown): Promise<HomePluginOrderSaveResult> {
  const result = await saveProjectHomePluginLayout(rootPath, order, [])
  if (result.ok) {
    return {
      ok: true,
      rootPath: result.rootPath,
      pluginRootPath: result.pluginRootPath,
      order: result.order,
    }
  }
  return result
}

/** 保存 Home Plugin 卡片排序与尺寸 / Persist Home Plugin card order and sizes */
export async function saveProjectHomePluginLayout(
  rootPath: string,
  order: unknown,
  cards: unknown,
): Promise<HomePluginLayoutSaveResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  const pluginRootPath = path.join(resolvedRootPath, HOME_PLUGIN_ROOT_DIR)
  try {
    const rootStat = await fs.stat(resolvedRootPath)
    if (!rootStat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, message: '当前项目路径不是文件夹' }
    }
    const discovered = await discoverHomePlugins(resolvedRootPath, pluginRootPath)
    const normalizedOrder = normalizeOrderPayload(order)
    const normalizedCards = normalizeLayoutCardsPayload(cards)
    const cardsBySlug = new Map(normalizedCards.map((item) => [item.slug, item.preferredSize]))
    const discoveredBySlug = new Map(discovered.map((item) => [item.slug, item]))
    const appendedOrder = discovered
      .map((item) => item.slug)
      .filter((slug) => !normalizedOrder.includes(slug))
      .sort((a, b) => comparePluginOrder(discoveredBySlug.get(a)?.manifest, discoveredBySlug.get(b)?.manifest))
    const finalOrder = [...normalizedOrder.filter((slug) => discoveredBySlug.has(slug)), ...appendedOrder]
    const orderIndex = new Map(finalOrder.map((slug, index) => [slug, index]))
    const updatedAt = new Date().toISOString()
    const cardsToSave = finalOrder.map((slug) => ({
      slug,
      preferredSize: cardsBySlug.get(slug) ?? discoveredBySlug.get(slug)?.manifest.preferredSize ?? 'medium',
    }))

    await fs.mkdir(pluginRootPath, { recursive: true })
    for (const plugin of discovered) {
      const preferredSize = cardsBySlug.get(plugin.slug) ?? plugin.manifest.preferredSize
      const nextManifest: HomePluginManifest = {
        ...plugin.manifest,
        preferredSize,
        order: orderIndex.get(plugin.slug) ?? plugin.manifest.order,
        updatedAt,
      }
      await fs.writeFile(
        path.join(plugin.pluginPath, HOME_PLUGIN_MANIFEST),
        `${JSON.stringify(nextManifest, null, 2)}\n`,
        'utf8',
      )
    }
    await fs.writeFile(path.join(pluginRootPath, HOME_PLUGIN_ORDER), `${JSON.stringify(finalOrder, null, 2)}\n`, 'utf8')
    return { ok: true, rootPath: resolvedRootPath, pluginRootPath, order: finalOrder, cards: cardsToSave }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      message: formatProjectPathError(error),
    }
  }
}

/** 删除单张 Home Plugin 卡片及本地文件 / Delete one Home Plugin card and its local files */
export async function deleteProjectHomePlugin(rootPath: string, rawSlug: unknown): Promise<HomePluginDeleteResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  const slug = typeof rawSlug === 'string' ? normalizePluginSlug(rawSlug) : ''
  const pluginRootPath = path.join(resolvedRootPath, HOME_PLUGIN_ROOT_DIR)
  if (!slug) {
    return { ok: false, rootPath: resolvedRootPath, message: '卡片标识无效' }
  }

  try {
    const rootStat = await fs.stat(resolvedRootPath)
    if (!rootStat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, slug, message: '当前项目路径不是文件夹' }
    }

    const pluginPath = path.join(pluginRootPath, slug)
    const relative = path.relative(pluginRootPath, pluginPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, rootPath: resolvedRootPath, slug, message: '卡片路径无效' }
    }

    const pluginStat = await fs.stat(pluginPath).catch(() => null)
    if (!pluginStat?.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, slug, message: '卡片文件夹不存在或已被删除' }
    }

    await fs.rm(pluginPath, { recursive: true, force: true })

    const order = (await readHomePluginOrder(pluginRootPath)).filter((item) => item !== slug)
    await fs.mkdir(pluginRootPath, { recursive: true })
    await fs.writeFile(path.join(pluginRootPath, HOME_PLUGIN_ORDER), `${JSON.stringify(order, null, 2)}\n`, 'utf8')
    outputHashCache.delete(pluginCacheKey(resolvedRootPath, slug))

    return { ok: true, rootPath: resolvedRootPath, pluginRootPath, slug, deletedPath: pluginPath, order }
  } catch (error) {
    return {
      ok: false,
      rootPath: resolvedRootPath,
      slug,
      message: formatProjectPathError(error),
    }
  }
}

type DiscoveredHomePlugin = {
  slug: string
  pluginPath: string
  entryPath: string
  manifest: HomePluginManifest
}

async function discoverHomePlugins(projectRoot: string, pluginRootPath: string): Promise<DiscoveredHomePlugin[]> {
  const entries = await fs.readdir(pluginRootPath, { withFileTypes: true }).catch(() => [])
  const plugins: DiscoveredHomePlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = normalizePluginSlug(entry.name)
    if (!slug) continue
    const pluginPath = path.join(pluginRootPath, entry.name)
    const manifestPath = path.join(pluginPath, HOME_PLUGIN_MANIFEST)
    const entryPath = path.join(pluginPath, HOME_PLUGIN_ENTRY)
    if (!(await exists(manifestPath)) || !(await exists(entryPath))) continue
    const manifest = normalizeManifest(slug, await readJsonFile(manifestPath), projectRoot, pluginPath)
    plugins.push({ slug, pluginPath, entryPath, manifest })
  }
  return plugins
}

async function runHomePluginCard(
  projectRoot: string,
  plugin: DiscoveredHomePlugin,
  options: HomePluginRunOptions,
): Promise<HomePluginRunItem> {
  const cacheKey = pluginCacheKey(projectRoot, plugin.slug)
  try {
    const code = await fs.readFile(plugin.entryPath, 'utf8')
    const diagnostics: string[] = []
    const output = await runExtractor(code, createHost(projectRoot), diagnostics)
    const variants = normalizeVariantMessages(output)
    const messages = variants[plugin.manifest.preferredSize] ?? variants.medium ?? variants.large ?? variants.small ?? []
    const outputHash = stableHash({ manifest: plugin.manifest, variants })
    outputHashCache.set(cacheKey, outputHash)
    const knownHash = options.knownOutputHashes?.[plugin.slug] ?? (plugin.slug === 'project-home' ? options.knownOutputHash : undefined)
    const status = knownHash && knownHash === outputHash ? 'unchanged' : messages.length > 0 ? 'ready' : 'empty'
    return {
      slug: plugin.slug,
      rootPath: projectRoot,
      pluginPath: plugin.pluginPath,
      manifest: plugin.manifest,
      status,
      outputHash,
      messages: status === 'unchanged' ? undefined : messages,
      variants: status === 'unchanged' ? undefined : variants,
      diagnostics: normalizeDiagnostics(output.diagnostics, diagnostics),
    }
  } catch (error) {
    outputHashCache.delete(cacheKey)
    return {
      slug: plugin.slug,
      rootPath: projectRoot,
      pluginPath: plugin.pluginPath,
      manifest: plugin.manifest,
      status: 'empty',
      diagnostics: [error instanceof Error ? error.message : String(error)],
    }
  }
}

async function runBuiltInHomePluginCards(
  projectRoot: string,
  options: HomePluginRunOptions,
): Promise<HomePluginRunItem[]> {
  const todoCard = await runTodoMdHomePluginCard(projectRoot, options)
  return todoCard ? [todoCard] : []
}

async function runTodoMdHomePluginCard(
  projectRoot: string,
  options: HomePluginRunOptions,
): Promise<HomePluginRunItem | null> {
  const todoPath = path.join(projectRoot, 'TODO.md')
  const stat = await fs.stat(todoPath).catch(() => null)
  if (!stat?.isFile()) return null

  const summary = parseTodoCardSummary(await fs.readFile(todoPath, 'utf8'))
  if (!summary) return null

  const manifest: HomePluginManifest = {
    id: TODO_HOME_PLUGIN_ID,
    name: 'TODO',
    version: '1.0.0',
    description: '从项目根目录 TODO.md 自动生成的进度卡片',
    entry: 'TODO.md',
    outputFormat: 'agentos.todo-card.v1',
    kind: 'data',
    preferredSize: 'medium',
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    order: -100,
  }
  const messages = createTodoCardMessages(summary)
  const outputHash = stableHash({ manifest, summary })
  outputHashCache.set(pluginCacheKey(projectRoot, TODO_HOME_PLUGIN_SLUG), outputHash)
  const knownHash = options.knownOutputHashes?.[TODO_HOME_PLUGIN_SLUG]
  const status = knownHash && knownHash === outputHash ? 'unchanged' : 'ready'

  return {
    slug: TODO_HOME_PLUGIN_SLUG,
    rootPath: projectRoot,
    pluginPath: todoPath,
    manifest,
    status,
    outputHash,
    messages: status === 'unchanged' ? undefined : messages,
    variants: status === 'unchanged' ? undefined : { small: messages, medium: messages, large: messages },
  }
}

function parseTodoCardSummary(markdown: string): TodoCardSummary | null {
  const section = extractMarkdownSection(markdown, /^##\s+0\.\s+首页卡片\s*$/m)
  if (!section) return null
  const fields = parseMarkdownTable(section)
  const required = ['当前阶段', '总进度', '当前主任务', '下一步', '阻塞项', '最近更新']
  if (required.some((field) => !fields.get(field))) return null

  const progress = fields.get('总进度') ?? ''
  const progressMatch = progress.match(/(\d+)\s*\/\s*(\d+)/)
  const percentMatch = progress.match(/(\d+(?:\.\d+)?)\s*%/)
  const completed = progressMatch ? Number(progressMatch[1]) : 0
  const total = progressMatch ? Number(progressMatch[2]) : 0
  const percent = percentMatch
    ? clampNumber(Number(percentMatch[1]), 0, 100, 0)
    : total > 0
      ? Math.round((completed / total) * 100)
      : 0

  return {
    phase: fields.get('当前阶段') ?? '',
    progress,
    currentTask: fields.get('当前主任务') ?? '',
    nextStep: fields.get('下一步') ?? '',
    blocker: fields.get('阻塞项') ?? '',
    updatedAt: fields.get('最近更新') ?? '',
    completed,
    total,
    percent,
    tasks: parseTodoTasks(markdown),
  }
}

function extractMarkdownSection(markdown: string, headingPattern: RegExp): string {
  const match = headingPattern.exec(markdown)
  if (!match || match.index === undefined) return ''
  const start = match.index + match[0].length
  const rest = markdown.slice(start)
  const nextHeading = rest.search(/^##\s+/m)
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest
}

function parseMarkdownTable(markdown: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    if (cells.length < 2 || cells[0] === '字段' || /^-+$/.test(cells[0])) continue
    fields.set(cells[0], cells.slice(1).join(' | '))
  }
  return fields
}

function parseTodoTasks(markdown: string): TodoCardTask[] {
  const lines = markdown.split(/\r?\n/)
  const tasks: TodoCardTask[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^- \[([ xX])\]\s+(T\d+)\.\s+(.+?)\s*$/)
    if (!match) continue
    const detailLines = lines.slice(index + 1, index + 8)
    const status = readTodoTaskField(detailLines, '状态') || (match[1].toLowerCase() === 'x' ? 'done' : 'todo')
    const priority = readTodoTaskField(detailLines, '优先级')
    tasks.push({
      id: match[2],
      title: match[3].trim(),
      checked: match[1].toLowerCase() === 'x',
      status,
      priority,
    })
  }
  return tasks.slice(0, 24)
}

function readTodoTaskField(lines: string[], field: string): string {
  const prefix = `- ${field}：`
  const line = lines.find((item) => item.trim().startsWith(prefix))
  return line ? line.trim().slice(prefix.length).trim() : ''
}

function createTodoCardMessages(summary: TodoCardSummary): unknown[] {
  return [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: HOME_SURFACE_ID,
        catalogId: BASIC_CATALOG_ID,
      },
    },
    {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: HOME_SURFACE_ID,
        path: '/',
        value: { todo: summary },
      },
    },
  ]
}

function normalizeVariantMessages(output: HomePluginOutput): Partial<Record<HomePluginCardSize, unknown[]>> {
  const rawVariants = isRecord(output.variants) ? output.variants : {}
  const variants: Partial<Record<HomePluginCardSize, unknown[]>> = {}
  for (const size of CARD_SIZES) {
    const messages = normalizeMessages(rawVariants[size])
    if (messages.length > 0) variants[size] = messages
  }
  const fallback = normalizeMessages(output.messages ?? output.a2uiMessages)
  if (fallback.length > 0) {
    for (const size of CARD_SIZES) {
      if (!variants[size]) variants[size] = fallback
    }
  }
  return variants
}

function normalizeManifest(slug: string, raw: unknown, projectRoot: string, pluginPath: string): HomePluginManifest {
  const value = isRecord(raw) ? raw : {}
  const modifiedAt = new Date().toISOString()
  const relativePluginPath = normalizeRelativePath(path.relative(projectRoot, pluginPath))
  const preferredSize = normalizeCardSize(value.preferredSize)
  return {
    id: stringOr(value.id, `agentos.${slug}`),
    name: stringOr(value.name, titleFromSlug(slug)),
    version: stringOr(value.version, '1.0.0'),
    description: stringOr(value.description, `Home Plugin card from ${relativePluginPath}`),
    entry: stringOr(value.entry, HOME_PLUGIN_ENTRY),
    outputFormat: stringOr(value.outputFormat, 'a2ui.v0.9'),
    kind: value.kind === 'task' ? 'task' : 'data',
    preferredSize,
    threadId: stringOr(value.threadId, undefined),
    createdAt: stringOr(value.createdAt, undefined),
    updatedAt: stringOr(value.updatedAt, modifiedAt),
    order: typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : undefined,
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function readHomePluginOrder(pluginRootPath: string): Promise<string[]> {
  try {
    return normalizeOrderPayload(JSON.parse(await fs.readFile(path.join(pluginRootPath, HOME_PLUGIN_ORDER), 'utf8')))
  } catch {
    return []
  }
}

function sortPlugins(plugins: DiscoveredHomePlugin[], order: string[]): DiscoveredHomePlugin[] {
  const orderIndex = new Map(order.map((slug, index) => [slug, index]))
  return [...plugins].sort((a, b) => {
    const ao = orderIndex.get(a.slug)
    const bo = orderIndex.get(b.slug)
    if (ao !== undefined || bo !== undefined) return (ao ?? Number.MAX_SAFE_INTEGER) - (bo ?? Number.MAX_SAFE_INTEGER)
    const explicit = (a.manifest.order ?? Number.MAX_SAFE_INTEGER) - (b.manifest.order ?? Number.MAX_SAFE_INTEGER)
    if (explicit !== 0) return explicit
    return (Date.parse(a.manifest.createdAt ?? '') || 0) - (Date.parse(b.manifest.createdAt ?? '') || 0) || a.slug.localeCompare(b.slug)
  })
}

function normalizeOrderPayload(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of value) {
    const slug = typeof item === 'string' ? normalizePluginSlug(item) : ''
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    output.push(slug)
  }
  return output
}

function normalizeLayoutCardsPayload(value: unknown): HomePluginCardLayoutItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const output: HomePluginCardLayoutItem[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const slug = typeof item.slug === 'string' ? normalizePluginSlug(item.slug) : ''
    const preferredSize = normalizeCardSize(item.preferredSize)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    output.push({ slug, preferredSize })
  }
  return output
}

function comparePluginOrder(a?: HomePluginManifest, b?: HomePluginManifest): number {
  const ao = a?.order ?? Number.MAX_SAFE_INTEGER
  const bo = b?.order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  const ac = Date.parse(a?.createdAt ?? '') || 0
  const bc = Date.parse(b?.createdAt ?? '') || 0
  if (ac !== bc) return ac - bc
  return (a?.id ?? '').localeCompare(b?.id ?? '')
}

function normalizePluginSlug(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function normalizeCardSize(value: unknown): HomePluginCardSize {
  return value === 'small' || value === 'medium' || value === 'large' ? value : 'medium'
}

function pluginCacheKey(projectRoot: string, slug: string): string {
  return `${projectRoot}::${slug}`
}

function clearPluginHashCache(projectRoot: string): void {
  for (const key of outputHashCache.keys()) {
    if (key === projectRoot || key.startsWith(`${projectRoot}::`)) outputHashCache.delete(key)
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Data Card'
}

async function runExtractor(code: string, host: HomePluginHost, diagnostics: string[]): Promise<HomePluginOutput> {
  if (/\b(import|require|process|fetch|XMLHttpRequest|WebSocket)\b/.test(code)) {
    throw new Error('Home Plugin extractor 不能使用 import、require、process、fetch 或网络 API。')
  }

  const script = new vm.Script(`${code}\n;run`, { filename: HOME_PLUGIN_ENTRY })
  const context = vm.createContext(
    {
      console: {
        log: (...args: unknown[]) => diagnostics.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) => diagnostics.push(args.map(String).join(' ')),
      },
      Date,
      JSON,
      Math,
      Promise,
      RegExp,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Map,
      Set,
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    },
  )
  const run = script.runInContext(context, { timeout: 1000 })
  if (typeof run !== 'function') throw new Error('extractor.js 必须定义 async function run(host)。')

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Home Plugin extractor 运行超时。')), RUN_TIMEOUT_MS)
  })
  const output = await Promise.race([Promise.resolve(run(host)), timeout])
  if (!isRecord(output)) throw new Error('Home Plugin extractor 必须返回 JSON object。')
  return output
}

function createHost(projectRoot: string): HomePluginHost {
  let totalReadBytes = 0
  const readText: HomePluginHost['readText'] = async (relativePath, maxChars) => {
    const filePath = resolveInsideProject(projectRoot, relativePath)
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`${relativePath} 不是文件`)
    if (stat.size > MAX_READ_BYTES) throw new Error(`${relativePath} 超过单文件读取上限`)
    totalReadBytes += stat.size
    if (totalReadBytes > MAX_TOTAL_READ_BYTES) throw new Error('Home Plugin 超过本次总读取上限')
    const content = await fs.readFile(filePath, 'utf8')
    const limit = Number.isFinite(maxChars) && maxChars ? Math.max(0, Math.trunc(maxChars)) : content.length
    return content.slice(0, limit)
  }

  return {
    projectRoot,
    today: formatLocalDate(new Date()),
    listFiles: async (pathOrOptions, options) => {
      if (typeof pathOrOptions === 'string') {
        const directoryPath = resolveInsideProject(projectRoot, pathOrOptions)
        const stat = await fs.stat(directoryPath).catch(() => null)
        if (!stat?.isDirectory()) return []
        const entries = await listProjectFiles(directoryPath, options)
        return entries.map((entry) => entry.path)
      }
      return listProjectFiles(projectRoot, pathOrOptions)
    },
    readText,
    readJson: async (relativePath, maxChars) => JSON.parse(await readText(relativePath, maxChars)),
    querySqlite: async (relativePath, sql, options) => querySqlite(projectRoot, relativePath, sql, options),
    exists: async (relativePath) => exists(resolveInsideProject(projectRoot, relativePath)),
    stat: async (relativePath) => {
      try {
        const stat = await fs.stat(resolveInsideProject(projectRoot, relativePath))
        return {
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        }
      } catch {
        return null
      }
    },
  }
}

async function listProjectFiles(
  projectRoot: string,
  options: HomePluginListOptions = {},
): Promise<HomePluginFileEntry[]> {
  const maxEntries = clampNumber(options.maxEntries, 1, MAX_LIST_FILES, 400)
  const maxDepth = options.recursive ? 8 : clampNumber(options.maxDepth, 0, 8, 4)
  const items: HomePluginFileEntry[] = []

  const walk = async (directoryPath: string, relativeBase: string, depth: number): Promise<void> => {
    if (depth > maxDepth || items.length >= maxEntries) return
    const entries = await fs.readdir(directoryPath, { withFileTypes: true })
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (items.length >= maxEntries) break
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const entryPath = path.join(directoryPath, entry.name)
      const relativePath = normalizeRelativePath(path.join(relativeBase, entry.name))
      if (entry.isDirectory()) {
        items.push({ path: relativePath, type: 'directory' })
        await walk(entryPath, relativePath, depth + 1)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.stat(entryPath).catch(() => null)
        items.push({ path: relativePath, type: 'file', size: stat?.size })
      }
    }
  }

  await walk(projectRoot, '', 0)
  return items
}

async function querySqlite(
  projectRoot: string,
  relativePath: string,
  sql: string,
  options: { maxRows?: number } = {},
): Promise<Record<string, unknown>[]> {
  const dbPath = resolveInsideProject(projectRoot, relativePath)
  const stat = await fs.stat(dbPath)
  if (!stat.isFile()) throw new Error(`${relativePath} 不是 SQLite 文件`)
  if (!isReadOnlySql(sql)) throw new Error('Home Plugin SQLite 只允许 SELECT/WITH 查询和少量 PRAGMA 元数据查询。')

  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql.trim()], {
    encoding: 'utf8',
    maxBuffer: MAX_SQLITE_OUTPUT_BYTES,
    timeout: RUN_TIMEOUT_MS,
  })
  const parsed = stdout.trim() ? JSON.parse(stdout) : []
  if (!Array.isArray(parsed)) return []
  const maxRows = clampNumber(options.maxRows, 1, MAX_SQLITE_ROWS, MAX_SQLITE_ROWS)
  return parsed.filter(isRecord).slice(0, maxRows)
}

function isReadOnlySql(sql: string): boolean {
  if (typeof sql !== 'string') return false
  const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (!normalized) return false
  if (/[;]/.test(normalized.replace(/;\s*$/, ''))) return false
  if (/\b(attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze)\b/i.test(normalized)) return false
  return /^(select|with)\b/i.test(normalized) || /^pragma\s+(table_info|database_list|index_list|foreign_key_list|user_version|schema_version)\b/i.test(normalized)
}

function normalizeMessages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  const messages = dedupeCreateSurfaceMessages(value.flatMap(normalizeA2uiMessage).filter(isA2uiMessage))
  if (messages.length === 0) return []
  const hasCreateSurface = messages.some((message) => isRecord(message) && isRecord(message.createSurface))
  const normalized = hasCreateSurface
    ? messages
    : [
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: HOME_SURFACE_ID,
            catalogId: BASIC_CATALOG_ID,
          },
        },
        ...messages,
      ]
  return [
    ...normalized.filter((message) => isRecord(message) && isRecord(message.createSurface)),
    ...normalized.filter((message) => !(isRecord(message) && isRecord(message.createSurface))),
  ]
}

function normalizeA2uiMessage(value: unknown): unknown[] {
  if (isA2uiMessage(value)) {
    const message = value as Record<string, unknown>
    if (isRecord(message.updateComponents)) return normalizeWrappedUpdateComponents(message.updateComponents)
    if (isRecord(message.updateDataModel)) return normalizeWrappedUpdateDataModel(message.updateDataModel)
    if (isRecord(message.createSurface)) return [normalizeWrappedMessage('createSurface', message.createSurface)]
    if (isRecord(message.deleteSurface)) return [normalizeWrappedMessage('deleteSurface', message.deleteSurface)]
    return [value]
  }
  if (!isRecord(value)) return []

  if (isRecord(value.createSurface)) {
    return [normalizeWrappedMessage('createSurface', value.createSurface)]
  }
  if (isRecord(value.updateComponents)) {
    return normalizeWrappedUpdateComponents(value.updateComponents)
  }
  if (isRecord(value.updateDataModel)) {
    return normalizeWrappedUpdateDataModel(value.updateDataModel)
  }
  if (isRecord(value.deleteSurface)) {
    return [normalizeWrappedMessage('deleteSurface', value.deleteSurface)]
  }

  if (value.type === 'createSurface') {
    return [
      {
        version: 'v0.9',
        createSurface: {
          surfaceId: stringOr(value.surfaceId, HOME_SURFACE_ID),
          catalogId: value.catalogId === BASIC_CATALOG_ID ? BASIC_CATALOG_ID : BASIC_CATALOG_ID,
        },
      },
    ]
  }
  if (value.type === 'updateComponents') return normalizeWrappedUpdateComponents(value)
  if (value.type === 'updateDataModel') return normalizeWrappedUpdateDataModel(value)
  if (value.type === 'deleteSurface') {
    return [{ version: 'v0.9', deleteSurface: { surfaceId: stringOr(value.surfaceId, HOME_SURFACE_ID) } }]
  }
  return []
}

function normalizeWrappedMessage(kind: 'createSurface' | 'deleteSurface', payload: Record<string, unknown>): unknown {
  if (kind === 'createSurface') {
    return {
      version: 'v0.9',
      createSurface: {
        surfaceId: stringOr(payload.surfaceId, HOME_SURFACE_ID),
        catalogId: payload.catalogId === BASIC_CATALOG_ID ? BASIC_CATALOG_ID : BASIC_CATALOG_ID,
      },
    }
  }
  return { version: 'v0.9', deleteSurface: { surfaceId: stringOr(payload.surfaceId, HOME_SURFACE_ID) } }
}

function normalizeWrappedUpdateComponents(payload: Record<string, unknown>): unknown[] {
  const surfaceId = stringOr(payload.surfaceId, HOME_SURFACE_ID)
  const components: unknown[] = []

  if (Array.isArray(payload.components)) {
    components.push(...flattenComponents(payload.components))
  }

  if (Array.isArray(payload.updates)) {
    for (const update of payload.updates) {
      if (!isRecord(update)) continue
      if (Array.isArray(update.components)) components.push(...flattenComponents(update.components))
      if (isRecord(update.component)) components.push(...flattenComponentTree(update.component, update.slot === 'root' ? 'root' : undefined))
    }
  }

  if (components.length === 0) return []
  return [{ version: 'v0.9', updateComponents: { surfaceId, components } }]
}

function normalizeWrappedUpdateDataModel(payload: Record<string, unknown>): unknown[] {
  const surfaceId = stringOr(payload.surfaceId, HOME_SURFACE_ID)
  if (Array.isArray(payload.updates)) {
    return payload.updates.filter(isRecord).map((update) => ({
      version: 'v0.9',
      updateDataModel: {
        surfaceId,
        path: toJsonPointer(update.path),
        value: update.value,
      },
    }))
  }
  return [
    {
      version: 'v0.9',
      updateDataModel: {
        surfaceId,
        path: typeof payload.path === 'string' ? toJsonPointer(payload.path) : undefined,
        value: payload.value,
      },
    },
  ]
}

function flattenComponents(values: unknown[]): Record<string, unknown>[] {
  const state = createFlattenState()
  return values.flatMap((value, index) => {
    if (isFlatComponentNode(value)) return [normalizeFlatComponentNode(value)]
    return flattenComponentNode(value, index === 0 ? 'root' : undefined, state)
  })
}

function flattenComponentTree(value: unknown, preferredId?: string): Record<string, unknown>[] {
  return flattenComponentNode(value, preferredId, createFlattenState())
}

function flattenComponentNode(value: unknown, preferredId: string | undefined, state: { count: number; usedIds: Set<string> }): Record<string, unknown>[] {
  if (!isRecord(value)) return []
  const component = stringOr(value.component, stringOr(value.type, ''))
  if (!component) return []

  const id = uniqueComponentId(stringOr(value.id, preferredId ?? `node-${++state.count}`), state.usedIds)
  const output: Record<string, unknown> = { id, component }
  const childGroups: Record<string, unknown>[][] = []
  const childIds: string[] = []
  if (typeof value.child === 'string') {
    childIds.push(value.child)
  } else if (isRecord(value.child)) {
    const flattened = flattenComponentNode(value.child, undefined, state)
    if (flattened.length > 0) {
      childGroups.push(flattened)
      if (typeof flattened[0].id === 'string') childIds.push(flattened[0].id)
    }
  }
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      if (typeof child === 'string') {
        childIds.push(child)
        continue
      }
      const flattened = flattenComponentNode(child, undefined, state)
      if (flattened.length === 0) continue
      childGroups.push(flattened)
      if (typeof flattened[0].id === 'string') childIds.push(flattened[0].id)
    }
  }
  const childComponents = childGroups.flat()

  for (const [key, raw] of Object.entries(value)) {
    if (['id', 'component', 'type', 'children', 'child', 'content', 'binding', 'style', 'itemsId'].includes(key)) continue
    output[key] = raw
  }
  const normalizedAction = normalizeActionPayload(output.action)
  if (normalizedAction === undefined) delete output.action
  else output.action = normalizedAction

  if (component === 'Text') {
    const bindingPath = dataBindingPath(value.binding)
    if (bindingPath) {
      output.text = { path: bindingPath }
    } else if ('text' in value) {
      output.text = value.text
    } else {
      output.text = stringOr(value.content, '')
    }
    const variant = textVariantFromStyle(value.style)
    if (variant && !output.variant) output.variant = variant
  } else if (component === 'Card') {
    if (childIds.length === 1) {
      output.child = childIds[0]
    } else if (childIds.length > 1) {
      const wrapperId = uniqueComponentId(`${id}-content`, state.usedIds)
      childComponents.push({ id: wrapperId, component: 'Column', children: childIds })
      output.child = wrapperId
    }
  } else if (component === 'Button' && childIds.length > 0) {
    output.child = childIds[0]
  } else if (childIds.length > 0) {
    output.children = childIds
  }

  return [output, ...childComponents]
}

function isFlatComponentNode(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.component !== 'string') return false
  if (isRecord(value.child)) return false
  if (Array.isArray(value.children) && value.children.some(isRecord)) return false
  if (Array.isArray(value.tabs) && value.tabs.some((tab) => isRecord(tab) && isRecord(tab.child))) return false
  return true
}

function normalizeFlatComponentNode(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value }
  const normalizedAction = normalizeActionPayload(output.action)
  if (normalizedAction === undefined) delete output.action
  else output.action = normalizedAction
  return output
}

function createFlattenState(): { count: number; usedIds: Set<string> } {
  return { count: 0, usedIds: new Set() }
}

function dedupeCreateSurfaceMessages(messages: unknown[]): unknown[] {
  const seenSurfaceIds = new Set<string>()
  return messages.filter((message) => {
    if (!isRecord(message) || !isRecord(message.createSurface)) return true
    const surfaceId = stringOr(message.createSurface.surfaceId, HOME_SURFACE_ID)
    if (seenSurfaceIds.has(surfaceId)) return false
    seenSurfaceIds.add(surfaceId)
    return true
  })
}

function isA2uiMessage(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 'v0.9') return false
  const kinds = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].filter((kind) => kind in value)
  if (kinds.length !== 1) return false
  if ('createSurface' in value) {
    const payload = value.createSurface
    return isRecord(payload) && typeof payload.surfaceId === 'string' && payload.catalogId === BASIC_CATALOG_ID
  }
  if ('updateComponents' in value) {
    const payload = value.updateComponents
    return isRecord(payload) && typeof payload.surfaceId === 'string' && Array.isArray(payload.components)
  }
  if ('updateDataModel' in value) {
    const payload = value.updateDataModel
    return isRecord(payload) && typeof payload.surfaceId === 'string'
  }
  if ('deleteSurface' in value) {
    const payload = value.deleteSurface
    return isRecord(payload) && typeof payload.surfaceId === 'string'
  }
  return false
}

function stringOr<T extends string | undefined>(value: unknown, fallback: T): string | T {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function toJsonPointer(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  if (raw === '/') return '/'
  const withoutPrefix = raw.startsWith('/') ? raw.slice(1) : raw
  const segments = withoutPrefix
    .split(/[./]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'))
  return segments.length ? `/${segments.join('/')}` : '/'
}

function dataBindingPath(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const rawPath = typeof value.$data === 'string' ? value.$data : value.path
  return toJsonPointer(rawPath)
}

function normalizeActionPayload(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.event)) return value
  const event = value.event
  let context: unknown = event.context
  if (isRecord(event.context)) {
    const normalizedContext = Object.fromEntries(
      Object.entries(event.context).map(([key, raw]) => [key, normalizeActionContextValue(raw)]),
    )
    if (event.name === 'open_file' && 'path' in normalizedContext) {
      if (!('filePath' in normalizedContext)) normalizedContext.filePath = normalizedContext.path
      delete normalizedContext.path
    }
    context = normalizedContext
  }
  return {
    ...value,
    event: {
      ...event,
      ...(context ? { context } : {}),
    },
  }
}

function normalizeActionContextValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (typeof value.$data === 'string') return { path: toJsonPointer(value.$data) }
  if (!('path' in value)) return value

  const rawPath = value.path
  if (typeof rawPath === 'string') return { ...value, path: toJsonPointer(rawPath) }
  if (isRecord(rawPath)) {
    const nestedPath = typeof rawPath.path === 'string' ? rawPath.path : typeof rawPath.$data === 'string' ? rawPath.$data : ''
    if (nestedPath) return { ...value, path: toJsonPointer(nestedPath) }
  }
  return value
}

function textVariantFromStyle(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const fontSize = typeof value.fontSize === 'string' ? value.fontSize : ''
  const fontWeight = typeof value.fontWeight === 'string' ? value.fontWeight : ''
  if (fontSize === 'large') return fontWeight === 'bold' ? 'h2' : 'h3'
  if (fontSize === 'medium') return fontWeight === 'bold' ? 'h3' : 'body'
  if (fontSize === 'small') return 'caption'
  return undefined
}

function uniqueComponentId(rawId: string, usedIds: Set<string>): string {
  const base = rawId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node'
  let id = base
  let index = 2
  while (usedIds.has(id)) {
    id = `${base}-${index}`
    index += 1
  }
  usedIds.add(id)
  return id
}

function normalizeDiagnostics(pluginDiagnostics: unknown, runnerDiagnostics: string[]): string[] | undefined {
  const output = [
    ...runnerDiagnostics,
    ...(Array.isArray(pluginDiagnostics) ? pluginDiagnostics.filter((item): item is string => typeof item === 'string') : []),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
  return output.length ? output : undefined
}

function resolveInsideProject(projectRoot: string, value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少文件路径')
  const resolved = path.resolve(projectRoot, value)
  const relative = path.relative(projectRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Home Plugin 不能读取项目外路径：${value}`)
  }
  return resolved
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
