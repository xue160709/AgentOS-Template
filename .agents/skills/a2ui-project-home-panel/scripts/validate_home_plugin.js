#!/usr/bin/env node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import vm from 'node:vm'

const execFileAsync = promisify(execFile)
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
const ALLOWED_COMPONENTS = new Set([
  'AudioPlayer',
  'Button',
  'Card',
  'CheckBox',
  'ChoicePicker',
  'Column',
  'DateTimeInput',
  'Divider',
  'Icon',
  'Image',
  'List',
  'Modal',
  'Row',
  'Slider',
  'Tabs',
  'Text',
  'TextField',
  'Video',
])
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

async function main() {
  const args = process.argv.slice(2)
  const allowMissing = args.includes('--allow-missing')
  const rootArg = args.find((arg) => !arg.startsWith('--'))
  const projectRoot = path.resolve(rootArg || process.cwd())
  const pluginDir = path.join(projectRoot, HOME_PLUGIN_DIR)
  const manifestPath = path.join(pluginDir, 'manifest.json')
  const entryPath = path.join(pluginDir, HOME_PLUGIN_ENTRY)
  const errors = []
  const warnings = []

  const manifest = await readJsonIfExists(manifestPath)
  if (!manifest) {
    errors.push(`Missing ${path.relative(projectRoot, manifestPath)}`)
  } else {
    if (!manifest.id) warnings.push('manifest.json has no id')
    if (manifest.entry !== HOME_PLUGIN_ENTRY) errors.push(`manifest.entry must be "${HOME_PLUGIN_ENTRY}"`)
  }

  const code = await fs.readFile(entryPath, 'utf8').catch(() => null)
  if (allowMissing && !manifest && !code) {
    console.log(`No Home Plugin found under ${HOME_PLUGIN_DIR}; skipped`)
    return
  }
  if (!code) {
    errors.push(`Missing ${path.relative(projectRoot, entryPath)}`)
    reportAndExit(errors, warnings)
  }

  if (/\b(import|require|process|fetch|XMLHttpRequest|WebSocket)\b/.test(code)) {
    errors.push('extractor.js uses a forbidden API: import, require, process, fetch, XMLHttpRequest, or WebSocket')
  }
  if (!/\basync\s+function\s+run\s*\(\s*host\s*\)/.test(code) && !/\bfunction\s+run\s*\(\s*host\s*\)/.test(code)) {
    errors.push('extractor.js must define function run(host)')
  }
  if (errors.length > 0) reportAndExit(errors, warnings)

  const diagnostics = []
  const output = await runExtractor(code, createHost(projectRoot), diagnostics).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  })
  if (!output) reportAndExit(errors, warnings)

  validateOutput(output, projectRoot, errors, warnings)
  for (const diagnostic of normalizeDiagnostics(output.diagnostics, diagnostics)) {
    warnings.push(`diagnostic: ${diagnostic}`)
  }

  reportAndExit(errors, warnings)
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function runExtractor(code, host, diagnostics) {
  const script = new vm.Script(`${code}\n;run`, { filename: HOME_PLUGIN_ENTRY })
  const context = vm.createContext(
    {
      console: {
        log: (...args) => diagnostics.push(args.map(String).join(' ')),
        warn: (...args) => diagnostics.push(args.map(String).join(' ')),
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
    { codeGeneration: { strings: false, wasm: false } },
  )
  const run = script.runInContext(context, { timeout: 1000 })
  if (typeof run !== 'function') throw new Error('extractor.js did not expose run(host)')
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('extractor.js timed out')), RUN_TIMEOUT_MS)
  })
  const output = await Promise.race([Promise.resolve(run(host)), timeout])
  if (!isRecord(output)) throw new Error('extractor.js must return a plain object')
  return output
}

function createHost(projectRoot) {
  let totalReadBytes = 0
  const readText = async (relativePath, maxChars) => {
    const filePath = resolveInsideProject(projectRoot, relativePath)
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`${relativePath} is not a file`)
    if (stat.size > MAX_READ_BYTES) throw new Error(`${relativePath} exceeds the single-file read limit`)
    totalReadBytes += stat.size
    if (totalReadBytes > MAX_TOTAL_READ_BYTES) throw new Error('extractor exceeded the total read limit')
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
    exists: async (relativePath) => fs.stat(resolveInsideProject(projectRoot, relativePath)).then(() => true, () => false),
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
    querySqlite: async (relativePath, sql, options = {}) => querySqlite(projectRoot, relativePath, sql, options),
  }
}

