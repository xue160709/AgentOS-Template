/**
 * 聊天工作区快照磁盘读写（项目、线程、侧栏偏好）。
 * Persist chat workspace snapshot (projects, threads, sidebar prefs) to disk.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeChatWorkspaceState } from '../src/chat-workspace-persistence'
import type { ChatWorkspaceState } from '../src/components/types'

const WORKSPACE_FILE_NAME = 'chat-workspace.json'

/** `chat-workspace.json` 读写封装 / Thin wrapper around `chat-workspace.json` IO */
export class ChatWorkspaceStore {
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, WORKSPACE_FILE_NAME)
  }

  read(): ChatWorkspaceState | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return normalizeChatWorkspaceState(raw)
    } catch {
      return null
    }
  }

  async save(state: unknown): Promise<ChatWorkspaceState> {
    const normalized = normalizeChatWorkspaceState(state)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }
}
