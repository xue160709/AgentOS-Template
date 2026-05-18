/**
 * Agent Mode card home surface rendered from per-card Home Plugins.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from 'react'
import { A2uiSurface, basicCatalog, MarkdownContext, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import { MessageProcessor, type A2uiClientAction, type A2uiMessage, type SurfaceModel } from '@a2ui/web_core/v0_9'
import type { HomePluginCardSize, HomePluginRunItem } from '../../desktop-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { WorkspaceProject } from '../types'
import { renderMarkdown } from './markdown'

type ProjectHomeSurfaceProps = {
  project: WorkspaceProject
  todoEnabled: boolean
  loading: boolean
  onTodoSwitchChange: (checked: boolean) => void
  onStartDataCardDraft: () => void
  onEditHomePluginCard: (item: HomePluginRunItem) => void
}

const pluginCache = new Map<string, { hashes: Record<string, string>; plugins: HomePluginRunItem[] }>()

/** Runs all card Home Plugins and renders the Agent Mode card grid. */
export function ProjectHomeSurface({
  project,
  todoEnabled,
  loading,
  onTodoSwitchChange,
  onStartDataCardDraft,
  onEditHomePluginCard,
}: ProjectHomeSurfaceProps) {
  const { t } = useI18n()
  const cacheKey = project.path
  const outputHashesRef = useRef<Record<string, string>>(pluginCache.get(cacheKey)?.hashes ?? {})
  const [plugins, setPlugins] = useState<HomePluginRunItem[]>(() => pluginCache.get(cacheKey)?.plugins ?? [])
  const [error, setError] = useState('')
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [sortDialogOpen, setSortDialogOpen] = useState(false)
  const [draftOrder, setDraftOrder] = useState<string[]>([])
  const addMenuRef = useRef<HTMLDivElement>(null)

  const loadHomePlugins = useCallback(async () => {
    const runHomePlugin = window.desktop?.runHomePlugin
    if (!runHomePlugin) return
    try {
      const result = await runHomePlugin(project.path, { knownOutputHashes: outputHashesRef.current })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError('')
      const cached = pluginCache.get(cacheKey)?.plugins ?? []
      const cachedBySlug = new Map(cached.map((item) => [item.slug, item]))
      const nextPlugins = (result.plugins ?? []).map((item) => {
        if (item.status !== 'unchanged') return item
        const cachedItem = cachedBySlug.get(item.slug)
        return {
          ...item,
          messages: cachedItem?.messages,
          variants: cachedItem?.variants,
        } as HomePluginRunItem
      })
      const hashes: Record<string, string> = {}
      for (const item of nextPlugins) {
        if (item.outputHash) hashes[item.slug] = item.outputHash
      }
      outputHashesRef.current = hashes
      pluginCache.set(cacheKey, { hashes, plugins: nextPlugins })
      setPlugins(nextPlugins)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [cacheKey, project.path])

  useEffect(() => {
    outputHashesRef.current = pluginCache.get(cacheKey)?.hashes ?? {}
    setPlugins(pluginCache.get(cacheKey)?.plugins ?? [])
    setError('')
    void loadHomePlugins()
  }, [cacheKey, loadHomePlugins])

  useEffect(() => {
    const onRefresh = () => void loadHomePlugins()
    window.addEventListener('project-home:refresh', onRefresh)
    return () => window.removeEventListener('project-home:refresh', onRefresh)
  }, [loadHomePlugins])

  useEffect(() => {
    if (!addMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && addMenuRef.current?.contains(target)) return
      setAddMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [addMenuOpen])

  useEffect(() => {
    if (sortDialogOpen) setDraftOrder(plugins.map((item) => item.slug))
  }, [plugins, sortDialogOpen])

  const visiblePlugins = plugins.filter((item) => item.status !== 'empty' && hasRenderableMessages(item))

  const saveSortOrder = async () => {
    const saveHomePluginOrder = window.desktop?.saveHomePluginOrder
    if (!saveHomePluginOrder) return
    const result = await saveHomePluginOrder(project.path, draftOrder)
    if (result.ok) {
      setSortDialogOpen(false)
      outputHashesRef.current = {}
      window.dispatchEvent(new CustomEvent('project-home:refresh'))
    } else {
      setError(result.message)
    }
  }

  return (
    <div className="project-home-area">
      <div className="project-home-toolbar">
        <div className="chat-start-view__project" title={project.path}>
          <IconInline name="folder" />
          <span>{project.name}</span>
        </div>
        <div className="project-home-toolbar__actions">
          <button
            type="button"
            className="project-home-icon-button"
            title={t('workspace.sortAgentCards')}
            aria-label={t('workspace.sortAgentCards')}
            disabled={loading || visiblePlugins.length === 0}
            onClick={() => setSortDialogOpen(true)}
          >
            <IconInline name="sort" />
          </button>
          <div className="project-home-add" ref={addMenuRef}>
            <button
              type="button"
              className="project-home-add-button"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              disabled={loading}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <IconInline name="plus" />
              <span>{t('workspace.addAgentCard')}</span>
            </button>
            {addMenuOpen ? (
              <div className="project-home-add-menu" role="menu" aria-label={t('workspace.addAgentCard')}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false)
                    onStartDataCardDraft()
                  }}
                >
                  <IconInline name="database" />
                  <span>{t('workspace.addDataCard')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false)
                    setTaskDialogOpen(true)
                  }}
                >
                  <IconInline name="checklist" />
                  <span>{t('workspace.addTaskCard')}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="project-home-surface-error">{error}</div> : null}
      {!error && visiblePlugins.length === 0 ? <ProjectHomeEmptyState /> : null}
      {!error && visiblePlugins.length > 0 ? (
        <div className="project-home-card-grid">
          {visiblePlugins.map((item) => (
            <HomePluginCard
              key={`${item.slug}:${item.outputHash ?? ''}`}
              item={item}
              projectPath={project.path}
              onEdit={() => onEditHomePluginCard(item)}
            />
          ))}
        </div>
      ) : null}

      {taskDialogOpen ? (
        <TaskCardDialog
          todoEnabled={todoEnabled}
          loading={loading}
          onTodoSwitchChange={onTodoSwitchChange}
          onClose={() => setTaskDialogOpen(false)}
        />
      ) : null}
      {sortDialogOpen ? (
        <SortCardsDialog
          plugins={visiblePlugins}
          draftOrder={draftOrder}
          onDraftOrderChange={setDraftOrder}
          onClose={() => setSortDialogOpen(false)}
          onSave={() => void saveSortOrder()}
        />
      ) : null}
    </div>
  )
}

