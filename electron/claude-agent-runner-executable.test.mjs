import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadExecutableModule() {
  const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), 'claude-agent-runner/executable.ts')
  const source = readFileSync(modulePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: modulePath,
  })
  const module = { exports: {} }
  Function('exports', 'module', 'require', outputText)(module.exports, module, require)
  return module.exports
}

test('resolves packaged Claude binary from app.asar.unpacked', () => {
  const { resolveClaudeCodeExecutablePath } = loadExecutableModule()
  const resourcesPath = '/Applications/AgentOS.app/Contents/Resources'
  const expected = `${resourcesPath}/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
  const seen = []

  const resolved = resolveClaudeCodeExecutablePath({
    appRoot: `${resourcesPath}/app.asar`,
    resourcesPath,
    platform: 'darwin',
    arch: 'arm64',
    exists: (filePath) => {
      seen.push(filePath)
      return filePath === expected
    },
  })

  assert.equal(resolved, expected)
  assert.ok(!seen.some((filePath) => filePath.includes('/app.asar/node_modules/')))
})

test('resolves development Claude binary from app root node_modules', () => {
  const { resolveClaudeCodeExecutablePath } = loadExecutableModule()
  const appRoot = '/workspace/agentos'
  const expected = `${appRoot}/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`

  const resolved = resolveClaudeCodeExecutablePath({
    appRoot,
    resourcesPath: undefined,
    platform: 'win32',
    arch: 'x64',
    exists: (filePath) => filePath === expected,
  })

  assert.equal(resolved, expected)
})
