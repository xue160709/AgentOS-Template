/**
 * 聊天工作区快照磁盘读写（项目、线程、侧栏偏好）。
 * Persist chat workspace snapshot (projects, threads, sidebar prefs) to disk.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeChatWorkspaceState } from '../src/chat-workspace-persistence'
import type { ChatState, ChatWorkspaceState, TranscriptItem, WorkspaceProject, WorkspaceThread } from '../src/components/types'

const WORKSPACE_FILE_NAME = 'chat-workspace.json'
const WORKSPACE_DB_NAME = 'chat-workspace.sqlite'
const SESSIONS_DIR_NAME = 'chat-sessions'

type ProjectRow = {
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
  pinnedAt: number | null
}

type ThreadRow = {
  id: string
  projectId: string
  rolloutPath: string
  title: string
  purpose: string | null
  createdAt: number
  updatedAt: number
  pinnedAt: number | null
  archivedAt: number | null
  sessionId: string | null
  model: string | null
  cwd: string | null
}

type WorkspaceMetaRow = {
  activeProjectId: string
  activeThreadId: string
  sidebarPrefsJson: string
}

/**
 * Codex-like chat workspace persistence.
 *
 * The SQLite database is the compact index (projects + thread metadata), while
 * each thread owns a rollout JSONL file containing the transcript event stream.
 * `chat-workspace.json` remains as a compatibility snapshot and migration input.
 */
