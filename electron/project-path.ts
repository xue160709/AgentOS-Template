/**
 * 项目路径解析与磁盘可达性检查（主进程）。
 * Project path resolution and filesystem checks for the Electron main process.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function resolveProjectPath(projectPath: string): string {
  const trimmedPath = projectPath.trim()
  if (!trimmedPath) return ''
  if (trimmedPath === '~') return os.homedir()
  if (trimmedPath.startsWith(`~${path.sep}`) || trimmedPath.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmedPath.slice(2))
  }
  return path.resolve(trimmedPath)
}

export async function pathExists(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return false
  try {
    await fs.access(resolveProjectPath(filePath))
    return true
  } catch {
    return false
  }
}

export async function isProjectDirectory(projectPath: string): Promise<boolean> {
  const resolved = resolveProjectPath(projectPath)
  if (!resolved) return false
  try {
    const stat = await fs.stat(resolved)
    return stat.isDirectory()
  } catch {
    return false
  }
}

export async function validateProjectPaths(projectPaths: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  await Promise.all(
    projectPaths.map(async (projectPath) => {
      if (typeof projectPath !== 'string' || !projectPath.trim()) {
        result[projectPath] = false
        return
      }
      result[projectPath] = await isProjectDirectory(projectPath)
    }),
  )
  return result
}

export function formatProjectPathError(error: unknown, locale: 'zh' | 'en' = 'zh'): string {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return locale === 'zh' ? '项目文件夹不存在或已被删除' : 'Project folder does not exist or was removed'
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return locale === 'zh' ? '无法访问项目文件夹' : 'Unable to access project folder'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