function HomePluginCard({
  item,
  projectPath,
  onEdit,
}: {
  item: HomePluginRunItem
  projectPath: string
  onEdit: () => void
}) {
  const { t } = useI18n()
  const size = item.manifest.preferredSize
  const messages = messagesForSize(item, size)
  const [menuOpen, setMenuOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useMasonrySpan(cardRef, [messages, size])

  return (
    <div
      ref={cardRef}
      className={`project-home-card project-home-card--${size}`}
      style={{ '--home-card-span': sizeToColumnSpan(size) } as CSSProperties}
    >
      <div className="project-home-card__menu">
        <button
          type="button"
          className="project-home-card__menu-button"
          aria-label={t('workspace.cardMenuAria', { name: item.manifest.name })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <IconInline name="moreHorizontal" />
        </button>
        {menuOpen ? (
          <div className="project-home-card__menu-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onEdit()
              }}
            >
              <IconInline name="edit" />
              <span>{t('workspace.editAgentCard')}</span>
            </button>
          </div>
        ) : null}
      </div>
      <MarkdownContext.Provider value={(text) => Promise.resolve(renderMarkdown(text))}>
        <A2uiCardSurface messages={messages} projectPath={projectPath} onEdit={onEdit} />
      </MarkdownContext.Provider>
    </div>
  )
}

