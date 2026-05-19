/**
 * 侧栏项目排序：默认按置顶与时间；若存在手工顺序则优先沿用。
 * Sidebar project order: pinned-first + recency by default; manual `projectOrderIds` wins when present.
 */

import type { WorkspaceProject } from './types'

/** 按侧栏规则排序后的项目列表 / Projects sorted for the sidebar list */
export function sortProjectsForSidebar(
  projects: readonly WorkspaceProject[],
  projectOrderIds: readonly string[] = [],
): WorkspaceProject[] {
  const orderIndex = new Map(projectOrderIds.map((id, index) => [id, index]))

  return [...projects].sort((a, b) => {
    if (orderIndex.size > 0) {
      const ai = orderIndex.get(a.id)
      const bi = orderIndex.get(b.id)
      if (ai != null && bi != null) return ai - bi
      if (ai != null) return -1
      if (bi != null) return 1
    }

    const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    return pinDiff || b.createdAt - a.createdAt
  })
}

/** 与 `sortProjectsForSidebar` 一致的 id 序列（用于持久化顺序等）/ Stable id list matching sidebar sort */
export function projectIdsForSidebar(
  projects: readonly WorkspaceProject[],
  projectOrderIds: readonly string[] = [],
): string[] {
  return sortProjectsForSidebar(projects, projectOrderIds).map((project) => project.id)
}
