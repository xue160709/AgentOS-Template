/**
 * Home Plugin 任务卡配置、调度与后台执行管理。
 * Task card config, scheduling, and background execution manager.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveProjectPath } from './project-path'
import type { ClaudeChatEvent } from '../src/claude-chat-types'
import type { ChatWorkspaceState, WorkspaceProject } from '../src/components/types'
import type {
  HomePluginManifest,
  HomePluginTaskConfig,
  HomePluginTaskEvent,
  HomePluginTaskMode,
  HomePluginTaskReadResult,
  HomePluginTaskRuntime,
  HomePluginTaskRunResult,
  HomePluginTaskSaveResult,
  HomePluginTaskSchedule,
  HomePluginTaskSkillStep,
  HomePluginTaskStopResult,
} from '../src/desktop-types'
import type { ClaudeAgentRunner } from './claude-agent-runner'

const HOME_PLUGIN_ROOT_DIR = '.agents/home-plugins'
const TASK_MANIFEST_FILE = 'manifest.json'
const TASK_ENTRY_FILE = 'extractor.js'
const TASK_CONFIG_FILE = 'task.json'
const TASK_RUNTIME_FILE = 'runtime.json'
const TASK_TITLE_MAX_LENGTH = 64
const TASK_THREAD_PURPOSE = 'task-run' as const
const TASK_INTERVAL_MINUTES: Record<HomePluginTaskSchedule['interval'], number> = {
  off: 0,
  '1h': 60,
  '2h': 120,
  '3h': 180,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
}

type ManagedTaskRecord = {
  projectPath: string
  projectId: string
  pluginPath: string
  manifestPath: string
  entryPath: string
  taskPath: string
  runtimePath: string
  manifest: HomePluginManifest
  task: HomePluginTaskConfig
  runtime: HomePluginTaskRuntime
}

type TaskRunSession = {
  key: string
  record: ManagedTaskRecord
  threadId: string
  threadSeed: HomePluginTaskEvent['thread']
  activeRequestId?: string
  cancelled: boolean
  started: Promise<{ requestId: string }>
  resolveStarted: (value: { requestId: string }) => void
  settleWaiters: Map<string, (outcome: TaskRequestOutcome) => void>
}

type TaskRequestOutcome =
  | { ok: true; requestId: string }
  | { ok: false; requestId: string; status: 'error' | 'cancelled'; message?: string }

type TaskDraftInput = {
  slug?: string
  title: string
  mode: HomePluginTaskMode
  skillSteps: HomePluginTaskSkillStep[]
  todoEnabled: boolean
  runCount: number
  schedule: HomePluginTaskSchedule
  enabled: boolean
}

type TaskManagerDeps = {
  getRunner: () => ClaudeAgentRunner | null
  getWorkspace: () => ChatWorkspaceState | null
  emitTaskEvent: (event: HomePluginTaskEvent) => void
}

/** 管理 Home Plugin 任务卡的创建、调度与后台运行 / Manage task-card creation, scheduling, and background runs */
export class TaskHomePluginManager {
  private readonly records = new Map<string, ManagedTaskRecord>()
  private readonly scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeSessions = new Map<string, TaskRunSession>()
  private readonly requestToTaskKey = new Map<string, string>()

  constructor(private readonly deps: TaskManagerDeps) {}

  private taskKey(projectPath: string, slug: string): string {
    return `${normalizeProjectPath(projectPath)}::${normalizeSlug(slug)}`
  }

  /** 刷新当前工作区内所有任务卡的调度缓存 / Refresh cached schedule state for the current workspace */
  async refreshFromWorkspace(workspace = this.deps.getWorkspace()): Promise<void> {
    const projectIds = new Set<string>()
    const nextRecords = new Map<string, ManagedTaskRecord>()

    for (const project of workspace?.projects ?? []) {
      projectIds.add(project.id)
      const records = await this.readProjectTasks(project)
      for (const record of records) {
        const key = this.taskKey(record.projectPath, record.task.slug)
        nextRecords.set(key, record)
        this.records.set(key, record)
        this.scheduleRecord(record)
      }
    }

    for (const [key, timer] of this.scheduleTimers.entries()) {
      if (!nextRecords.has(key)) {
        clearTimeout(timer)
        this.scheduleTimers.delete(key)
      }
    }

    for (const [key, session] of this.activeSessions.entries()) {
      if (!nextRecords.has(key) && !projectIds.has(session.record.projectId)) {
        this.activeSessions.delete(key)
      }
    }
  }

  /** 读取单个任务配置与运行态 / Read a single task config and runtime snapshot */
  async readTask(projectPath: string, slug: string): Promise<HomePluginTaskReadResult> {
    const resolvedProjectPath = resolveProjectPath(projectPath)
    const key = this.taskKey(resolvedProjectPath, slug)
    const cached = this.records.get(key)
    if (cached) {
      return {
        ok: true,
        rootPath: resolvedProjectPath,
        slug: cached.task.slug,
        task: cached.task,
        runtime: cached.runtime,
        manifest: cached.manifest,
      }
    }

    const record = await this.loadRecord(resolvedProjectPath, slug)
    if (!record) {
      return { ok: false, rootPath: resolvedProjectPath, slug, message: '未找到任务卡配置' }
    }
    this.records.set(key, record)
    return {
      ok: true,
      rootPath: resolvedProjectPath,
      slug: record.task.slug,
      task: record.task,
      runtime: record.runtime,
      manifest: record.manifest,
    }
  }

