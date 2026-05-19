/**
 * 项目路径相关的纯字符串逻辑（渲染进程与主进程均可引用）。
 * Path-related string helpers safe for renderer and main process.
 */

import type { ChatWorkspaceState, WorkspaceProject } from './components/types'

/** 模板内建的旧版示例项目 id（用于迁移识别）/ Legacy bundled seed project id used for migration heuristics */
export const LEGACY_SEED_PROJECT_ID = 'project-codex-ui-template'

/** 判断是否仍指向模板仓库路径或旧 seed id / Detect legacy template seed project by id or filesystem path */
export function isLegacySeedProject(project: Pick<WorkspaceProject, 'id' | 'path'>): boolean {
  if (project.id === LEGACY_SEED_PROJECT_ID) return true
  const normalized = project.path.replace(/\\/g, '/').toLowerCase()
  return normalized.includes('codex-ui-template')
}

/** 从状态中剔除遗留 seed 项目及其线程 / Remove legacy seed projects (and their threads) from persisted state */
export function migrateLegacySeedProjects(state: ChatWorkspaceState): ChatWorkspaceState {
  const removedIds = new Set(state.projects.filter(isLegacySeedProject).map((project) => project.id))
  if (removedIds.size === 0) return state

  const projects = state.projects.filter((project) => !removedIds.has(project.id))
  const threads = state.threads.filter((thread) => !removedIds.has(thread.projectId))
  const activeProjectRemoved = removedIds.has(state.activeProjectId)
  const activeThreadRemoved =
    activeProjectRemoved ||
    state.threads.some((thread) => thread.id === state.activeThreadId && removedIds.has(thread.projectId))

  return {
    ...state,
    projects,
    threads,
    activeProjectId: activeProjectRemoved ? '' : state.activeProjectId,
    activeThreadId: activeThreadRemoved ? '' : state.activeThreadId,
  }
}

/** 若当前激活项目缺失或路径失效，则回退到首个可用项目 / Pick a valid active project when the current one is missing or broken */
export function reconcileActiveProject(state: ChatWorkspaceState): ChatWorkspaceState {
  if (state.projects.length === 0) {
    return { ...state, activeProjectId: '', activeThreadId: '' }
  }

  const active = state.projects.find((project) => project.id === state.activeProjectId)
  if (active && !active.pathMissing) return state

  const fallback =
    state.projects.find((project) => !project.pathMissing) ??
    state.projects.find((project) => project.id === state.activeProjectId) ??
    state.projects[0]
  if (!fallback) {
    return { ...state, activeProjectId: '', activeThreadId: '' }
  }

  const activeThreadStillValid = state.threads.some(
    (thread) => thread.id === state.activeThreadId && thread.projectId === fallback.id && !thread.archivedAt,
  )

  return {
    ...state,
    activeProjectId: fallback.id,
    activeThreadId: activeThreadStillValid ? state.activeThreadId : '',
  }
}

/** 持久化前剥掉仅运行期存在的字段（如 `pathMissing`）/ Strip runtime-only fields before serializing workspace state */
export function stripRuntimeProjectFields(state: ChatWorkspaceState): ChatWorkspaceState {
  return {
    ...state,
    projects: state.projects.map(({ pathMissing: _pathMissing, ...project }) => project),
  }
}