export class ChatWorkspaceStore {
  private readonly filePath: string
  private readonly dbPath: string
  private readonly sessionsDir: string
  private sqliteAvailable: boolean | null = null

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, WORKSPACE_FILE_NAME)
    this.dbPath = path.join(userDataPath, WORKSPACE_DB_NAME)
    this.sessionsDir = path.join(userDataPath, SESSIONS_DIR_NAME)
  }

  read(): ChatWorkspaceState | null {
    const fromDb = this.readFromDatabase()
    if (fromDb) return fromDb

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
    await mkdir(this.sessionsDir, { recursive: true })
    await this.saveRolloutFiles(normalized)
    this.saveDatabaseIndex(normalized)
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }

  private readFromDatabase(): ChatWorkspaceState | null {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return null

    try {
      this.ensureThreadPurposeColumn()
      const projects = this.selectJson<ProjectRow>(
        [
          'SELECT',
          'id, name, path,',
          'created_at AS createdAt, updated_at AS updatedAt, pinned_at AS pinnedAt',
          'FROM projects',
          'ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, created_at DESC',
        ].join(' '),
      )
      if (projects.length === 0) return null

      const threads = this.selectJson<ThreadRow>(
        [
          'SELECT',
          'id, project_id AS projectId, rollout_path AS rolloutPath, title, purpose,',
          'created_at AS createdAt, updated_at AS updatedAt,',
          'pinned_at AS pinnedAt, archived_at AS archivedAt,',
          'session_id AS sessionId, model, cwd',
          'FROM threads',
          'ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, created_at DESC',
        ].join(' '),
      )
      const meta = this.selectJson<WorkspaceMetaRow>(
        [
          'SELECT',
          'active_project_id AS activeProjectId,',
          'active_thread_id AS activeThreadId,',
          'sidebar_prefs_json AS sidebarPrefsJson',
          'FROM workspace_meta WHERE id = 1',
        ].join(' '),
      )[0]

      return normalizeChatWorkspaceState({
        activeProjectId: meta?.activeProjectId ?? projects[0]?.id ?? '',
        activeThreadId: meta?.activeThreadId ?? '',
        projects: projects.map((project): WorkspaceProject => ({
          id: project.id,
          name: project.name,
          path: project.path,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          pinnedAt: project.pinnedAt ?? undefined,
        })),
        threads: threads.map((thread): WorkspaceThread => ({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          purpose: normalizeThreadPurpose(thread.purpose),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? undefined,
          archivedAt: thread.archivedAt ?? undefined,
          chatState: this.readRolloutChatState(thread),
        })),
        sidebarPrefs: safeJsonParse(meta?.sidebarPrefsJson, undefined),
      })
    } catch {
      return null
    }
  }

  private saveDatabaseIndex(state: ChatWorkspaceState): void {
    if (!this.canUseSqlite()) return

    try {
      this.ensureThreadPurposeColumn()
      const existingRolloutPaths = this.readThreadRolloutPathMap()
      const statements: string[] = [
        'PRAGMA foreign_keys = ON;',
        `CREATE TABLE IF NOT EXISTS workspace_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_project_id TEXT NOT NULL,
          active_thread_id TEXT NOT NULL,
          sidebar_prefs_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );`,
        `CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          pinned_at INTEGER
        );`,
        `CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          title TEXT NOT NULL,
          purpose TEXT,
          pinned_at INTEGER,
          archived_at INTEGER,
          session_id TEXT,
          model TEXT NOT NULL DEFAULT 'Claude Agent',
          cwd TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          first_user_message TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          response_duration_ms INTEGER,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );`,
        'CREATE INDEX IF NOT EXISTS idx_threads_project_updated ON threads(project_id, archived_at, updated_at DESC);',
        'CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived_at);',
        'BEGIN;',
      ]

      if (state.projects.length > 0) {
        statements.push(`DELETE FROM projects WHERE id NOT IN (${state.projects.map((project) => sqlValue(project.id)).join(', ')});`)
      }
      if (state.threads.length > 0) {
        statements.push(`DELETE FROM threads WHERE id NOT IN (${state.threads.map((thread) => sqlValue(thread.id)).join(', ')});`)
      } else {
        statements.push('DELETE FROM threads;')
      }

      statements.push(
        `INSERT INTO workspace_meta (id, active_project_id, active_thread_id, sidebar_prefs_json, updated_at)
         VALUES (1, ${sqlValue(state.activeProjectId)}, ${sqlValue(state.activeThreadId)}, ${sqlValue(
           JSON.stringify(state.sidebarPrefs),
         )}, ${Date.now()})
         ON CONFLICT(id) DO UPDATE SET
           active_project_id = excluded.active_project_id,
           active_thread_id = excluded.active_thread_id,
           sidebar_prefs_json = excluded.sidebar_prefs_json,
           updated_at = excluded.updated_at;`,
      )

      for (const project of state.projects) {
        statements.push(
          `INSERT INTO projects (id, name, path, created_at, updated_at, pinned_at)
           VALUES (${sqlValue(project.id)}, ${sqlValue(project.name)}, ${sqlValue(project.path)}, ${sqlValue(project.createdAt)},
             ${sqlValue(project.updatedAt)}, ${sqlValue(project.pinnedAt)})
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             path = excluded.path,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             pinned_at = excluded.pinned_at;`,
        )
      }

      for (const thread of state.threads) {
        const rolloutPath = existingRolloutPaths.get(thread.id) ?? this.rolloutPathForThread(thread)
        const firstUser = firstUserMessageText(thread.chatState.items)
        const preview = transcriptPreview(thread.chatState.items)
        const responseDurationMs = lastAssistantDuration(thread.chatState.items)
        statements.push(
          `INSERT INTO threads (
             id, project_id, rollout_path, created_at, updated_at, title, pinned_at, archived_at,
             purpose, session_id, model, cwd, message_count, first_user_message, preview, response_duration_ms
           )
           VALUES (
             ${sqlValue(thread.id)}, ${sqlValue(thread.projectId)}, ${sqlValue(rolloutPath)}, ${sqlValue(thread.createdAt)},
             ${sqlValue(thread.updatedAt)}, ${sqlValue(thread.title)}, ${sqlValue(thread.pinnedAt)}, ${sqlValue(thread.archivedAt)},
             ${sqlValue(thread.purpose)}, ${sqlValue(thread.chatState.sessionId)}, ${sqlValue(thread.chatState.model)}, ${sqlValue(thread.chatState.cwd)},
             ${sqlValue(messageCount(thread.chatState.items))}, ${sqlValue(firstUser)}, ${sqlValue(preview)},
             ${sqlValue(responseDurationMs)}
           )
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             rollout_path = excluded.rollout_path,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             title = excluded.title,
             purpose = excluded.purpose,
             pinned_at = excluded.pinned_at,
             archived_at = excluded.archived_at,
             session_id = excluded.session_id,
             model = excluded.model,
             cwd = excluded.cwd,
             message_count = excluded.message_count,
             first_user_message = excluded.first_user_message,
             preview = excluded.preview,
             response_duration_ms = excluded.response_duration_ms;`,
        )
      }

      statements.push('COMMIT;')
      this.runSql(statements.join('\n'))
    } catch {
      /* Keep the compatibility JSON snapshot as the durable fallback. */
    }
  }

  private async saveRolloutFiles(state: ChatWorkspaceState): Promise<void> {
    const existingRolloutPaths = this.readThreadRolloutPathMap()
    await Promise.all(
      state.threads.map(async (thread) => {
        const rolloutPath = existingRolloutPaths.get(thread.id) ?? this.rolloutPathForThread(thread)
        await mkdir(path.dirname(rolloutPath), { recursive: true })
        const tmpPath = `${rolloutPath}.tmp`
        await writeFile(tmpPath, serializeRollout(thread), 'utf8')
        await rename(tmpPath, rolloutPath)
      }),
    )
  }

  private readRolloutChatState(thread: ThreadRow): ChatState {
    const state: ChatState = {
      sessionId: thread.sessionId ?? undefined,
      model: thread.model || 'Claude Agent',
      cwd: thread.cwd ?? undefined,
      items: [],
    }
    if (!thread.rolloutPath || !existsSync(thread.rolloutPath)) return state

    try {
      const lines = readFileSync(thread.rolloutPath, 'utf8').split(/\n/).filter(Boolean)
      for (const line of lines) {
        const event = JSON.parse(line) as unknown
        if (!isRecord(event)) continue
        const payload = event.payload
        if (!isRecord(payload)) continue

        if (event.type === 'session_meta' || event.type === 'thread_state') {
          state.sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.sessionId
          state.model = typeof payload.model === 'string' ? payload.model : state.model
          state.cwd = typeof payload.cwd === 'string' ? payload.cwd : state.cwd
          continue
        }

        if (event.type === 'response_item') {
          state.items.push(payload as TranscriptItem)
        }
      }
    } catch {
      return state
    }

    return state
  }

  private rolloutPathForThread(thread: WorkspaceThread): string {
    const date = new Date(thread.createdAt || Date.now())
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const stamp = date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')
    return path.join(this.sessionsDir, year, month, day, `rollout-${stamp}-${safeFilename(thread.id)}.jsonl`)
  }

  private readThreadRolloutPathMap(): Map<string, string> {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return new Map()
    try {
      return new Map(this.selectJson<{ id: string; rolloutPath: string }>('SELECT id, rollout_path AS rolloutPath FROM threads').map((row) => [row.id, row.rolloutPath]))
    } catch {
      return new Map()
    }
  }

  private ensureThreadPurposeColumn(): void {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return
    try {
      const columns = this.selectJson<{ name: string }>('PRAGMA table_info(threads)')
      if (columns.length > 0 && !columns.some((column) => column.name === 'purpose')) {
        this.runSql('ALTER TABLE threads ADD COLUMN purpose TEXT;')
      }
    } catch {
      /* Fresh databases create the column through CREATE TABLE. */
    }
  }

  private canUseSqlite(): boolean {
    if (this.sqliteAvailable != null) return this.sqliteAvailable
    try {
      execFileSync('sqlite3', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      this.sqliteAvailable = true
    } catch {
      this.sqliteAvailable = false
    }
    return this.sqliteAvailable
  }

  private runSql(sql: string): void {
    execFileSync('sqlite3', [this.dbPath], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  }

  private selectJson<T>(sql: string): T[] {
    const output = execFileSync('sqlite3', ['-json', this.dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!output) return []
    return JSON.parse(output) as T[]
  }
}

function serializeRollout(thread: WorkspaceThread): string {
  const timestamp = new Date(thread.updatedAt || Date.now()).toISOString()
  const lines = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        purpose: thread.purpose,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
        model: thread.chatState.model,
        cwd: thread.chatState.cwd,
        sessionId: thread.chatState.sessionId,
        source: 'agentos',
      },
    },
    {
      timestamp,
      type: 'thread_state',
      payload: {
        sessionId: thread.chatState.sessionId,
        model: thread.chatState.model,
        cwd: thread.chatState.cwd,
      },
    },
    ...thread.chatState.items.map((item) => ({
      timestamp: new Date(itemTimestamp(item, thread.updatedAt)).toISOString(),
      type: 'response_item',
      payload: item,
    })),
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

function sqlValue(value: unknown): string {
  if (value == null) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

function safeJsonParse(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    return fallback
  }
}

function itemTimestamp(item: TranscriptItem, fallback: number): number {
  if (item.type === 'message') return item.completedAt ?? item.createdAt ?? fallback
  return fallback
}

function messageCount(items: TranscriptItem[]): number {
  return items.filter((item) => item.type === 'message').length
}

function firstUserMessageText(items: TranscriptItem[]): string {
  const item = items.find((candidate) => candidate.type === 'message' && candidate.role === 'user')
  return item?.type === 'message' ? item.content : ''
}

function transcriptPreview(items: TranscriptItem[]): string {
  const message = [...items].reverse().find((candidate) => candidate.type === 'message' && candidate.content.trim())
  return message?.type === 'message' ? message.content.trim().slice(0, 240) : ''
}

function lastAssistantDuration(items: TranscriptItem[]): number | undefined {
  const message = [...items].reverse().find(
    (candidate) => candidate.type === 'message' && candidate.role === 'assistant' && typeof candidate.durationMs === 'number',
  )
  return message?.type === 'message' ? message.durationMs : undefined
}

function normalizeThreadPurpose(value: string | null): WorkspaceThread['purpose'] {
  return value === 'home-plugin-customization' ? value : undefined
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