  /** 创建或更新任务卡配置 / Create or update a task-card config */
  async saveTask(projectPath: string, input: TaskDraftInput): Promise<HomePluginTaskSaveResult> {
    const resolvedProjectPath = resolveProjectPath(projectPath)
    const workspace = this.deps.getWorkspace()
    const project = workspace?.projects.find((item) => normalizeProjectPath(item.path) === resolvedProjectPath)
    if (!project) {
      return { ok: false, rootPath: resolvedProjectPath, message: '当前项目不在工作区中' }
    }

    const existingSlug = normalizeSlug(input.slug || '')
    const slug = existingSlug || createTaskSlug(input.title)
    const pluginPath = path.join(resolvedProjectPath, HOME_PLUGIN_ROOT_DIR, slug)
    const manifestPath = path.join(pluginPath, TASK_MANIFEST_FILE)
    const entryPath = path.join(pluginPath, TASK_ENTRY_FILE)
    const taskPath = path.join(pluginPath, TASK_CONFIG_FILE)
    const runtimePath = path.join(pluginPath, TASK_RUNTIME_FILE)
    const now = new Date().toISOString()

    const existingRecord = await this.loadRecord(resolvedProjectPath, slug)
    const runtime = normalizeTaskRuntime(
      await readJsonIfExists(runtimePath),
      resolvedProjectPath,
      slug,
      existingRecord?.runtime,
    )
    const task = normalizeTaskConfig(
      {
        version: 1,
        slug,
        title: input.title,
        mode: input.mode,
        skillSteps: input.skillSteps,
        todoEnabled: input.todoEnabled,
        runCount: input.runCount,
        schedule: input.schedule,
        enabled: input.enabled,
        createdAt: existingRecord?.task.createdAt ?? now,
        updatedAt: now,
      },
      slug,
    )

    runtime.projectPath = resolvedProjectPath
    runtime.slug = slug
    runtime.threadTitle = deriveTaskThreadTitle(task)
    runtime.updatedAt = now
    if (runtime.threadId) {
      runtime.threadTitle = deriveTaskThreadTitle(task)
    }

    const manifest = normalizeTaskManifest(
      {
        id: existingRecord?.manifest.id ?? `agentos.task.${slug}`,
        name: task.title,
        version: existingRecord?.manifest.version ?? '1.0.0',
        description: `Task card for ${task.title}`,
        entry: TASK_ENTRY_FILE,
        outputFormat: 'a2ui.v0.9',
        kind: 'task',
        preferredSize: existingRecord?.manifest.preferredSize ?? 'small',
        createdAt: existingRecord?.manifest.createdAt ?? now,
        updatedAt: now,
      },
      slug,
    )

    await fs.mkdir(pluginPath, { recursive: true })
    await fs.writeFile(entryPath, `${buildTaskExtractorSource()}\n`, 'utf8')
    await writeJson(manifestPath, manifest)
    await writeJson(taskPath, task)
    await writeJson(runtimePath, runtime)

    const record: ManagedTaskRecord = {
      projectPath: resolvedProjectPath,
      projectId: project.id,
      pluginPath,
      manifestPath,
      entryPath,
      taskPath,
      runtimePath,
      manifest,
      task,
      runtime,
    }
    this.records.set(this.taskKey(resolvedProjectPath, slug), record)
    this.scheduleRecord(record)
    this.emitTaskEvent(record)

    return {
      ok: true,
      rootPath: resolvedProjectPath,
      pluginRootPath: path.join(resolvedProjectPath, HOME_PLUGIN_ROOT_DIR),
      slug,
      manifestPath,
      taskPath,
      runtimePath,
      manifest,
      task,
      runtime,
    }
  }

  /** 启动某个任务卡的后台执行 / Start a task-card background run */
  async startTask(projectPath: string, slug: string): Promise<HomePluginTaskRunResult> {
    const resolvedProjectPath = resolveProjectPath(projectPath)
    const record = await this.ensureRecord(resolvedProjectPath, slug)
    if (!record) {
      return { ok: false, rootPath: resolvedProjectPath, slug, message: '未找到任务卡配置' }
    }

    const key = this.taskKey(record.projectPath, record.task.slug)
    if (this.activeSessions.has(key)) {
      return { ok: false, rootPath: resolvedProjectPath, slug: record.task.slug, message: '当前任务正在运行中' }
    }
    if (record.task.mode === 'skills' && record.task.skillSteps.length === 0) {
      return { ok: false, rootPath: resolvedProjectPath, slug: record.task.slug, message: '编排 Skills 至少需要一个步骤' }
    }

    const workspace = this.deps.getWorkspace()
    const project = workspace?.projects.find((item) => item.id === record.projectId)
      ?? workspace?.projects.find((item) => normalizeProjectPath(item.path) === resolvedProjectPath)
    if (!project) {
      return { ok: false, rootPath: resolvedProjectPath, slug: record.task.slug, message: '当前项目未在工作区中' }
    }
    record.projectId = project.id

    if (!this.deps.getRunner()) {
      return { ok: false, rootPath: resolvedProjectPath, slug: record.task.slug, message: 'Claude runner is not ready' }
    }

    const threadId = record.runtime.threadId || createThreadId(record.task.slug)
    const threadTitle = deriveTaskThreadTitle(record.task)
    const threadSeed = record.runtime.threadId
      ? undefined
      : {
          id: threadId,
          projectId: project.id,
          title: threadTitle,
          purpose: TASK_THREAD_PURPOSE,
          homePluginSlug: record.task.slug,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

    if (!record.runtime.threadId) {
      record.runtime.threadId = threadId
    }
    record.runtime.threadTitle = threadTitle
    record.runtime.projectPath = resolvedProjectPath
    record.runtime.slug = record.task.slug
    record.runtime.status = 'queued'
    record.runtime.requestId = undefined
    record.runtime.runIndex = undefined
    record.runtime.runTotal = undefined
    record.runtime.stepIndex = undefined
    record.runtime.stepTotal = undefined
    record.runtime.stepTitle = undefined
    record.runtime.lastError = undefined
    record.runtime.lastRunAt = new Date().toISOString()
    record.runtime.updatedAt = new Date().toISOString()
    await writeJson(record.runtimePath, record.runtime)
    this.emitTaskEvent(record, threadSeed)

    const session: TaskRunSession = {
      key,
      record,
      threadId,
      threadSeed,
      cancelled: false,
      started: Promise.resolve({ requestId: '' }),
      resolveStarted: () => {},
      settleWaiters: new Map(),
    }
    session.started = new Promise((resolve) => {
      session.resolveStarted = resolve
    })
    this.activeSessions.set(key, session)

    void this.runTaskSession(session).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      record.runtime.status = 'error'
      record.runtime.lastError = message
      record.runtime.detail = message
      record.runtime.updatedAt = new Date().toISOString()
      void writeJson(record.runtimePath, record.runtime)
      this.emitTaskEvent(record, threadSeed)
      session.resolveStarted({ requestId: record.runtime.requestId || '' })
      this.finishSession(session, { ok: false, requestId: record.runtime.requestId || '', status: 'error', message })
    })

