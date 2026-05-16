/**
 * 项目文件树侧栏（Electron `listProjectFiles`）。
 * Collapsible project tree backed by desktop file listing IPC.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { FileTreeNode, FileTreeResult, WorkspaceProject } from './types'

/** `AppFileTreePane` 暴露的命令式接口 / Imperative API for parent drawers */
export type AppFileTreePaneHandle = {
  refresh: () => void
}

type AppFileTreePaneProps = {
  project: WorkspaceProject
  /** 侧栏可见性：隐藏时保留展开状态 / Visibility toggle keeps expansion memory */
  isVisible: boolean
}

/** `forwardRef` 文件树面板，暴露 `refresh()` / File tree pane exposing imperative refresh */
export const AppFileTreePane = forwardRef<AppFileTreePaneHandle, AppFileTreePaneProps>(function AppFileTreePane(
  { project, isVisible },
  ref,
) {
  const { t } = useI18n()
  const [result, setResult] = useState<FileTreeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const loadRequestRef = useRef(0)
  const lastLoadedPathRef = useRef<string | null>(null)

  useEffect(() => {
    setResult(null)
    setExpandedPaths(new Set())
    lastLoadedPathRef.current = null
  }, [project.path])

  const loadProjectFiles = useCallback(async () => {
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    setLoading(true)

    const listProjectFiles = window.desktop?.listProjectFiles
    if (!listProjectFiles) {
      setResult({
        ok: false,
        rootPath: project.path,
        message: t('filePanel.unsupported'),
      })
      setLoading(false)
      return
    }

    try {
      const nextResult = await listProjectFiles(project.path)
      if (loadRequestRef.current !== requestId) return
      setResult(nextResult)
      setExpandedPaths(new Set())
    } catch (error) {
      if (loadRequestRef.current !== requestId) return
      setResult({
        ok: false,
        rootPath: project.path,
        message: error instanceof Error ? error.message : t('filePanel.loadFailed'),
      })
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
        lastLoadedPathRef.current = project.path
      }
    }
  }, [project.path, t])

  useEffect(() => {
    if (!isVisible) return
    if (lastLoadedPathRef.current === project.path) return
    void loadProjectFiles()
  }, [isVisible, project.path, loadProjectFiles])

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => {
        void loadProjectFiles()
      },
    }),
    [loadProjectFiles],
  )

  const summary = useMemo(() => (result?.ok ? countTreeNodes(result.nodes) : null), [result])

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  return (
    <div className="app-file-tree-pane">
      <div className="app-file-panel-project">
        <span className="app-file-panel-project-name" title={result?.rootPath ?? project.path}>
          {result?.ok ? result.rootName : project.name}
        </span>
        {summary ? (
          <span className="app-file-panel-count">
            {t('filePanel.countSummary', { dirs: summary.directories, files: summary.files })}
          </span>
        ) : null}
      </div>

      <div className="app-file-panel-body">
        {loading && !result ? <div className="app-file-panel-state">{t('filePanel.loading')}</div> : null}
        {result && !result.ok ? (
          <div className="app-file-panel-state" role="status">
            {result.message}
          </div>
        ) : null}
        {result?.ok && result.nodes.length === 0 ? <div className="app-file-panel-state">{t('filePanel.empty')}</div> : null}
        {result?.ok && result.nodes.length > 0 ? (
          <>
            <div className="app-file-tree" role="tree" aria-label={t('filePanel.treeAria', { name: result.rootName })}>
              <FileTreeRows nodes={result.nodes} expandedPaths={expandedPaths} onToggle={toggleExpanded} />
            </div>
            {result.truncated ? <div className="app-file-panel-state is-subtle">{t('filePanel.truncated')}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  )
})

type FileTreeRowsProps = {
  nodes: FileTreeNode[]
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  depth?: number
}

function FileTreeRows({ nodes, expandedPaths, onToggle, depth = 0 }: FileTreeRowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.type === 'directory'
        const isExpanded = isDirectory && expandedPaths.has(node.path)
        const style = { '--file-depth': depth } as CSSProperties

        return (
          <div key={node.path} className="app-file-tree-item" role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
            {isDirectory ? (
              <button
                type="button"
                className={`app-file-tree-row is-directory${isExpanded ? ' is-expanded' : ''}`}
                style={style}
                title={node.relativePath}
                onClick={() => onToggle(node.path)}
              >
                <span className="app-file-tree-chevron">
                  <IconInline name="chevron" />
                </span>
                <IconInline name="folder" />
                <span className="app-file-tree-name">{node.name}</span>
              </button>
            ) : (
              <div className="app-file-tree-row is-file" style={style} title={node.relativePath}>
                <span className="app-file-tree-spacer" />
                <IconInline name="file" />
                <span className="app-file-tree-name">{node.name}</span>
              </div>
            )}
            {isDirectory && isExpanded && node.children && node.children.length > 0 ? (
              <div role="group">
                <FileTreeRows nodes={node.children} expandedPaths={expandedPaths} onToggle={onToggle} depth={depth + 1} />
              </div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

function countTreeNodes(nodes: FileTreeNode[]) {
  let directories = 0
  let files = 0

  const walk = (items: FileTreeNode[]) => {
    for (const item of items) {
      if (item.type === 'directory') {
        directories += 1
        if (item.children) walk(item.children)
      } else {
        files += 1
      }
    }
  }

  walk(nodes)
  return { directories, files }
}
