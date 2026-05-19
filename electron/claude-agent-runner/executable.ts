/**
 * Resolve the Claude Code native binary outside app.asar for Electron builds.
 * The SDK can discover an asar virtual path by itself, but child_process.spawn
 * needs the real unpacked file on disk.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ANTHROPIC_SCOPE = '@anthropic-ai'
const PACKAGE_PREFIX = 'claude-agent-sdk'

type Platform = NodeJS.Platform
type Architecture = NodeJS.Architecture

type ResolveExecutableOptions = {
  appRoot?: string
  resourcesPath?: string
  platform?: Platform
  arch?: Architecture
  exists?: (filePath: string) => boolean
}

/** Find the real Claude Code binary path for the current packaged or dev runtime. */
export function resolveClaudeCodeExecutablePath(options: ResolveExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const exists = options.exists ?? existsSync
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'
  const packageNames = getClaudeBinaryPackageNames(platform, arch)
  if (packageNames.length === 0) return undefined

  for (const root of getCandidateNodeModuleRoots(options)) {
    for (const packageName of packageNames) {
      const candidate = join(root, ANTHROPIC_SCOPE, packageName, binaryName)
      if (isVirtualAsarPath(candidate)) continue
      if (exists(candidate)) return candidate
    }
  }

  return undefined
}

export function getClaudeBinaryPackageNames(platform: Platform, arch: Architecture): string[] {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return [`${PACKAGE_PREFIX}-darwin-${arch}`]
  }
  if (platform === 'win32' && (arch === 'arm64' || arch === 'x64')) {
    return [`${PACKAGE_PREFIX}-win32-${arch}`]
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return [`${PACKAGE_PREFIX}-linux-${arch}`, `${PACKAGE_PREFIX}-linux-${arch}-musl`]
  }
  return []
}

function getCandidateNodeModuleRoots(options: ResolveExecutableOptions): string[] {
  const roots: string[] = []
  const resourcesPath = options.resourcesPath ?? getElectronResourcesPath()
  const appRoot = options.appRoot ?? process.env.APP_ROOT

  if (resourcesPath) {
    roots.push(join(resourcesPath, 'app.asar.unpacked', 'node_modules'))
  }

  if (appRoot) {
    if (appRoot.endsWith(`${pathSeparator()}app.asar`) || appRoot.endsWith('/app.asar')) {
      roots.push(join(`${appRoot}.unpacked`, 'node_modules'))
    }
    if (!isVirtualAsarPath(appRoot)) {
      roots.push(join(appRoot, 'node_modules'))
    }
  }

  return dedupeStrings(roots)
}

function getElectronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
}

function isVirtualAsarPath(filePath: string): boolean {
  return /(^|[/\\])app\.asar([/\\]|$)/.test(filePath)
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}