    const started = await session.started
    if (!started.requestId) {
      return {
        ok: false,
        rootPath: resolvedProjectPath,
        slug: record.task.slug,
        message: record.runtime.lastError || '任务启动失败',
      }
    }
    return {
      ok: true,
      rootPath: resolvedProjectPath,
      slug: record.task.slug,
      threadId,
      requestId: started.requestId,
      title: threadTitle,
    }
  }

  /** 停止某个任务卡的当前运行 / Stop the active run for a task-card */
  async stopTask(projectPath: string, slug: string): Promise<HomePluginTaskStopResult> {
    const resolvedProjectPath = resolveProjectPath(projectPath)
    const key = this.taskKey(resolvedProjectPath, slug)
    const session = this.activeSessions.get(key)
    if (!session) {
      return { ok: true, rootPath: resolvedProjectPath, slug, stopped: false }
    }

    session.cancelled = true
    const requestId = session.record.runtime.requestId || session.activeRequestId
    if (requestId && this.deps.getRunner()) {
      await this.deps.getRunner()!.cancel(requestId)
    }
    session.record.runtime.status = 'cancelled'
    session.record.runtime.lastCompletedAt = new Date().toISOString()
    session.record.runtime.updatedAt = session.record.runtime.lastCompletedAt
    session.record.runtime.detail = '已手动终止'
    await writeJson(session.record.runtimePath, session.record.runtime)
    this.emitTaskEvent(session.record, session.threadSeed)
    if (requestId) {
      this.resolveWaiter(requestId, { ok: false, requestId, status: 'cancelled', message: '已终止' })
    } else {
      this.finishSession(session, { ok: false, requestId: '', status: 'cancelled', message: '已终止' })
    }
    return { ok: true, rootPath: resolvedProjectPath, slug, stopped: true }
  }

  /** 处理 Claude 事件并推动任务运行态 / Mirror Claude events into task runtime state */
  handleClaudeEvent(event: ClaudeChatEvent): void {
    const key = this.requestToTaskKey.get(event.requestId)
    if (!key) return
    const session = this.activeSessions.get(key)
    if (!session) return

    if (event.type === 'session_start') {
      if (!session.record.runtime.threadId && event.threadId) {
        session.record.runtime.threadId = event.threadId
      }
      session.record.runtime.status = 'running'
      session.record.runtime.requestId = event.requestId
      session.record.runtime.updatedAt = new Date().toISOString()
      session.record.runtime.detail = '开始执行'
      void this.flushRuntime(session.record, session.threadSeed)
      return
    }

    if (event.type === 'agent_activity') {
      if (event.status === 'running') {
        session.record.runtime.status = 'running'
      }
      if (event.title) {
        session.record.runtime.summary = event.title
      }
      if (event.detail) {
        session.record.runtime.detail = event.detail
      }
      session.record.runtime.updatedAt = new Date().toISOString()
      void this.flushRuntime(session.record, session.threadSeed)
      return
    }

    if (event.type === 'result') {
      session.record.runtime.lastResult = truncate(event.result.trim(), 180)
      session.record.runtime.lastCompletedAt = new Date().toISOString()
      session.record.runtime.updatedAt = session.record.runtime.lastCompletedAt
      session.record.runtime.detail = truncate(event.result.trim() || '步骤完成', 180)
      void this.flushRuntime(session.record, session.threadSeed)
      this.resolveWaiter(event.requestId, { ok: true, requestId: event.requestId })
      return
    }

    if (event.type === 'error') {
      session.record.runtime.status = 'error'
      session.record.runtime.lastError = event.message
      session.record.runtime.detail = event.message
      session.record.runtime.updatedAt = new Date().toISOString()
      void this.flushRuntime(session.record, session.threadSeed)
      this.resolveWaiter(event.requestId, { ok: false, requestId: event.requestId, status: 'error', message: event.message })
      this.finishSession(session, { ok: false, requestId: event.requestId, status: 'error', message: event.message })
      return
    }

    if (event.type === 'cancelled') {
      session.record.runtime.status = 'cancelled'
      session.record.runtime.lastCompletedAt = new Date().toISOString()
      session.record.runtime.detail = '已终止'
      session.record.runtime.updatedAt = session.record.runtime.lastCompletedAt
      void this.flushRuntime(session.record, session.threadSeed)
      this.resolveWaiter(event.requestId, { ok: false, requestId: event.requestId, status: 'cancelled', message: '已终止' })
      this.finishSession(session, { ok: false, requestId: event.requestId, status: 'cancelled', message: '已终止' })
    }
  }

  private async runTaskSession(session: TaskRunSession): Promise<void> {
    const record = session.record
    const task = record.task
    const runs = Math.max(1, Math.min(100, Math.trunc(task.runCount) || 1))
    const steps = task.mode === 'skills' ? task.skillSteps : []
    const totalSteps = task.mode === 'skills' ? Math.max(1, steps.length) : 1
    const runner = this.deps.getRunner()
    if (!runner) throw new Error('Claude runner is not ready')

    session.record.runtime.status = 'running'
    session.record.runtime.runTotal = runs
    session.record.runtime.stepTotal = totalSteps
    session.record.runtime.threadId = session.threadId
    session.record.runtime.threadTitle = deriveTaskThreadTitle(task)
    session.record.runtime.updatedAt = new Date().toISOString()
    await this.flushRuntime(record, session.threadSeed)

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      if (session.cancelled) break
      session.record.runtime.runIndex = runIndex + 1
      if (task.mode === 'skills') {
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
          if (session.cancelled) break
          const step = steps[stepIndex]
          const prompt = buildSkillStepPrompt(task, step, runIndex + 1, runs, stepIndex + 1, steps.length)
          session.record.runtime.stepIndex = stepIndex + 1
          session.record.runtime.stepTitle = step.title
          session.record.runtime.detail = `第 ${stepIndex + 1}/${steps.length} 步 · ${step.title}`
          session.record.runtime.status = 'running'
          session.record.runtime.updatedAt = new Date().toISOString()
          await this.flushRuntime(record, session.threadSeed)

          const outcome = await this.submitAndWait(runner, session, prompt, {
            mode: 'home-plugin-task-run',
            todoEnabled: task.todoEnabled,
          })
          if (!outcome.ok) {
            if (outcome.status === 'cancelled') {
              session.cancelled = true
              break
            }
            throw new Error(outcome.message || '任务步骤执行失败')
          }
        }
      } else {
        session.record.runtime.stepIndex = 1
        session.record.runtime.stepTitle = 'AGENT.md'
        session.record.runtime.detail = `第 ${runIndex + 1}/${runs} 次执行`
        session.record.runtime.status = 'running'
        session.record.runtime.updatedAt = new Date().toISOString()
        await this.flushRuntime(record, session.threadSeed)

        const prompt = buildAgentTaskPrompt(task, runIndex + 1, runs)
        const outcome = await this.submitAndWait(runner, session, prompt, {
          mode: 'home-plugin-task-run',
          todoEnabled: task.todoEnabled,
        })
        if (!outcome.ok) {
          if (outcome.status === 'cancelled') {
            session.cancelled = true
            break
          }
          throw new Error(outcome.message || '任务执行失败')
        }
      }
    }

    if (session.cancelled) {
      record.runtime.status = 'cancelled'
      record.runtime.detail = '已终止'
    } else if (record.runtime.status !== 'error') {
      record.runtime.status = 'done'
      record.runtime.detail = '任务完成'
      record.runtime.lastCompletedAt = new Date().toISOString()
    }
    record.runtime.updatedAt = new Date().toISOString()
    await this.flushRuntime(record, session.threadSeed)
    this.finishSession(session)
    this.scheduleRecord(record)
  }

  private async submitAndWait(
    runner: ClaudeAgentRunner,
    session: TaskRunSession,
    prompt: string,
    options: { mode: 'home-plugin-task-run'; todoEnabled: boolean },
  ): Promise<TaskRequestOutcome> {
    const key = session.key
    const payload = {
      text: prompt,
      threadId: session.threadId,
      cwd: session.record.projectPath,
      promptMode: options.mode,
      agentModeSettingsOverride: {
        enabled: true,
        todoEnabled: options.todoEnabled,
      },
    } as const
    const { requestId } = runner.submit(payload)
    session.activeRequestId = requestId
    session.record.runtime.requestId = requestId
    session.record.runtime.status = 'running'
    session.record.runtime.updatedAt = new Date().toISOString()
    this.requestToTaskKey.set(requestId, key)
    await this.flushRuntime(session.record, session.threadSeed)
    if (session.started) {
      session.resolveStarted({ requestId })
      session.started = Promise.resolve({ requestId })
    }

    const outcome = await new Promise<TaskRequestOutcome>((resolve) => {
      session.settleWaiters.set(requestId, resolve)
    })

    session.settleWaiters.delete(requestId)
    session.activeRequestId = undefined
    await delay(0)
    return outcome
  }

  private resolveWaiter(requestId: string, outcome: TaskRequestOutcome): void {
    const key = this.requestToTaskKey.get(requestId)
    if (!key) return
    const session = this.activeSessions.get(key)
    if (!session) return
    const resolve = session.settleWaiters.get(requestId)
    if (resolve) {
      resolve(outcome)
    }
    session.settleWaiters.delete(requestId)
    this.requestToTaskKey.delete(requestId)
  }

  private finishSession(session: TaskRunSession, outcome?: TaskRequestOutcome): void {
    const current = this.activeSessions.get(session.key)
    if (!current) return
    if (current.activeRequestId) {
      this.requestToTaskKey.delete(current.activeRequestId)
    }
    this.activeSessions.delete(session.key)
    if (outcome && current.record.runtime.requestId === outcome.requestId) {
      current.record.runtime.updatedAt = new Date().toISOString()
    }
  }

  private async flushRuntime(record: ManagedTaskRecord, threadSeed?: HomePluginTaskEvent['thread']): Promise<void> {
    record.runtime.updatedAt = new Date().toISOString()
    await writeJson(record.runtimePath, record.runtime)
    this.emitTaskEvent(record, threadSeed)
  }

  private scheduleRecord(record: ManagedTaskRecord): void {
    const key = this.taskKey(record.projectPath, record.task.slug)
    const existing = this.scheduleTimers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.scheduleTimers.delete(key)
    }

    if (!record.task.enabled || !record.task.schedule.enabled || record.runtime.status === 'running') {
      const nextRunAt = record.task.enabled && record.task.schedule.enabled && record.runtime.status !== 'running'
        ? computeNextRunAt(record, Date.now())
        : undefined
      record.runtime.nextRunAt = nextRunAt ? new Date(nextRunAt).toISOString() : undefined
      void writeJson(record.runtimePath, record.runtime)
      this.emitTaskEvent(record)
      return
    }

    const nextRunAt = computeNextRunAt(record, Date.now())
    if (!nextRunAt) {
      record.runtime.nextRunAt = undefined
      void writeJson(record.runtimePath, record.runtime)
      this.emitTaskEvent(record)
      return
    }

    const delay = Math.max(250, nextRunAt - Date.now())
    record.runtime.nextRunAt = new Date(nextRunAt).toISOString()
    void writeJson(record.runtimePath, record.runtime)
    this.emitTaskEvent(record)
    const timer = setTimeout(() => {
      this.scheduleTimers.delete(key)
      void this.startTask(record.projectPath, record.task.slug)
    }, delay)
    this.scheduleTimers.set(key, timer)
  }

  private emitTaskEvent(record: ManagedTaskRecord, threadSeed?: HomePluginTaskEvent['thread']): void {
    const thread =
      threadSeed ??
      (record.runtime.threadId
        ? {
            id: record.runtime.threadId,
            projectId: record.projectId,
            title: record.runtime.threadTitle || deriveTaskThreadTitle(record.task),
            purpose: TASK_THREAD_PURPOSE,
            homePluginSlug: record.task.slug,
            createdAt: Date.parse(record.task.createdAt) || Date.now(),
            updatedAt: Date.parse(record.task.updatedAt) || Date.now(),
          }
        : undefined)
    this.deps.emitTaskEvent({
      projectPath: record.projectPath,
      slug: record.task.slug,
      task: record.task,
      runtime: record.runtime,
      ...(thread ? { thread } : {}),
    })
  }

  private async ensureRecord(projectPath: string, slug: string): Promise<ManagedTaskRecord | null> {
    const key = this.taskKey(projectPath, slug)
    const cached = this.records.get(key)
    if (cached) return cached
    const record = await this.loadRecord(projectPath, slug)
    if (record) this.records.set(key, record)
    return record
  }

  private async readProjectTasks(project: WorkspaceProject): Promise<ManagedTaskRecord[]> {
    const pluginRootPath = path.join(resolveProjectPath(project.path), HOME_PLUGIN_ROOT_DIR)
    if (!(await exists(pluginRootPath))) return []
    const entries = await fs.readdir(pluginRootPath, { withFileTypes: true }).catch(() => [])
    const tasks: ManagedTaskRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const slug = normalizeSlug(entry.name)
      if (!slug) continue
      const record = await this.loadRecord(project.path, slug, project.id)
      if (record) tasks.push(record)
    }
    return tasks
  }

  private async loadRecord(projectPath: string, slug: string, knownProjectId?: string): Promise<ManagedTaskRecord | null> {
    const resolvedProjectPath = resolveProjectPath(projectPath)
    const pluginPath = path.join(resolvedProjectPath, HOME_PLUGIN_ROOT_DIR, slug)
    const manifestPath = path.join(pluginPath, TASK_MANIFEST_FILE)
    const entryPath = path.join(pluginPath, TASK_ENTRY_FILE)
    const taskPath = path.join(pluginPath, TASK_CONFIG_FILE)
    const runtimePath = path.join(pluginPath, TASK_RUNTIME_FILE)
    const [manifestRaw, taskRaw, runtimeRaw] = await Promise.all([
      readJsonIfExists(manifestPath),
      readJsonIfExists(taskPath),
      readJsonIfExists(runtimePath),
    ])
    if (!manifestRaw || !taskRaw || !await exists(entryPath)) return null
    await fs.writeFile(entryPath, `${buildTaskExtractorSource()}\n`, 'utf8')
    const manifest = normalizeTaskManifest(manifestRaw, slug)
    const task = normalizeTaskConfig(taskRaw, slug)
    const runtime = normalizeTaskRuntime(runtimeRaw, resolvedProjectPath, slug)
    return {
      projectPath: resolvedProjectPath,
      projectId: knownProjectId || '',
      pluginPath,
      manifestPath,
      entryPath,
      taskPath,
      runtimePath,
      manifest,
      task,
      runtime,
    }
  }
}

