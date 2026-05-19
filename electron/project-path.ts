/**
 * 项目路径解析与磁盘可达性检查（主进程）。
 * Project path resolution and filesystem checks for the Electron main process.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 展开 `~`、相对路径并 `path.resolve`，得到规范项目目录 / Expand `~`, resolve relative paths to an absolute project directory */
export function resolveProjectPath(projectPath: string): string {
  const trimmedPath = projectPath.trim()
  if (!trimmedPath) return ''
  if (trimmedPath === '~') return os.homedir()
  if (trimmedPath.startsWith(`~${path.sep}`) || trimmedPath.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmedPath.slice(2))
  }
  return path.resolve(trimmedPath)
}

/** 文件或目录是否可读（`fs.access`）/ Whether the resolved path is reachable */
export async function pathExists(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return false
  try {
    await fs.access(resolveProjectPath(filePath))
    return true
  } catch {
    return false
  }
}

/** 路径存在且为目录 / Path exists and is a directory */
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

/** 批量校验多个路径对应目录是否存在 / Parallel directory checks for many raw path strings */
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

/** 将 Node 文件系统错误格式化为 UI 友好文案 / Map filesystem errors to localized user-facing messages */
export function formatProjectPathError(error: unknown, locale: 'zh' | 'en' = 'zh'): string {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return locale === 'zh' ? '项目文件夹不存在或已被删除' : 'Project folder does not exist or was removed'
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return locale === 'zh' ? '无法访问项目文件夹' : 'Unable to access project folder'
}

/** 窄化未知错误为带 `code` 的 Node 错误 / Narrow unknown values to NodeJS.ErrnoException */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
