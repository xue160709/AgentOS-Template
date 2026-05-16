/**
 * 主进程启动时从 `.env` 合并环境变量（尊重已有进程环境）。
 * Merge `.env` files into `process.env` on startup without overriding existing keys.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ENV_FILES = ['.env', '.env.local']

/** 读取并注入 `.env` / `.env.local` / Load optional env files under app root */
export function loadMainProcessEnv(appRoot: string): void {
  const loadedKeys = new Set<string>()

  for (const fileName of ENV_FILES) {
    const filePath = path.join(appRoot, fileName)
    if (!existsSync(filePath)) continue

    const values = parseEnvFile(readFileSync(filePath, 'utf8'))
    for (const [key, value] of Object.entries(values)) {
      const wasLoadedFromFile = loadedKeys.has(key)
      if (process.env[key] !== undefined && !wasLoadedFromFile) continue

      process.env[key] = value
      loadedKeys.add(key)
    }
  }
}

function parseEnvFile(source: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue

    result[match[1]] = parseEnvValue(match[2])
  }

  return result
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim()
  if (!value) return ''

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const unquoted = value.slice(1, -1)
    return quote === '"' ? unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t') : unquoted
  }

  const hashIndex = value.indexOf(' #')
  return (hashIndex === -1 ? value : value.slice(0, hashIndex)).trim()
}