function buildTaskExtractorSource(): string {
  return `async function run(host) {
  const diagnostics = []
  const task = (await readJsonIfExists(host, 'task.json')) || {}
  const runtime = (await readJsonIfExists(host, 'runtime.json')) || {}
  const manifest = (await readJsonIfExists(host, 'manifest.json')) || {}
  const title = normalizeText(task.title || manifest.name || 'Task')
  const mode = task.mode === 'skills' ? 'skills' : 'agent'
  const modeLabel = mode === 'skills' ? '编排Skills' : '基于当前Agent.md运行'
  const status = normalizeText(runtime.status || 'idle')
  const statusLabel = statusLabelFor(status)
  const isActive = status === 'running' || status === 'queued' || status === 'waiting'
  const summary = normalizeText(runtime.summary || runtime.detail || '')
  const detail = normalizeText(runtime.detail || '')
  const scheduleLabel = buildScheduleLabel(task.schedule)
  const runCount = typeof task.runCount === 'number' && task.runCount > 0 ? task.runCount : 1
  const todoLabel = task.todoEnabled ? 'TODO 已开启' : 'TODO 已关闭'
  const stepLabel = buildStepLabel(runtime)
  const threadTitle = normalizeText(runtime.threadTitle || '')
  const runAction = {
    event: {
      name: 'task_run',
      context: { slug: slugFromManifest(manifest) },
    },
  }
  const stopAction = {
    event: {
      name: 'task_stop',
      context: { slug: slugFromManifest(manifest) },
    },
  }

  const data = {
    task: {
      title,
      modeLabel,
      statusLabel,
      summary: summary || stepLabel || '等待执行',
      detail: detail || scheduleLabel || todoLabel,
      scheduleLabel,
      todoLabel,
      runCount,
      runCountLabel: '运行次数：' + runCount,
      threadTitle,
      slug: slugFromManifest(manifest),
    },
  }

  const messages = [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'project-home',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
      },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'project-home',
        components: buildComponents(runAction, stopAction, isActive),
      },
    },
    {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'project-home',
        path: '/',
        value: data,
      },
    },
  ]

  diagnostics.push('task: ' + title)
  diagnostics.push('mode: ' + mode)
  diagnostics.push('status: ' + status)

  return { version: 1, messages, diagnostics }
}

function buildComponents(runAction, stopAction, isActive) {
  const actionChildren = isActive ? ['action-stop'] : ['action-run']
  return [
    {
      id: 'root',
      component: 'Column',
      children: ['header-row', 'summary-text', 'detail-text', 'meta-row', 'action-row'],
    },
    {
      id: 'header-row',
      component: 'Row',
      align: 'center',
      justify: 'spaceBetween',
      children: ['header-copy', 'header-status'],
    },
    {
      id: 'header-copy',
      component: 'Column',
      children: ['task-title', 'task-mode'],
    },
    { id: 'task-title', component: 'Text', variant: 'h2', text: { path: '/task/title' } },
    { id: 'task-mode', component: 'Text', variant: 'body', text: { path: '/task/modeLabel' } },
    { id: 'header-status', component: 'Text', variant: 'body', text: { path: '/task/statusLabel' } },
    { id: 'summary-text', component: 'Text', variant: 'body', text: { path: '/task/summary' } },
    { id: 'detail-text', component: 'Text', variant: 'body', text: { path: '/task/detail' } },
    {
      id: 'meta-row',
      component: 'Row',
      align: 'center',
      children: ['task-schedule', 'task-todo', 'task-run-count', 'task-thread-title'],
    },
    { id: 'task-schedule', component: 'Text', variant: 'body', text: { path: '/task/scheduleLabel' } },
    { id: 'task-todo', component: 'Text', variant: 'body', text: { path: '/task/todoLabel' } },
    {
      id: 'task-run-count',
      component: 'Text',
      variant: 'body',
      text: { path: '/task/runCountLabel' },
    },
    { id: 'task-thread-title', component: 'Text', variant: 'body', text: { path: '/task/threadTitle' } },
    {
      id: 'action-row',
      component: 'Row',
      align: 'center',
      justify: 'end',
      children: actionChildren,
    },
    { id: 'action-stop', component: 'Button', variant: 'borderless', child: 'action-stop-label', action: stopAction },
    { id: 'action-stop-label', component: 'Text', text: '终止' },
    { id: 'action-run', component: 'Button', variant: 'primary', child: 'action-run-label', action: runAction },
    { id: 'action-run-label', component: 'Text', text: '执行' },
  ]
}

function statusLabelFor(status) {
  if (status === 'running' || status === 'queued') return '正在执行'
  if (status === 'waiting') return '等待中'
  if (status === 'done') return '已完成'
  if (status === 'error') return '执行失败'
  if (status === 'cancelled') return '已终止'
  return '待执行'
}

function buildScheduleLabel(schedule) {
  if (!schedule || typeof schedule !== 'object') return '定时：未开启'
  const enabled = schedule.enabled === true
  const hour = pad2(typeof schedule.hour === 'number' ? schedule.hour : 0)
  const minute = pad2(typeof schedule.minute === 'number' ? schedule.minute : 0)
  const interval = typeof schedule.interval === 'string' ? schedule.interval : 'off'
  const intervalLabel = interval === 'off'
    ? '不开启'
    : interval === '1h'
      ? '1小时'
      : interval === '2h'
        ? '2小时'
        : interval === '3h'
          ? '3小时'
          : interval === '6h'
            ? '6小时'
            : interval === '12h'
              ? '12小时'
              : '1天'
  return enabled ? '定时：' + hour + ':' + minute + ' / ' + intervalLabel : '定时：未开启'
}

function buildStepLabel(runtime) {
  if (!runtime) return ''
  if (runtime.stepTitle) return '步骤：' + runtime.stepTitle
  if (runtime.runIndex && runtime.runTotal) return '第 ' + runtime.runIndex + '/' + runtime.runTotal + ' 次'
  return ''
}

function slugFromManifest(manifest) {
  if (manifest && typeof manifest === 'object' && typeof manifest.id === 'string') {
    const parts = manifest.id.split('.')
    return parts[parts.length - 1] || 'task'
  }
  return 'task'
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readJsonIfExists(host, relativePath) {
  return host.readJson(relativePath).catch(() => null)
}

function pad2(value) {
  return String(Math.max(0, Math.min(99, Math.trunc(value)))).padStart(2, '0')
}
`
}