function A2uiCardSurface({
  messages,
  projectPath,
  onEdit,
}: {
  messages: A2uiMessage[]
  projectPath: string
  onEdit: () => void
}) {
  const surfacesRef = useRef<SurfaceModel<ReactComponentImplementation>[]>([])
  const [surfaces, setSurfaces] = useState<SurfaceModel<ReactComponentImplementation>[]>([])
  const [revision, setRevision] = useState(0)

  const handleAction = useCallback(
    (action: A2uiClientAction) => {
      if (action.name === 'customize_home' || action.name === 'edit_home_card') {
        onEdit()
        return
      }
      if (action.name === 'refresh_home') {
        window.dispatchEvent(new CustomEvent('project-home:refresh'))
        return
      }
      if (action.name === 'open_file') {
        const rawPath = resolveActionPath(action.context?.filePath ?? action.context?.path)
        const safePath = rawPath ? normalizeProjectRelativePath(rawPath) : ''
        if (!safePath) return
        const targetPath = `${projectPath}/${safePath}`
        if (window.desktop?.openPath) {
          void window.desktop.openPath(targetPath).catch(() => window.desktop?.showItemInFolder?.(targetPath))
        } else {
          void window.desktop?.showItemInFolder?.(targetPath)
        }
      }
    },
    [onEdit, projectPath],
  )

  const processor = useMemo(() => new MessageProcessor<ReactComponentImplementation>([basicCatalog], handleAction), [handleAction])

  useEffect(() => {
    try {
      Array.from(processor.model.surfacesMap.keys()).forEach((id) => processor.model.deleteSurface(id))
      processor.processMessages(messages)
      const next = Array.from(processor.model.surfacesMap.values())
      surfacesRef.current = next
      setSurfaces(next)
      setRevision((value) => value + 1)
    } catch (error) {
      console.error(error)
      setSurfaces([])
    }
  }, [messages, processor])

  useEffect(() => () => processor.model.dispose(), [processor])

  return (
    <div className="project-home-surface">
      {surfaces.map((surface) => (
        <A2uiSurface key={`${surface.id}:${revision}`} surface={surface} />
      ))}
    </div>
  )
}

function ProjectHomeEmptyState() {
  const { t } = useI18n()
  return (
    <div className="project-home-empty">
      <IconInline name="database" />
      <span>{t('workspace.agentCardsEmptyTitle')}</span>
      <span>{t('workspace.agentCardsEmptyDesc')}</span>
    </div>
  )
}

function TaskCardDialog({
  todoEnabled,
  loading,
  onTodoSwitchChange,
  onClose,
}: {
  todoEnabled: boolean
  loading: boolean
  onTodoSwitchChange: (checked: boolean) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="project-home-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="project-home-modal" role="dialog" aria-modal="true" aria-label={t('workspace.addTaskCard')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="project-home-modal__header">
          <h2>{t('workspace.addTaskCard')}</h2>
          <button type="button" className="project-home-icon-button" aria-label={t('filePanel.closeAria')} onClick={onClose}>
            <IconInline name="x" />
          </button>
        </div>
        <label className="agent-mode-switch project-home-task-switch">
          <span className="agent-mode-switch__copy">
            <span>{t('workspace.todoModeToggle')}</span>
            <span>{t('workspace.todoModeToggleDesc')}</span>
          </span>
          <span className="settings-switch-control">
            <input
              className="settings-switch-input"
              type="checkbox"
              checked={todoEnabled}
              disabled={loading}
              onChange={(event) => onTodoSwitchChange(event.target.checked)}
            />
            <span className="settings-switch-track" aria-hidden="true">
              <span className="settings-switch-thumb" />
            </span>
          </span>
        </label>
        <div className="project-home-task-placeholder">
          <IconInline name="checklist" />
          <span>{t('workspace.taskCardReservedTitle')}</span>
          <span>{t('workspace.taskCardReservedDesc')}</span>
        </div>
      </div>
    </div>
  )
}

