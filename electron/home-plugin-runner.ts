/**
 * 项目首页 Home Plugin 只读运行器。
 * Read-only runner for per-project Home Plugins under `.agents/home-plugins/`.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HomePluginRunOptions, HomePluginRunResult } from '../src/desktop-types'

const HOME_PLUGIN_DIR = '.agents/home-plugins/project-home'
const HOME_PLUGIN_ENTRY = 'extractor.js'
const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json'
const HOME_SURFACE_ID = 'project-home'
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
  diagnostics?: unknown
}

const outputHashCache = new Map<string, string>()
const execFileAsync = promisify(execFile)

/** 运行当前项目的默认首页插件 / Run the current project's default home plugin */
export async function runProjectHomePlugin(rootPath: string, options: HomePluginRunOptions = {}): Promise<HomePluginRunResult> {
  const resolvedRootPath = resolveProjectPath(rootPath)
  const pluginPath = path.join(resolvedRootPath, HOME_PLUGIN_DIR)
  const entryPath = path.join(pluginPath, HOME_PLUGIN_ENTRY)

  try {
    const rootStat = await fs.stat(resolvedRootPath)
    if (!rootStat.isDirectory()) {
      return { ok: false, rootPath: resolvedRootPath, pluginPath, message: '当前项目路径不是文件夹' }
    }

    if (!(await exists(entryPath))) {
      outputHashCache.delete(resolvedRootPath)
      return { ok: true, rootPath: resolvedRootPath, pluginPath, status: 'empty' }
    }

    const code = await fs.readFile(entryPath, 'utf8')
    const diagnostics: string[] = []
    const output = await runExtractor(code, createHost(resolvedRootPath), diagnostics)
    const messages = normalizeMessages(output.messages ?? output.a2uiMessages)
    if (messages.length === 0) {
      outputHashCache.delete(resolvedRootPath)
      return { ok: true, rootPath: resolvedRootPath, pluginPath, status: 'empty', diagnostics: normalizeDiagnostics(output.diagnostics, diagnostics) }
    }

    const outputHash = stableHash(messages)
    outputHashCache.set(resolvedRootPath, outputHash)
    if (options.knownOutputHash && options.knownOutputHash === outputHash) {
      return {
        ok: true,
        rootPath: resolvedRootPath,
        pluginPath,
        status: 'unchanged',
        outputHash,
        diagnostics: normalizeDiagnostics(output.diagnostics, diagnostics),
      }
    }

    return {
      ok: true,
      rootPath: resolvedRootPath,
      pluginPath,
      status: 'ready',
      outputHash,
      messages,
      diagnostics: normalizeDiagnostics(output.diagnostics, diagnostics),
    }
  } catch (error) {
    outputHashCache.delete(resolvedRootPath)
    return {
      ok: false,
      rootPath: resolvedRootPath,
      pluginPath,
      message: error instanceof Error ? error.message : String(error),
    }
  }
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

function stringOr(value: unknown, fallback: string): string {
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

function resolveProjectPath(projectPath: string): string {
  const trimmedPath = projectPath.trim()
  if (trimmedPath === '~') return os.homedir()
  if (trimmedPath.startsWith(`~${path.sep}`) || trimmedPath.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmedPath.slice(2))
  }
  return path.resolve(trimmedPath)
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