function normalizeTaskManifest(raw: unknown, slug: string): HomePluginManifest {
  const value = isRecord(raw) ? raw : {}
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString()
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `agentos.task.${slug}`,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : titleFromSlug(slug),
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim() : '1.0.0',
    description:
      typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : `Task card for ${titleFromSlug(slug)}`,
    entry: typeof value.entry === 'string' && value.entry.trim() ? value.entry.trim() : TASK_ENTRY_FILE,
    outputFormat: typeof value.outputFormat === 'string' && value.outputFormat.trim() ? value.outputFormat.trim() : 'a2ui.v0.9',
    kind: 'task',
    preferredSize: value.preferredSize === 'small' || value.preferredSize === 'large' ? value.preferredSize : 'small',
    threadId: typeof value.threadId === 'string' && value.threadId.trim() ? value.threadId.trim() : undefined,
    createdAt,
    updatedAt,
    order: typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : undefined,
  }
}

function normalizeTaskConfig(raw: unknown, slug: string): HomePluginTaskConfig {
  const value = isRecord(raw) ? raw : {}
  const skillSteps = Array.isArray(value.skillSteps)
    ? value.skillSteps
        .map((step): HomePluginTaskSkillStep | undefined => {
          if (!isRecord(step)) return undefined
          const id = typeof step.id === 'string' && step.id.trim() ? step.id.trim() : randomUUID()
          const command = typeof step.command === 'string' && step.command.trim() ? step.command.trim() : ''
          const pathValue = typeof step.path === 'string' && step.path.trim() ? step.path.trim() : ''
          const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : command || titleFromPath(pathValue)
          if (!command || !pathValue) return undefined
          return {
            id,
            command,
            path: pathValue,
            title,
            description: typeof step.description === 'string' && step.description.trim() ? step.description.trim() : undefined,
            addedAt: typeof step.addedAt === 'string' && step.addedAt.trim() ? step.addedAt.trim() : new Date().toISOString(),
          }
        })
        .filter((step): step is HomePluginTaskSkillStep => Boolean(step))
    : []

  return {
    version: 1,
    slug,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : titleFromSlug(slug),
    mode: value.mode === 'skills' ? 'skills' : 'agent',
    skillSteps,
    todoEnabled: value.todoEnabled === true,
    runCount: clampNumber(value.runCount, 1, 100, 1),
    schedule: normalizeTaskSchedule(value.schedule),
    enabled: value.enabled === true,
    createdAt: typeof value.createdAt === 'string' && value.createdAt.trim() ? value.createdAt.trim() : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt.trim() ? value.updatedAt.trim() : new Date().toISOString(),
  }
}

