import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('Skipping Apple Speech helper build: current platform is not macOS.')
  process.exit(0)
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, 'native', 'speech-cli', 'SpeechCLI.swift')
const plist = path.join(root, 'native', 'speech-cli', 'Info.plist')
const entitlements = path.join(root, 'native', 'speech-cli', 'SpeechCLI.entitlements')
const outDir = path.join(root, 'native', 'speech-cli', 'build')
const appBundle = path.join(outDir, 'AgentOS Speech Helper.app')
const appContents = path.join(appBundle, 'Contents')
const appMacOS = path.join(appContents, 'MacOS')
const appPlist = path.join(appContents, 'Info.plist')
const out = path.join(appMacOS, 'speech_cli')
const moduleCache = path.join(outDir, 'module-cache')

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(appMacOS, { recursive: true })
fs.mkdirSync(moduleCache, { recursive: true })

const inputs = [source, plist, entitlements]
const outputIsFresh =
  fs.existsSync(out) &&
  fs.existsSync(appPlist) &&
  inputs.every((input) => fs.statSync(out).mtimeMs >= fs.statSync(input).mtimeMs)

if (outputIsFresh) {
  console.log(`Apple Speech helper is up to date: ${path.relative(root, appBundle)}`)
  process.exit(0)
}

const swiftcArgs = [
  'swiftc',
  source,
  '-o',
  out,
  '-framework',
  'Speech',
  '-framework',
  'AVFoundation',
  '-module-cache-path',
  moduleCache,
]

const swiftc = spawnSync('xcrun', swiftcArgs, { stdio: 'inherit' })
if (swiftc.status !== 0) {
  process.exit(swiftc.status ?? 1)
}

fs.chmodSync(out, 0o755)
fs.copyFileSync(plist, appPlist)

const codesign = spawnSync(
  'codesign',
  ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appBundle],
  { stdio: 'inherit' },
)
if (codesign.status !== 0) {
  process.exit(codesign.status ?? 1)
}

console.log(`Built Apple Speech helper: ${path.relative(root, appBundle)}`)
