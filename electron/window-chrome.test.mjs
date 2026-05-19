import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function loadWindowChromeModule() {
  const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), 'window-chrome.ts')
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

test('Windows main window uses hidden titlebar overlay chrome', () => {
  const { getMainWindowChromeOptions } = loadWindowChromeModule()

  assert.deepEqual(getMainWindowChromeOptions('win32', false), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f9f9f9',
      symbolColor: '#1f1f1f',
      height: 40,
    },
    autoHideMenuBar: true,
  })
})

test('non-Windows platforms keep platform-specific chrome unchanged', () => {
  const { getMainWindowChromeOptions } = loadWindowChromeModule()

  assert.deepEqual(getMainWindowChromeOptions('darwin', false), {})
  assert.deepEqual(getMainWindowChromeOptions('linux', false), {})
})

test('workspace header is not a global drag region', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/AppShellWorkspace.tsx'), 'utf8')

  assert.doesNotMatch(source, /className="app-workspace-header draggable"/)
  assert.match(source, /className="app-workspace-drag-gap draggable"/)
})

test('Windows settings sidebar removes unnecessary top inset from shell platform class', () => {
  const appShellSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/AppShell.tsx'), 'utf8')
  const styleSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/style.css'), 'utf8')

  assert.match(appShellSource, /isWindows\s*\?\s*' is-platform-win32'/)
  assert.match(styleSource, /\.app-shell\.is-platform-win32\.is-shell-settings\s+\.app-sidebar-scroll\s*\{[^}]*padding-top:\s*calc\(var\(--spacing\) \* 3\)/s)
})