function normalizeTaskSchedule(raw: unknown): HomePluginTaskSchedule {
  if (!isRecord(raw)) {
    return { enabled: false, hour: 9, minute: 0, interval: 'off' }
  }
  const interval = raw.interval === '1h' || raw.interval === '2h' || raw.interval === '3h' || raw.interval === '6h' || raw.interval === '12h' || raw.interval === '1d'
    ? raw.interval
    : 'off'
  return {
    enabled: raw.enabled === true,
    hour: clampNumber(raw.hour, 0, 23, 9),
    minute: clampNumber(raw.minute, 0, 59, 0),
    interval,
  }
}

function normalizeTaskRuntime(
  raw: unknown,
  projectPath: string,
  slug: string,
  fallback?: HomePluginTaskRuntime,
): HomePluginTaskRuntime {
  const base = isRecord(raw) ? raw : {}
  return {
    version: 1,
    projectPath: typeof base.projectPath === 'string' && base.projectPath.trim() ? base.projectPath.trim() : projectPath,
    slug: typeof base.slug === 'string' && base.slug.trim() ? base.slug.trim() : slug,
    threadId: typeof base.threadId === 'string' && base.threadId.trim() ? base.threadId.trim() : fallback?.threadId,
    threadTitle: typeof base.threadTitle === 'string' && base.threadTitle.trim() ? base.threadTitle.trim() : fallback?.threadTitle,
    status: normalizeTaskRuntimeStatus(base.status || fallback?.status),
    requestId: typeof base.requestId === 'string' && base.requestId.trim() ? base.requestId.trim() : fallback?.requestId,
    runIndex: clampOptionalNumber(base.runIndex, 1, 100) ?? fallback?.runIndex,
    runTotal: clampOptionalNumber(base.runTotal, 1, 100) ?? fallback?.runTotal,
    stepIndex: clampOptionalNumber(base.stepIndex, 1, 100) ?? fallback?.stepIndex,
    stepTotal: clampOptionalNumber(base.stepTotal, 1, 100) ?? fallback?.stepTotal,
    stepTitle: typeof base.stepTitle === 'string' && base.stepTitle.trim() ? base.stepTitle.trim() : fallback?.stepTitle,
    lastRunAt: typeof base.lastRunAt === 'string' && base.lastRunAt.trim() ? base.lastRunAt.trim() : fallback?.lastRunAt,
    lastCompletedAt:
      typeof base.lastCompletedAt === 'string' && base.lastCompletedAt.trim() ? base.lastCompletedAt.trim() : fallback?.lastCompletedAt,
    lastResult: typeof base.lastResult === 'string' && base.lastResult.trim() ? base.lastResult.trim() : fallback?.lastResult,
    lastError: typeof base.lastError === 'string' && base.lastError.trim() ? base.lastError.trim() : fallback?.lastError,
    nextRunAt: typeof base.nextRunAt === 'string' && base.nextRunAt.trim() ? base.nextRunAt.trim() : fallback?.nextRunAt,
    summary: typeof base.summary === 'string' && base.summary.trim() ? base.summary.trim() : fallback?.summary,
    detail: typeof base.detail === 'string' && base.detail.trim() ? base.detail.trim() : fallback?.detail,
    updatedAt: typeof base.updatedAt === 'string' && base.updatedAt.trim() ? base.updatedAt.trim() : new Date().toISOString(),
  }
}

