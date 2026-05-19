/**
 * 项目路径相关的纯字符串逻辑（渲染进程与主进程均可引用）。
 * Path-related string helpers safe for renderer and main process.
 */

import type { ChatWorkspaceState, WorkspaceProject } from './components/types'

export const LEGACY_SEED_PROJECT_ID = 'project-codex-ui-template'

export function isLegacySeedProject(project: Pick<WorkspaceProject, 'id' | 'path'>): boolean {
  if (project.id === LEGACY_SEED_PROJECT_ID) return true
  const normalized = project.path.replace(/\\/g, '/').toLowerCase()
  return normalized.includes('codex-ui-template')
}

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

export function stripRuntimeProjectFields(state: ChatWorkspaceState): ChatWorkspaceState {
  return {
    ...state,
    projects: state.projects.map(({ pathMissing: _pathMissing, ...project }) => project),
  }
}