async function listProjectFiles(projectRoot, options = {}) {
  const maxEntries = clampNumber(options.maxEntries, 1, MAX_LIST_FILES, 400)
  const maxDepth = options.recursive ? 8 : clampNumber(options.maxDepth, 0, 8, 4)
  const items = []

  const walk = async (directoryPath, relativeBase, depth) => {
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

async function querySqlite(projectRoot, relativePath, sql, options = {}) {
  const dbPath = resolveInsideProject(projectRoot, relativePath)
  const stat = await fs.stat(dbPath)
  if (!stat.isFile()) throw new Error(`${relativePath} is not a SQLite file`)
  if (!isReadOnlySql(sql)) throw new Error('SQLite only allows SELECT/WITH and limited PRAGMA metadata queries')

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

function validateOutput(output, projectRoot, errors, warnings) {
  if (output.version !== 1) warnings.push('output.version should be 1')
  const messages = Array.isArray(output.messages ?? output.a2uiMessages) ? output.messages ?? output.a2uiMessages : []
  if (messages.length === 0) {
    errors.push('extractor returned no A2UI messages')
    return
  }

  const hasCreateSurface = messages.some((message) => {
    const payload = message?.createSurface
    return message?.version === 'v0.9' && payload?.surfaceId === HOME_SURFACE_ID && payload?.catalogId === BASIC_CATALOG_ID
  })
  if (!hasCreateSurface) errors.push('messages must include createSurface for project-home using the A2UI v0.9 basic catalog')

  const componentMessages = messages.filter((message) => message?.version === 'v0.9' && isRecord(message.updateComponents))
  if (componentMessages.length === 0) errors.push('messages must include updateComponents')

  const dataMessages = messages.filter((message) => message?.version === 'v0.9' && isRecord(message.updateDataModel))
  if (dataMessages.length === 0) errors.push('messages must include updateDataModel')
  const dataValues = dataMessages.map((message) => message.updateDataModel.value)

  const components = componentMessages.flatMap((message) => {
    const raw = message.updateComponents.components
    return Array.isArray(raw) ? raw : []
  })
  validateComponents(components, projectRoot, errors, warnings, dataValues)
}

function validateComponents(components, projectRoot, errors, warnings, dataValues = []) {
  const ids = new Set()
  let openFileActions = 0
  let fileLikeTextCount = 0
  let visualTextCount = 0

  for (const component of components) {
    if (!isRecord(component)) {
      errors.push('component entry must be an object')
      continue
    }
    if (typeof component.id !== 'string' || !component.id.trim()) errors.push('component missing string id')
    else if (ids.has(component.id)) errors.push(`duplicate component id: ${component.id}`)
    else ids.add(component.id)

    if (!ALLOWED_COMPONENTS.has(component.component)) errors.push(`unsupported component "${component.component}" at ${component.id}`)
    if ('content' in component && component.component === 'Text') errors.push(`Text component ${component.id} uses content; use text`)
    if (hasInlineChildren(component)) errors.push(`component ${component.id} inlines child objects; use flat id references`)
    if (component.component === 'Text' && typeof component.text === 'string' && /\S+\.(md|markdown|txt|json|csv|db|sqlite)\b/i.test(component.text)) {
      fileLikeTextCount += 1
    }
    if (component.component === 'Text' && typeof component.text === 'string' && /[█▇▆▅▄▃▂▁#=]{3,}/.test(component.text)) {
      visualTextCount += 1
    }
    if (isOpenFileAction(component.action)) {
      openFileActions += 1
      const context = component.action.event.context
      const rawPath = context?.filePath ?? context?.path
      const pathKind = openFilePathKind(rawPath)
      if (pathKind === 'missing') errors.push(`open_file action ${component.id} is missing context.filePath`)
      if (pathKind === 'invalid') errors.push(`open_file action ${component.id} has invalid context.filePath; use a string or one-level {path:"/data/path"} binding`)
      const relativePath = typeof rawPath === 'string' ? rawPath : undefined
      if (typeof relativePath === 'string' && !isSafeRelativePath(relativePath)) errors.push(`open_file action has unsafe path: ${relativePath}`)
      if (typeof relativePath === 'string') {
        const target = path.resolve(projectRoot, relativePath)
        if (!isInsideProject(projectRoot, target)) errors.push(`open_file path escapes project: ${relativePath}`)
      }
    }
  }

  if (!ids.has('root')) errors.push('components must include root')
  for (const component of components.filter(isRecord)) {
    validateReferences(component, ids, errors)
  }
  if (fileLikeTextCount > 0 && openFileActions === 0) warnings.push('file paths are shown but no open_file action was found')
  if (visualTextCount === 0 && !dataValues.some(hasTextBarVisualization)) {
    warnings.push('no text-bar visualization detected; add data visualization when repeated records exist')
  }
}

function hasTextBarVisualization(value) {
  if (typeof value === 'string') return /[█▇▆▅▄▃▂▁#=]{3,}/.test(value)
  if (Array.isArray(value)) return value.some(hasTextBarVisualization)
  if (isRecord(value)) return Object.values(value).some(hasTextBarVisualization)
  return false
}

function validateReferences(component, ids, errors) {
  const refs = []
  if (typeof component.child === 'string') refs.push(component.child)
  if (Array.isArray(component.children)) refs.push(...component.children.filter((item) => typeof item === 'string'))
  if (Array.isArray(component.tabs)) {
    for (const tab of component.tabs) {
      if (typeof tab?.child === 'string') refs.push(tab.child)
    }
  }
  for (const ref of refs) {
    if (!ids.has(ref)) errors.push(`component ${component.id} references missing child ${ref}`)
  }
}

function hasInlineChildren(component) {
  if (Array.isArray(component.children) && component.children.some(isRecord)) return true
  if (isRecord(component.child)) return true
  if (Array.isArray(component.tabs) && component.tabs.some((tab) => isRecord(tab?.child))) return true
  return false
}

function isOpenFileAction(action) {
  return isRecord(action) && isRecord(action.event) && action.event.name === 'open_file'
}

function openFilePathKind(value) {
  if (value === undefined || value === null || value === '') return 'missing'
  if (typeof value === 'string') return 'static'
  if (isRecord(value) && typeof value.path === 'string') return 'dynamic'
  return 'invalid'
}

function reportAndExit(errors, warnings) {
  for (const warning of warnings) console.warn(`WARN ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`)
    process.exit(1)
  }
  console.log('Home Plugin validation passed')
}

function normalizeDiagnostics(rawDiagnostics, extraDiagnostics) {
  const output = []
  if (Array.isArray(rawDiagnostics)) {
    for (const item of rawDiagnostics) {
      if (typeof item === 'string' && item.trim()) output.push(item.trim())
    }
  }
  output.push(...extraDiagnostics.filter((item) => typeof item === 'string' && item.trim()))
  return output.slice(0, 12)
}

function resolveInsideProject(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('path must be a non-empty string')
  const normalized = normalizeRelativePath(relativePath)
  if (!isSafeRelativePath(normalized)) throw new Error(`unsafe project path: ${relativePath}`)
  const resolved = path.resolve(projectRoot, normalized)
  if (!isInsideProject(projectRoot, resolved)) throw new Error(`path escapes project: ${relativePath}`)
  return resolved
}

function isInsideProject(projectRoot, targetPath) {
  return targetPath === projectRoot || targetPath.startsWith(`${projectRoot}${path.sep}`)
}

function isSafeRelativePath(value) {
  return typeof value === 'string' && value.trim() && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..')
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isReadOnlySql(sql) {
  if (typeof sql !== 'string') return false
  const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (!normalized) return false
  if (/[;]/.test(normalized.replace(/;\s*$/, ''))) return false
  if (/\b(attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze)\b/i.test(normalized)) return false
  return /^(select|with)\b/i.test(normalized) || /^pragma\s+(table_info|database_list|index_list|foreign_key_list|user_version|schema_version)\b/i.test(normalized)
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

await main()