function SortCardsDialog({
  plugins,
  draftOrder,
  onDraftOrderChange,
  onClose,
  onSave,
}: {
  plugins: HomePluginRunItem[]
  draftOrder: string[]
  onDraftOrderChange: (order: string[]) => void
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useI18n()
  const bySlug = new Map(plugins.map((item) => [item.slug, item]))
  const ordered = draftOrder.map((slug) => bySlug.get(slug)).filter((item): item is HomePluginRunItem => Boolean(item))
  const move = (slug: string, offset: number) => {
    const index = draftOrder.indexOf(slug)
    const nextIndex = index + offset
    if (index < 0 || nextIndex < 0 || nextIndex >= draftOrder.length) return
    const next = [...draftOrder]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    onDraftOrderChange(next)
  }

  const onDragStart = (event: DragEvent<HTMLDivElement>, slug: string) => {
    event.dataTransfer.setData('text/plain', slug)
    event.dataTransfer.effectAllowed = 'move'
  }
  const onDrop = (event: DragEvent<HTMLDivElement>, targetSlug: string) => {
    event.preventDefault()
    const sourceSlug = event.dataTransfer.getData('text/plain')
    if (!sourceSlug || sourceSlug === targetSlug) return
    const sourceIndex = draftOrder.indexOf(sourceSlug)
    const targetIndex = draftOrder.indexOf(targetSlug)
    if (sourceIndex < 0 || targetIndex < 0) return
    const next = [...draftOrder]
    const [item] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, item)
    onDraftOrderChange(next)
  }

  return (
    <div className="project-home-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="project-home-modal project-home-modal--sort" role="dialog" aria-modal="true" aria-label={t('workspace.sortAgentCards')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="project-home-modal__header">
          <h2>{t('workspace.sortAgentCards')}</h2>
          <button type="button" className="project-home-icon-button" aria-label={t('filePanel.closeAria')} onClick={onClose}>
            <IconInline name="x" />
          </button>
        </div>
        <div className="project-home-sort-list" role="list">
          {ordered.map((item, index) => (
            <div
              key={item.slug}
              className="project-home-sort-row"
              role="listitem"
              draggable
              onDragStart={(event) => onDragStart(event, item.slug)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, item.slug)}
            >
              <span className="project-home-sort-row__grab" aria-hidden="true">
                <IconInline name="sort" />
              </span>
              <span className="project-home-sort-row__copy">
                <span>{item.manifest.name}</span>
                <span>{item.slug}</span>
              </span>
              <span className="project-home-size-badge">{t(`workspace.cardSize.${item.manifest.preferredSize}`)}</span>
              <span className="project-home-kind-badge">{item.manifest.kind === 'task' ? t('workspace.addTaskCard') : t('workspace.addDataCard')}</span>
              <button type="button" className="project-home-icon-button" disabled={index === 0} onClick={() => move(item.slug, -1)} aria-label={t('workspace.moveCardUp')}>
                <IconInline name="arrowUp" />
              </button>
              <button type="button" className="project-home-icon-button" disabled={index === ordered.length - 1} onClick={() => move(item.slug, 1)} aria-label={t('workspace.moveCardDown')}>
                <IconInline name="arrowDown" />
              </button>
            </div>
          ))}
        </div>
        <div className="project-home-modal__footer">
          <button type="button" className="agent-card-secondary-button" onClick={onClose}>
            {t('settings.agentMode.cancel')}
          </button>
          <button type="button" className="agent-card-primary-button" onClick={onSave}>
            {t('settings.agentMode.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

function useMasonrySpan(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const sync = () => {
      const rowHeight = 8
      const gap = 12
      const span = Math.max(1, Math.ceil((element.getBoundingClientRect().height + gap) / rowHeight))
      element.style.gridRowEnd = `span ${span}`
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function messagesForSize(item: HomePluginRunItem, size: HomePluginCardSize): A2uiMessage[] {
  return ((item.variants?.[size] ?? item.variants?.medium ?? item.variants?.large ?? item.variants?.small ?? item.messages ?? []) as A2uiMessage[])
}

function hasRenderableMessages(item: HomePluginRunItem): boolean {
  return messagesForSize(item, item.manifest.preferredSize).length > 0
}

function sizeToColumnSpan(size: HomePluginCardSize): number {
  if (size === 'large') return 3
  if (size === 'medium') return 2
  return 1
}

function resolveActionPath(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  return resolveActionPath(value.path)
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) return ''
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