function normalizeTaskRuntimeStatus(value: unknown): HomePluginTaskRuntime['status'] {
  return value === 'queued' || value === 'running' || value === 'waiting' || value === 'done' || value === 'error' || value === 'cancelled'
    ? value
    : 'idle'
}

function computeNextRunAt(record: ManagedTaskRecord, now: number): number | null {
  if (!record.task.enabled || !record.task.schedule.enabled) return null
  const schedule = record.task.schedule
  const intervalMinutes = TASK_INTERVAL_MINUTES[schedule.interval]
  if (intervalMinutes === 0 && record.runtime.lastCompletedAt) {
    const completedAt = Date.parse(record.runtime.lastCompletedAt)
    const taskUpdatedAt = Date.parse(record.task.updatedAt)
    if (Number.isFinite(completedAt) && completedAt >= (Number.isFinite(taskUpdatedAt) ? taskUpdatedAt : 0)) {
      return null
    }
  }
  const anchor = new Date(now)
  const today = new Date(anchor)
  today.setHours(schedule.hour, schedule.minute, 0, 0)

  if (record.runtime.lastCompletedAt && intervalMinutes > 0) {
    const lastCompletedAt = Date.parse(record.runtime.lastCompletedAt)
    if (Number.isFinite(lastCompletedAt)) {
      return lastCompletedAt + intervalMinutes * 60_000
    }
  }

  if (intervalMinutes > 0) {
    if (today.getTime() > now) return today.getTime()
    return today.getTime() + intervalMinutes * 60_000
  }

  if (today.getTime() > now) return today.getTime()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow.getTime()
}

