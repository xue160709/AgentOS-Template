import type { WorkspaceProject } from './types'

/**
 * Sidebar project order:
 * - default is pin rank, then creation time descending;
 * - once a manual order exists, it becomes the stable visual order.
 */
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

export function projectIdsForSidebar(
  projects: readonly WorkspaceProject[],
  projectOrderIds: readonly string[] = [],
): string[] {
  return sortProjectsForSidebar(projects, projectOrderIds).map((project) => project.id)
}
