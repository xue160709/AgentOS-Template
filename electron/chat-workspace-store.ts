/**
 * 聊天工作区快照磁盘读写（项目、线程、侧栏偏好）。
 * Persist chat workspace snapshot (projects, threads, sidebar prefs) to disk.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeChatWorkspaceState } from '../src/chat-workspace-persistence'
import { migrateLegacySeedProjects } from '../src/project-path'
import type {
  ChatHistorySearchDocumentKind,
  ChatHistorySearchItem,
  ChatHistorySearchOptions,
  ChatHistorySearchResult,
} from '../src/claude-chat-types'
import type { ChatState, ChatWorkspaceState, TranscriptItem, WorkspaceProject, WorkspaceThread } from '../src/components/types'

const WORKSPACE_FILE_NAME = 'chat-workspace.json'
const WORKSPACE_DB_NAME = 'chat-workspace.sqlite'
const SESSIONS_DIR_NAME = 'chat-sessions'
const DEFAULT_HISTORY_SEARCH_LIMIT = 16
const MAX_HISTORY_SEARCH_LIMIT = 64
const SEARCH_DOCUMENT_BODY_LIMIT = 12_000
const SEARCH_DOCUMENT_TOOL_LIMIT = 2_400
const SEARCH_SNIPPET_LENGTH = 180

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
  homePluginSlug: string | null
  skillPath: string | null
  skillCommand: string | null
  skillTitle: string | null
  createdAt: number
  updatedAt: number
  pinnedAt: number | null
  archivedAt: number | null
  sessionId: string | null
  model: string | null
  modelPickJson: string | null
  cwd: string | null
}

type WorkspaceMetaRow = {
  activeProjectId: string
  activeThreadId: string
  sidebarPrefsJson: string
}

type SearchDocument = {
  id: string
  kind: ChatHistorySearchDocumentKind
  projectId: string
  threadId: string
  path: string
  title: string
  subtitle: string
  body: string
  metadataJson: string
  updatedAt: number
  rank?: number
}

type SearchDocumentRow = {
  id: string
  kind: ChatHistorySearchDocumentKind
  projectId: string
  threadId: string
  path: string
  title: string
  subtitle: string
  body: string
  metadataJson: string
  updatedAt: number
  rank?: number
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
    if (fromDb) return migrateLegacySeedProjects(fromDb)

    if (!existsSync(this.filePath)) return null
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return migrateLegacySeedProjects(normalizeChatWorkspaceState(raw))
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

  searchChatHistory(projectId: string, query: string, options: ChatHistorySearchOptions = {}): ChatHistorySearchResult {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : ''
    const normalizedQuery = typeof query === 'string' ? query.trim() : ''
    if (!normalizedQuery) {
      return { ok: true, projectId: normalizedProjectId, items: [] }
    }

    const limit = normalizeHistorySearchLimit(options.limit)
    const includeArchived = options.includeArchived === true

    if (this.canUseSqlite() && existsSync(this.dbPath)) {
      let sqliteItems: ChatHistorySearchItem[] = []
      try {
        this.rebuildSearchIndexIfMissing()
        sqliteItems = this.searchChatHistoryWithSqlite(normalizedProjectId, normalizedQuery, includeArchived, limit)
      } catch {
        /* FTS can be unavailable even when sqlite3 exists. */
      }
      try {
        sqliteItems = mergeHistorySearchItems([
          ...sqliteItems,
          ...this.searchChatHistoryWithSqliteLike(normalizedProjectId, normalizedQuery, includeArchived, limit),
        ]).slice(0, limit)
      } catch {
        /* Fall through to JSON/rollout scan. */
      }
      if (sqliteItems.length > 0) return { ok: true, projectId: normalizedProjectId, items: sqliteItems }
    }

    try {
      const state = this.read()
      if (!state) return { ok: true, projectId: normalizedProjectId, items: [] }
      const documents = buildSearchDocuments(state).filter((document) => !normalizedProjectId || document.projectId === normalizedProjectId)
      return {
        ok: true,
        projectId: normalizedProjectId,
        items: searchDocumentsToItems(documents, normalizedQuery, includeArchived, limit),
      }
    } catch (error) {
      return {
        ok: false,
        projectId: normalizedProjectId,
        message: error instanceof Error ? error.message : 'Chat history search failed.',
      }
    }
  }

  private readFromDatabase(): ChatWorkspaceState | null {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return null

    try {
      this.ensureThreadMetadataColumns()
      const projects = this.selectJson<ProjectRow>(
        [
          'SELECT',
          'id, name, path,',
          'created_at AS createdAt, updated_at AS updatedAt, pinned_at AS pinnedAt',
          'FROM projects',
          'ORDER BY pinned_at DESC NULLS LAST, created_at DESC',
        ].join(' '),
      )
      if (projects.length === 0) return null

      const threads = this.selectJson<ThreadRow>(
        [
          'SELECT',
          'id, project_id AS projectId, rollout_path AS rolloutPath, title, purpose, home_plugin_slug AS homePluginSlug,',
          'skill_path AS skillPath, skill_command AS skillCommand, skill_title AS skillTitle,',
          'created_at AS createdAt, updated_at AS updatedAt,',
          'pinned_at AS pinnedAt, archived_at AS archivedAt,',
          'session_id AS sessionId, model, model_pick_json AS modelPickJson, cwd',
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
          homePluginSlug: thread.homePluginSlug?.trim() || undefined,
          skillPath: thread.skillPath?.trim() || undefined,
          skillCommand: thread.skillCommand?.trim() || undefined,
          skillTitle: thread.skillTitle?.trim() || undefined,
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
      this.ensureThreadMetadataColumns()
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
          home_plugin_slug TEXT,
          skill_path TEXT,
          skill_command TEXT,
          skill_title TEXT,
          pinned_at INTEGER,
          archived_at INTEGER,
          session_id TEXT,
          model TEXT NOT NULL DEFAULT 'Claude Agent',
          model_pick_json TEXT,
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
             purpose, home_plugin_slug, skill_path, skill_command, skill_title, session_id, model, model_pick_json, cwd, message_count, first_user_message, preview, response_duration_ms
           )
           VALUES (
             ${sqlValue(thread.id)}, ${sqlValue(thread.projectId)}, ${sqlValue(rolloutPath)}, ${sqlValue(thread.createdAt)},
             ${sqlValue(thread.updatedAt)}, ${sqlValue(thread.title)}, ${sqlValue(thread.pinnedAt)}, ${sqlValue(thread.archivedAt)},
             ${sqlValue(thread.purpose)}, ${sqlValue(thread.homePluginSlug)}, ${sqlValue(thread.skillPath)}, ${sqlValue(thread.skillCommand)}, ${sqlValue(thread.skillTitle)},
             ${sqlValue(thread.chatState.sessionId)}, ${sqlValue(thread.chatState.model)}, ${sqlValue(thread.chatState.modelPick ? JSON.stringify(thread.chatState.modelPick) : undefined)}, ${sqlValue(thread.chatState.cwd)},
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
             home_plugin_slug = excluded.home_plugin_slug,
             skill_path = excluded.skill_path,
             skill_command = excluded.skill_command,
             skill_title = excluded.skill_title,
             pinned_at = excluded.pinned_at,
             archived_at = excluded.archived_at,
             session_id = excluded.session_id,
             model = excluded.model,
             model_pick_json = excluded.model_pick_json,
             cwd = excluded.cwd,
             message_count = excluded.message_count,
             first_user_message = excluded.first_user_message,
             preview = excluded.preview,
             response_duration_ms = excluded.response_duration_ms;`,
        )
      }

      statements.push('COMMIT;')
      this.runSql(statements.join('\n'))
      this.saveSearchIndex(state)
    } catch {
      /* Keep the compatibility JSON snapshot as the durable fallback. */
    }
  }

  private saveSearchIndex(state: ChatWorkspaceState): void {
    if (!this.canUseSqlite()) return

    const documents = buildSearchDocuments(state)
    const tableStatements = [
      `CREATE TABLE IF NOT EXISTS search_documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
      'CREATE INDEX IF NOT EXISTS idx_search_documents_project_updated ON search_documents(project_id, updated_at DESC);',
      'CREATE INDEX IF NOT EXISTS idx_search_documents_thread ON search_documents(thread_id, kind);',
      'BEGIN;',
      'DELETE FROM search_documents;',
      ...documents.map((document) => insertSearchDocumentSql('search_documents', document)),
      'COMMIT;',
    ]
    this.runSql(tableStatements.join('\n'))

    try {
      const ftsStatements = [
        `CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
          id UNINDEXED,
          kind UNINDEXED,
          project_id UNINDEXED,
          thread_id UNINDEXED,
          path UNINDEXED,
          title,
          subtitle,
          body,
          metadata_json UNINDEXED,
          updated_at UNINDEXED,
          tokenize = 'unicode61'
        );`,
        'BEGIN;',
        'DELETE FROM search_documents_fts;',
        ...documents.map((document) => insertSearchDocumentSql('search_documents_fts', document)),
        'COMMIT;',
      ]
      this.runSql(ftsStatements.join('\n'))
    } catch {
      /* FTS5 is optional; JSON/rollout search remains available. */
    }
  }

  private rebuildSearchIndexIfMissing(): void {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return
    try {
      const documentCount = Number(this.selectJson<{ count: number }>('SELECT COUNT(*) AS count FROM search_documents')[0]?.count ?? 0)
      const threadCount = Number(this.selectJson<{ count: number }>('SELECT COUNT(*) AS count FROM threads')[0]?.count ?? 0)
      if (documentCount > 0 || threadCount === 0) return
    } catch {
      /* Missing table or old schema: rebuild below. */
    }

    const state = this.read()
    if (state) this.saveSearchIndex(state)
  }

  private searchChatHistoryWithSqlite(projectId: string, query: string, includeArchived: boolean, limit: number): ChatHistorySearchItem[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return []
    const rowLimit = Math.min(MAX_HISTORY_SEARCH_LIMIT * 6, Math.max(limit * 6, limit))
    const rows = this.selectJson<SearchDocumentRow>(
      [
        'SELECT',
        'id, kind, project_id AS projectId, thread_id AS threadId, path, title, subtitle, body,',
        'metadata_json AS metadataJson, updated_at AS updatedAt, bm25(search_documents_fts) AS rank',
        'FROM search_documents_fts',
        `WHERE search_documents_fts MATCH ${sqlValue(ftsQuery)}${projectId ? ` AND project_id = ${sqlValue(projectId)}` : ''}`,
        'ORDER BY rank ASC, updated_at DESC',
        `LIMIT ${rowLimit}`,
      ].join(' '),
    )
    return searchDocumentsToItems(rows.map(rowToSearchDocument), query, includeArchived, limit)
  }

  private searchChatHistoryWithSqliteLike(projectId: string, query: string, includeArchived: boolean, limit: number): ChatHistorySearchItem[] {
    const rowLimit = Math.min(MAX_HISTORY_SEARCH_LIMIT * 6, Math.max(limit * 6, limit))
    const pattern = sqlLikePattern(query)
    const rows = this.selectJson<SearchDocumentRow>(
      [
        'SELECT',
        'id, kind, project_id AS projectId, thread_id AS threadId, path, title, subtitle, body,',
        'metadata_json AS metadataJson, updated_at AS updatedAt',
        'FROM search_documents',
        `WHERE ${projectId ? `project_id = ${sqlValue(projectId)} AND ` : ''}(`,
        `title LIKE ${sqlValue(pattern)} ESCAPE '\\' OR`,
        `subtitle LIKE ${sqlValue(pattern)} ESCAPE '\\' OR`,
        `body LIKE ${sqlValue(pattern)} ESCAPE '\\'`,
        ')',
        'ORDER BY updated_at DESC',
        `LIMIT ${rowLimit}`,
      ].join(' '),
    )
    return searchDocumentsToItems(rows.map(rowToSearchDocument), query, includeArchived, limit)
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
      modelPick: safeModelPick(safeJsonParse(thread.modelPickJson ?? undefined, undefined)),
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
          state.modelPick = safeModelPick(payload.modelPick) ?? state.modelPick
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

  private ensureThreadMetadataColumns(): void {
    if (!existsSync(this.dbPath) || !this.canUseSqlite()) return
    try {
      const columns = this.selectJson<{ name: string }>('PRAGMA table_info(threads)')
      if (columns.length > 0 && !columns.some((column) => column.name === 'purpose')) {
        this.runSql('ALTER TABLE threads ADD COLUMN purpose TEXT;')
      }
      if (columns.length > 0 && !columns.some((column) => column.name === 'home_plugin_slug')) {
        this.runSql('ALTER TABLE threads ADD COLUMN home_plugin_slug TEXT;')
      }
      if (columns.length > 0 && !columns.some((column) => column.name === 'skill_path')) {
        this.runSql('ALTER TABLE threads ADD COLUMN skill_path TEXT;')
      }
      if (columns.length > 0 && !columns.some((column) => column.name === 'skill_command')) {
        this.runSql('ALTER TABLE threads ADD COLUMN skill_command TEXT;')
      }
      if (columns.length > 0 && !columns.some((column) => column.name === 'skill_title')) {
        this.runSql('ALTER TABLE threads ADD COLUMN skill_title TEXT;')
      }
      if (columns.length > 0 && !columns.some((column) => column.name === 'model_pick_json')) {
        this.runSql('ALTER TABLE threads ADD COLUMN model_pick_json TEXT;')
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

function buildSearchDocuments(state: ChatWorkspaceState): SearchDocument[] {
  const projectsById = new Map(state.projects.map((project) => [project.id, project]))
  const documents: SearchDocument[] = []

  for (const thread of state.threads) {
    const project = projectsById.get(thread.projectId)
    const firstUser = firstUserMessageItem(thread.chatState.items)
    documents.push(buildThreadSearchDocument(thread, project, firstUser))

    for (const item of thread.chatState.items) {
      if (item.type === 'message') {
        documents.push(buildMessageSearchDocument(thread, project, item))
        continue
      }
      if (item.type === 'tool' && isImportantToolSearchItem(item)) {
        documents.push(buildToolSearchDocument(thread, project, item))
        continue
      }
      if (item.type === 'activity' && isImportantActivitySearchItem(item)) {
        documents.push(buildActivitySearchDocument(thread, project, item))
      }
    }
  }

  return documents
}

function buildThreadSearchDocument(
  thread: WorkspaceThread,
  project: WorkspaceProject | undefined,
  firstUser: Extract<TranscriptItem, { type: 'message' }> | undefined,
): SearchDocument {
  const metadata = baseSearchMetadata(thread, project, {
    documentKind: 'thread',
    itemId: firstUser?.id,
  })
  return {
    id: `thread:${thread.id}`,
    kind: 'thread',
    projectId: thread.projectId,
    threadId: thread.id,
    path: `thread:${thread.id}`,
    title: thread.title || 'Untitled thread',
    subtitle: buildThreadDocumentSubtitle(thread, project),
    body: compactSearchText(
      [
        thread.title,
        thread.purpose,
        thread.skillTitle,
        thread.skillCommand,
        project?.name,
        project?.path,
        firstUser?.content,
      ]
        .filter(Boolean)
        .join('\n'),
      SEARCH_DOCUMENT_BODY_LIMIT,
    ),
    metadataJson: JSON.stringify(metadata),
    updatedAt: thread.updatedAt,
  }
}

function buildMessageSearchDocument(
  thread: WorkspaceThread,
  project: WorkspaceProject | undefined,
  item: Extract<TranscriptItem, { type: 'message' }>,
): SearchDocument {
  const attachmentText = messageAttachmentSearchText(item.attachments)
  const metadata = baseSearchMetadata(thread, project, {
    documentKind: 'message',
    itemId: item.id,
    role: item.role,
    status: item.status,
  })
  return {
    id: `message:${thread.id}:${item.id}`,
    kind: 'message',
    projectId: thread.projectId,
    threadId: thread.id,
    path: `thread:${thread.id}#${item.id}`,
    title: thread.title || 'Untitled thread',
    subtitle: item.role,
    body: compactSearchText([item.content, attachmentText].filter(Boolean).join('\n'), SEARCH_DOCUMENT_BODY_LIMIT),
    metadataJson: JSON.stringify(metadata),
    updatedAt: itemTimestamp(item, thread.updatedAt),
  }
}

function buildToolSearchDocument(
  thread: WorkspaceThread,
  project: WorkspaceProject | undefined,
  item: Extract<TranscriptItem, { type: 'tool' }>,
): SearchDocument {
  const metadata = baseSearchMetadata(thread, project, {
    documentKind: 'tool',
    itemId: item.id,
    toolName: item.name,
    status: item.status,
  })
  return {
    id: `tool:${thread.id}:${item.id}`,
    kind: 'tool',
    projectId: thread.projectId,
    threadId: thread.id,
    path: `thread:${thread.id}#${item.id}`,
    title: thread.title || 'Untitled thread',
    subtitle: `${item.name} · ${item.status}`,
    body: compactSearchText([item.name, item.inputPreview, item.detail].filter(Boolean).join('\n'), SEARCH_DOCUMENT_TOOL_LIMIT),
    metadataJson: JSON.stringify(metadata),
    updatedAt: thread.updatedAt,
  }
}

function buildActivitySearchDocument(
  thread: WorkspaceThread,
  project: WorkspaceProject | undefined,
  item: Extract<TranscriptItem, { type: 'activity' }>,
): SearchDocument {
  const metadata = baseSearchMetadata(thread, project, {
    documentKind: 'activity',
    itemId: item.id,
    status: item.status,
  })
  return {
    id: `activity:${thread.id}:${item.id}`,
    kind: 'activity',
    projectId: thread.projectId,
    threadId: thread.id,
    path: `thread:${thread.id}#${item.id}`,
    title: thread.title || 'Untitled thread',
    subtitle: `${item.title} · ${item.status}`,
    body: compactSearchText([item.title, item.preview, item.detail].filter(Boolean).join('\n'), SEARCH_DOCUMENT_TOOL_LIMIT),
    metadataJson: JSON.stringify(metadata),
    updatedAt: thread.updatedAt,
  }
}

function baseSearchMetadata(
  thread: WorkspaceThread,
  project: WorkspaceProject | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    projectId: thread.projectId,
    projectName: project?.name,
    threadId: thread.id,
    threadTitle: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    purpose: thread.purpose,
    skillPath: thread.skillPath,
    skillCommand: thread.skillCommand,
    skillTitle: thread.skillTitle,
    ...extra,
  }
}

function buildThreadDocumentSubtitle(thread: WorkspaceThread, project: WorkspaceProject | undefined): string {
  return [thread.skillTitle, thread.skillCommand, project?.name].filter(Boolean).join(' · ')
}

function firstUserMessageItem(items: TranscriptItem[]): Extract<TranscriptItem, { type: 'message' }> | undefined {
  return items.find((item): item is Extract<TranscriptItem, { type: 'message' }> => item.type === 'message' && item.role === 'user')
}

function messageAttachmentSearchText(attachments: Extract<TranscriptItem, { type: 'message' }>['attachments']): string {
  if (!attachments?.length) return ''
  return attachments.map((attachment) => [attachment.name, attachment.path, attachment.preview].filter(Boolean).join(' ')).join('\n')
}

function isImportantToolSearchItem(item: Extract<TranscriptItem, { type: 'tool' }>): boolean {
  if (item.status === 'error' || item.status === 'denied') return true
  return Boolean(item.detail?.trim())
}

function isImportantActivitySearchItem(item: Extract<TranscriptItem, { type: 'activity' }>): boolean {
  if (item.status === 'error') return true
  return Boolean(item.detail?.trim() || item.preview?.trim())
}

function insertSearchDocumentSql(tableName: 'search_documents' | 'search_documents_fts', document: SearchDocument): string {
  return `INSERT INTO ${tableName} (id, kind, project_id, thread_id, path, title, subtitle, body, metadata_json, updated_at)
    VALUES (${sqlValue(document.id)}, ${sqlValue(document.kind)}, ${sqlValue(document.projectId)}, ${sqlValue(document.threadId)},
      ${sqlValue(document.path)}, ${sqlValue(document.title)}, ${sqlValue(document.subtitle)}, ${sqlValue(document.body)},
      ${sqlValue(document.metadataJson)}, ${sqlValue(document.updatedAt)});`
}

function rowToSearchDocument(row: SearchDocumentRow): SearchDocument {
  return {
    id: String(row.id),
    kind: isSearchDocumentKind(row.kind) ? row.kind : 'message',
    projectId: String(row.projectId),
    threadId: String(row.threadId),
    path: String(row.path),
    title: String(row.title ?? ''),
    subtitle: String(row.subtitle ?? ''),
    body: String(row.body ?? ''),
    metadataJson: String(row.metadataJson ?? '{}'),
    updatedAt: Number(row.updatedAt) || 0,
    rank: typeof row.rank === 'number' ? row.rank : Number(row.rank),
  }
}

function searchDocumentsToItems(
  documents: SearchDocument[],
  query: string,
  includeArchived: boolean,
  limit: number,
): ChatHistorySearchItem[] {
  return mergeHistorySearchItems(
    documents
      .map((document) => searchDocumentToItem(document, query, includeArchived))
      .filter((item): item is ChatHistorySearchItem => Boolean(item)),
  ).slice(0, limit)
}

function mergeHistorySearchItems(items: ChatHistorySearchItem[]): ChatHistorySearchItem[] {
  const byId = new Map<string, ChatHistorySearchItem>()
  for (const item of items) {
    const existing = byId.get(item.id)
    if (!existing || item.score > existing.score) byId.set(item.id, item)
  }
  return [...byId.values()].sort(compareHistorySearchItems)
}

function searchDocumentToItem(
  document: SearchDocument,
  query: string,
  includeArchived: boolean,
): ChatHistorySearchItem | null {
  const metadata = safeRecord(safeJsonParse(document.metadataJson, {}))
  const archivedAt = numberMetadata(metadata.archivedAt)
  if (archivedAt && !includeArchived) return null

  const baseScore = scoreSearchDocument(document, query)
  if (baseScore <= 0) return null

  const role = metadata.role === 'assistant' || metadata.role === 'user' ? metadata.role : undefined
  const itemId = typeof metadata.itemId === 'string' ? metadata.itemId : undefined
  const threadTitle = typeof metadata.threadTitle === 'string' && metadata.threadTitle.trim() ? metadata.threadTitle : document.title
  const ftsBoost = typeof document.rank === 'number' && Number.isFinite(document.rank) ? Math.max(0, 20 - Math.min(20, Math.abs(document.rank))) : 0
  const score = baseScore + ftsBoost + historyRecencyScore(document.updatedAt) - (archivedAt ? 80 : 0)

  return {
    id: `history:${document.id}`,
    documentKind: document.kind,
    projectId: document.projectId,
    threadId: document.threadId,
    itemId,
    role,
    threadTitle,
    title: threadTitle,
    subtitle: document.subtitle,
    snippet: makeSearchSnippet(document, query),
    body: document.body,
    updatedAt: document.updatedAt,
    archivedAt,
    score,
    metadata,
  }
}

function compareHistorySearchItems(a: ChatHistorySearchItem, b: ChatHistorySearchItem): number {
  return b.score - a.score || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
}

function scoreSearchDocument(document: SearchDocument, query: string): number {
  const tokens = tokenizeSearchQuery(query)
  if (tokens.length === 0) return 0
  const title = normalizeSearchText(document.title)
  const subtitle = normalizeSearchText(document.subtitle)
  const body = normalizeSearchText(document.body)
  let score = 0
  for (const token of tokens) {
    const best = Math.max(scoreSearchField(title, token, 3), scoreSearchField(subtitle, token, 1.5), scoreSearchField(body, token, 1))
    if (best <= 0) return 0
    score += best
  }
  return score
}

function scoreSearchField(value: string, token: string, weight: number): number {
  if (!value || !token) return 0
  if (value === token) return 120 * weight
  if (value.startsWith(token)) return 90 * weight
  const index = value.indexOf(token)
  if (index < 0) return 0
  return Math.max(12, 64 - Math.min(index, 160) / 4) * weight
}

function makeSearchSnippet(document: SearchDocument, query: string): string {
  const tokens = tokenizeSearchQuery(query)
  const source = compactSearchText(document.body || document.subtitle || document.title, SEARCH_DOCUMENT_BODY_LIMIT)
  if (!source) return document.subtitle || document.title
  const normalizedSource = normalizeSearchText(source)
  const matchIndex = tokens.reduce((best, token) => {
    const index = normalizedSource.indexOf(token)
    if (index < 0) return best
    return best < 0 ? index : Math.min(best, index)
  }, -1)
  if (matchIndex < 0) return compactSearchText(source, SEARCH_SNIPPET_LENGTH)
  const start = Math.max(0, matchIndex - Math.floor(SEARCH_SNIPPET_LENGTH / 3))
  const end = Math.min(source.length, start + SEARCH_SNIPPET_LENGTH)
  const prefix = start > 0 ? '... ' : ''
  const suffix = end < source.length ? ' ...' : ''
  return `${prefix}${source.slice(start, end).trim()}${suffix}`
}

function buildFtsQuery(query: string): string {
  return tokenizeSearchQuery(query)
    .map((token) => `${token.replace(/"/g, '""')}*`)
    .join(' AND ')
}

function sqlLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchText(query)
  const tokens = normalized.match(/[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(tokens.filter((token) => token.length > 0))]
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/')
}

function compactSearchText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(0, maxLength - 4)).trimEnd()} ...`
}

function historyRecencyScore(updatedAt: number): number {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 0
  const ageDays = Math.max(0, Date.now() - updatedAt) / 86_400_000
  return Math.max(0, 36 - ageDays)
}

function normalizeHistorySearchLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_HISTORY_SEARCH_LIMIT
  return Math.max(1, Math.min(MAX_HISTORY_SEARCH_LIMIT, Math.trunc(limit)))
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isSearchDocumentKind(value: unknown): value is ChatHistorySearchDocumentKind {
  return value === 'activity' || value === 'message' || value === 'thread' || value === 'tool'
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
        homePluginSlug: thread.homePluginSlug,
        skillPath: thread.skillPath,
        skillCommand: thread.skillCommand,
        skillTitle: thread.skillTitle,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
        model: thread.chatState.model,
        modelPick: thread.chatState.modelPick,
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
        modelPick: thread.chatState.modelPick,
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

function safeModelPick(value: unknown): ChatState['modelPick'] {
  if (!isRecord(value)) return undefined
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const anthropicModel = typeof value.anthropicModel === 'string' ? value.anthropicModel.trim() : ''
  if (!providerId || !anthropicModel) return undefined
  return { providerId, anthropicModel }
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
  return value === 'home-plugin-customization' ||
    value === 'home-plugin-card-customization' ||
    value === 'task-run' ||
    value === 'skill-run'
    ? value
    : undefined
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