function buildAgentTaskPrompt(task: HomePluginTaskConfig, runIndex: number, runTotal: number): string {
  return [
    `任务标题：${task.title}`,
    `这是第 ${runIndex}/${runTotal} 次运行。`,
    '请按当前项目的 AGENT.md 执行这个后台任务。',
    task.todoEnabled ? '当前任务已开启 TODO 模式，请把 TODO.md 作为执行计划。' : '当前任务未开启 TODO 模式。',
    '这是后台线程，请保持在同一条任务线程内完成执行。'
  ].join('\n')
}

function buildSkillStepPrompt(
  task: HomePluginTaskConfig,
  step: HomePluginTaskSkillStep,
  runIndex: number,
  runTotal: number,
  stepIndex: number,
  stepTotal: number,
): string {
  return [
    `/${step.command} ${task.title}`,
    '',
    `任务标题：${task.title}`,
    `这是第 ${runIndex}/${runTotal} 次运行，第 ${stepIndex}/${stepTotal} 个技能步骤。`,
    `步骤名称：${step.title}`,
    step.description ? `步骤说明：${step.description}` : '',
    '保持在同一条后台任务线程中执行，不要切到前台。',
  ]
    .filter(Boolean)
    .join('\n')
}

function deriveTaskThreadTitle(task: HomePluginTaskConfig): string {
  const title = task.mode === 'agent' ? '执行agent' : `执行${task.title}`
  return truncate(title, TASK_TITLE_MAX_LENGTH)
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Task'
}

function titleFromPath(filePath: string): string {
  const parts = filePath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || 'Skill'
}

function createTaskSlug(title: string): string {
  const base = normalizeSlug(title) || 'task'
  return `${base}-${randomUUID().slice(0, 8)}`
}

function createThreadId(slug: string): string {
  return `task-${normalizeSlug(slug) || 'run'}-${randomUUID().slice(0, 8)}`
}

function normalizeSlug(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

function normalizeProjectPath(value: string): string {
  return resolveProjectPath(value)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(min, Math.min(max, n))
}

function clampOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
