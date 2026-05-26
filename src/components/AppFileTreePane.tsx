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
  activeFilePath?: string | null
  onOpenFile?: (node: FileTreeNode) => void
}

/** `forwardRef` 文件树面板，暴露 `refresh()` / File tree pane exposing imperative refresh */
export const AppFileTreePane = forwardRef<AppFileTreePaneHandle, AppFileTreePaneProps>(function AppFileTreePane(
  { project, isVisible, activeFilePath = null, onOpenFile },
  ref,
) {
  const { t } = useI18n()
  const [result, setResult] = useState<FileTreeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const loadRequestRef = useRef(0)
  const lastLoadedPathRef = useRef<string | null>(null)
  const watchedRootPathRef = useRef<string | null>(null)
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setResult(null)
    setExpandedPaths(new Set())
    lastLoadedPathRef.current = null
  }, [project.path])

  const loadProjectFiles = useCallback(async (options?: { showLoading?: boolean }) => {
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    const showLoading = options?.showLoading !== false
    if (showLoading) setLoading(true)

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

  useEffect(() => {
    if (!isVisible) return
    const watchProjectFiles = window.desktop?.watchProjectFiles
    const unwatchProjectFiles = window.desktop?.unwatchProjectFiles
    const onProjectFilesChanged = window.desktop?.onProjectFilesChanged
    if (!watchProjectFiles || !unwatchProjectFiles || !onProjectFilesChanged) return

    let disposed = false
    const scheduleSilentRefresh = () => {
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current)
      autoRefreshTimerRef.current = setTimeout(() => {
        autoRefreshTimerRef.current = null
        void loadProjectFiles({ showLoading: false })
      }, 250)
    }

    const unsubscribe = onProjectFilesChanged((event) => {
      const watchedRootPath = watchedRootPathRef.current
      if (event.rootPath !== project.path && event.rootPath !== watchedRootPath) return
      scheduleSilentRefresh()
    })

    void watchProjectFiles(project.path).then((watchResult) => {
      if (disposed) {
        if (watchResult.ok) void unwatchProjectFiles(watchResult.rootPath)
        return
      }
      watchedRootPathRef.current = watchResult.ok ? watchResult.rootPath : null
    })

    return () => {
      disposed = true
      unsubscribe()
      if (autoRefreshTimerRef.current) {
        clearTimeout(autoRefreshTimerRef.current)
        autoRefreshTimerRef.current = null
      }
      const watchedRootPath = watchedRootPathRef.current
      watchedRootPathRef.current = null
      void unwatchProjectFiles(watchedRootPath ?? project.path)
    }
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
              <FileTreeRows
                nodes={result.nodes}
                expandedPaths={expandedPaths}
                activeFilePath={activeFilePath}
                onToggle={toggleExpanded}
                onOpenFile={onOpenFile}
                openFileLabel={(name) => t('filePanel.openFileAria', { name })}
              />
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
  activeFilePath: string | null
  onToggle: (path: string) => void
  onOpenFile?: (node: FileTreeNode) => void
  openFileLabel: (name: string) => string
  depth?: number
}

function FileTreeRows({ nodes, expandedPaths, activeFilePath, onToggle, onOpenFile, openFileLabel, depth = 0 }: FileTreeRowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.type === 'directory'
        const isExpanded = isDirectory && expandedPaths.has(node.path)
        const isActiveFile = !isDirectory && activeFilePath === node.path
        const style = { '--file-depth': depth } as CSSProperties

        return (
          <div
            key={node.path}
            className="app-file-tree-item"
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
            aria-selected={isActiveFile || undefined}
          >
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
              <button
                type="button"
                className={`app-file-tree-row is-file${isActiveFile ? ' is-selected' : ''}`}
                style={style}
                title={node.relativePath}
                aria-label={openFileLabel(node.name)}
                onClick={() => onOpenFile?.(node)}
              >
                <span className="app-file-tree-spacer" />
                <IconInline name={isImagePreviewFile(node.name) ? 'image' : 'file'} />
                <span className="app-file-tree-name">{node.name}</span>
              </button>
            )}
            {isDirectory && isExpanded && node.children && node.children.length > 0 ? (
              <div role="group">
                <FileTreeRows
                  nodes={node.children}
                  expandedPaths={expandedPaths}
                  activeFilePath={activeFilePath}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  openFileLabel={openFileLabel}
                  depth={depth + 1}
                />
              </div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

function isImagePreviewFile(name: string): boolean {
  return /\.(gif|jpe?g|png|webp)$/i.test(name)
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
