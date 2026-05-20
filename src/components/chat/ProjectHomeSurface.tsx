/**
 * Agent Mode card home surface rendered from per-card Home Plugins.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from 'react'
import { A2uiSurface, basicCatalog, MarkdownContext, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import { MessageProcessor, type A2uiClientAction, type A2uiMessage, type SurfaceModel } from '@a2ui/web_core/v0_9'
import type { AgentContextSlashItem } from '../../claude-chat-types'
import type {
  HomePluginCardSize,
  HomePluginRunItem,
  HomePluginTaskMode,
  HomePluginTaskSchedule,
  HomePluginTaskSkillStep,
} from '../../desktop-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { WorkspaceProject } from '../types'
import { renderMarkdown } from './markdown'

type ProjectHomeSurfaceProps = {
  project: WorkspaceProject
  todoEnabled: boolean
  loading: boolean
  onStartDataCardDraft: () => void
  onEditHomePluginCard: (item: HomePluginRunItem) => void
}

const pluginCache = new Map<string, { hashes: Record<string, string>; plugins: HomePluginRunItem[] }>()
const HOME_GRID_COLUMNS = 3

type HomeGridItem =
  | { kind: 'plugin'; item: HomePluginRunItem }
  | { kind: 'filler'; id: string; span: 1 | 2; tone: 'grid' | 'signal' | 'trace' }
type HomeGridFillerItem = Extract<HomeGridItem, { kind: 'filler' }>

/** Runs all card Home Plugins and renders the Agent Mode card grid. */
export function ProjectHomeSurface({
  project,
  todoEnabled,
  loading,
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
  const [editingTaskSlug, setEditingTaskSlug] = useState<string | undefined>()
  const [sortDialogOpen, setSortDialogOpen] = useState(false)
  const [draftOrder, setDraftOrder] = useState<string[]>([])
  const [draftSizes, setDraftSizes] = useState<Record<string, HomePluginCardSize>>({})
  const [deletingSlug, setDeletingSlug] = useState('')
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
    const subscribe = window.desktop?.onHomePluginTaskEvent
    if (!subscribe) return
    let refreshTimer: number | null = null
    const scheduleRefresh = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        outputHashesRef.current = {}
        void loadHomePlugins()
      }, 80)
    }
    const unsubscribe = subscribe((event) => {
      if (!sameProjectPath(event.projectPath, project.path)) return
      scheduleRefresh()
    })
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [loadHomePlugins, project.path])

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
    if (!sortDialogOpen) return
    setDraftOrder(plugins.map((item) => item.slug))
    setDraftSizes(Object.fromEntries(plugins.map((item) => [item.slug, item.manifest.preferredSize])))
  }, [plugins, sortDialogOpen])

  const visiblePlugins = plugins.filter((item) => item.status !== 'empty' && hasRenderableMessages(item))
  const gridItems = useMemo(() => buildHomeGridItems(visiblePlugins), [visiblePlugins])

  const saveSortOrder = async () => {
    const layoutCards = Object.entries(draftSizes).map(([slug, preferredSize]) => ({ slug, preferredSize }))
    const result = window.desktop?.saveHomePluginLayout
      ? await window.desktop.saveHomePluginLayout(project.path, draftOrder, layoutCards)
      : window.desktop?.saveHomePluginOrder
        ? await window.desktop.saveHomePluginOrder(project.path, draftOrder)
        : null
    if (!result) return
    if (result.ok) {
      setSortDialogOpen(false)
      outputHashesRef.current = {}
      window.dispatchEvent(new CustomEvent('project-home:refresh'))
    } else {
      setError(result.message)
    }
  }

  const deleteCard = async (item: HomePluginRunItem) => {
    const deleteHomePlugin = window.desktop?.deleteHomePlugin
    if (!deleteHomePlugin) {
      setError(t('workspace.deleteAgentCardUnavailable'))
      return
    }
    if (deletingSlug) return
    const pluginPath = `${project.path}/.agents/home-plugins/${item.slug}`
    const confirmed = window.confirm(t('workspace.deleteAgentCardConfirm', { name: item.manifest.name, path: pluginPath }))
    if (!confirmed) return

    setDeletingSlug(item.slug)
    try {
      const result = await deleteHomePlugin(project.path, item.slug)
      if (!result.ok) {
        setError(result.message)
        return
      }
      const nextPlugins = plugins.filter((plugin) => plugin.slug !== item.slug)
      const nextHashes: Record<string, string> = {}
      for (const plugin of nextPlugins) {
        if (plugin.outputHash) nextHashes[plugin.slug] = plugin.outputHash
      }
      outputHashesRef.current = nextHashes
      pluginCache.set(cacheKey, { hashes: nextHashes, plugins: nextPlugins })
      setPlugins(nextPlugins)
      setDraftOrder((current) => current.filter((slug) => slug !== item.slug))
      setDraftSizes((current) => {
        const next = { ...current }
        delete next[item.slug]
        return next
      })
      window.dispatchEvent(new CustomEvent('project-home:refresh'))
    } catch (error) {
      setError(error instanceof Error ? error.message : t('workspace.deleteAgentCardFailed'))
    } finally {
      setDeletingSlug('')
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
                    setEditingTaskSlug(undefined)
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
          {gridItems.map((gridItem) =>
            gridItem.kind === 'filler' ? (
              <HomeGridFiller key={gridItem.id} span={gridItem.span} tone={gridItem.tone} />
            ) : (
              <HomePluginCard
                key={`${gridItem.item.slug}:${gridItem.item.outputHash ?? ''}`}
                item={gridItem.item}
                projectPath={project.path}
                onEdit={() => {
                  if (gridItem.item.manifest.kind === 'task') {
                    setEditingTaskSlug(gridItem.item.slug)
                    setTaskDialogOpen(true)
                    return
                  }
                  onEditHomePluginCard(gridItem.item)
                }}
              />
            ),
          )}
        </div>
      ) : null}

      {taskDialogOpen ? (
        <TaskCardDialog
          project={project}
          slug={editingTaskSlug}
          todoEnabled={todoEnabled}
          loading={loading}
          onClose={() => {
            setTaskDialogOpen(false)
            setEditingTaskSlug(undefined)
          }}
          onSaved={() => {
            setTaskDialogOpen(false)
            setEditingTaskSlug(undefined)
            outputHashesRef.current = {}
            window.dispatchEvent(new CustomEvent('project-home:refresh'))
          }}
        />
      ) : null}
      {sortDialogOpen ? (
        <SortCardsDialog
          plugins={visiblePlugins}
          draftOrder={draftOrder}
          draftSizes={draftSizes}
          onDraftOrderChange={setDraftOrder}
          onDraftSizeChange={(slug, preferredSize) => setDraftSizes((prev) => ({ ...prev, [slug]: preferredSize }))}
          deletingSlug={deletingSlug}
          onDelete={(item) => void deleteCard(item)}
          onClose={() => setSortDialogOpen(false)}
          onSave={() => void saveSortOrder()}
        />
      ) : null}
    </div>
  )
}

function HomeGridFiller({ span, tone }: Pick<HomeGridFillerItem, 'span' | 'tone'>) {
  const rowSpan = span === 1 ? 7 : 9
  return (
    <div
      className={`project-home-filler-card project-home-filler-card--span-${span} project-home-filler-card--${tone}`}
      aria-hidden="true"
      role="presentation"
      style={{ '--home-card-span': span, gridRowEnd: `span ${rowSpan}` } as CSSProperties}
    >
      <div className="project-home-filler-card__rule" />
      <div className="project-home-filler-card__marks">
        {Array.from({ length: span === 1 ? 7 : 12 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
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
  const taskCard = item.manifest.kind === 'task' ? taskCardViewModelFromMessages(item, messages) : null
  const [menuOpen, setMenuOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useMasonrySpan(cardRef, [messages, size])

  return (
    <div
      ref={cardRef}
      className={`project-home-card project-home-card--${size} project-home-card--${item.manifest.kind}`}
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
      <div className="project-home-card__measure">
        <div className="project-home-card__surface">
          {taskCard ? (
            <TaskHomeCardView task={taskCard} projectPath={projectPath} />
          ) : (
            <MarkdownContext.Provider value={(text) => Promise.resolve(renderMarkdown(text))}>
              <A2uiCardSurface messages={messages} projectPath={projectPath} onEdit={onEdit} />
            </MarkdownContext.Provider>
          )}
        </div>
      </div>
    </div>
  )
}

type TaskHomeCardTone = 'idle' | 'active' | 'done' | 'error' | 'cancelled'

type TaskHomeCardViewModel = {
  slug: string
  title: string
  modeLabel: string
  statusLabel: string
  statusTone: TaskHomeCardTone
  summary: string
  detail: string
  meta: string[]
  threadTitle: string
  active: boolean
}

function TaskHomeCardView({ task, projectPath }: { task: TaskHomeCardViewModel; projectPath: string }) {
  const [busy, setBusy] = useState(false)
  const iconName = task.active ? 'stop' : 'play'
  const actionLabel = task.active ? '终止' : '执行'

  const runAction = useCallback(async () => {
    if (busy) return
    const action = task.active ? window.desktop?.stopTaskHomePlugin : window.desktop?.runTaskHomePlugin
    if (!action) return
    setBusy(true)
    try {
      await action(projectPath, task.slug)
    } finally {
      setBusy(false)
      window.dispatchEvent(new CustomEvent('project-home:refresh'))
    }
  }, [busy, projectPath, task.active, task.slug])

  return (
    <article className="task-home-card" aria-label={task.title}>
      <header className="task-home-card__header">
        <span className="task-home-card__glyph" aria-hidden="true">
          <IconInline name="checklist" />
        </span>
        <span className="task-home-card__heading">
          <h3>{task.title}</h3>
          {task.modeLabel ? <span>{task.modeLabel}</span> : null}
        </span>
        {/* {task.statusTone !== 'idle' ? <span className={`task-home-card__status task-home-card__status--${task.statusTone}`}>{task.statusLabel}</span> : null} */}
      </header>

      <div className="task-home-card__body">
        <p className="task-home-card__summary">{task.summary}</p>
        {task.detail ? <p className="task-home-card__detail">{task.detail}</p> : null}
      </div>

      {task.meta.length > 0 || task.threadTitle ? (
        <div className="task-home-card__meta">
          {task.meta.map((label) => (
            <span key={label}>{label}</span>
          ))}
          {task.threadTitle ? (
            <span>
              <IconInline name="branch" />
              {task.threadTitle}
            </span>
          ) : null}
        </div>
      ) : null}

      <footer className="task-home-card__footer">
        <button type="button" className={`task-home-card__action${task.active ? ' task-home-card__action--stop' : ''}`} disabled={busy} onClick={() => void runAction()}>
          <IconInline name={iconName} />
          <span>{busy ? '处理中' : actionLabel}</span>
        </button>
      </footer>
    </article>
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
      if (action.name === 'task_run') {
        const slug = resolveActionText(action.context?.slug)
        if (!slug) return
        const runTaskHomePlugin = window.desktop?.runTaskHomePlugin
        if (!runTaskHomePlugin) return
        void runTaskHomePlugin(projectPath, slug).finally(() => {
          window.dispatchEvent(new CustomEvent('project-home:refresh'))
        })
        return
      }
      if (action.name === 'task_stop') {
        const slug = resolveActionText(action.context?.slug)
        if (!slug) return
        const stopTaskHomePlugin = window.desktop?.stopTaskHomePlugin
        if (!stopTaskHomePlugin) return
        void stopTaskHomePlugin(projectPath, slug).finally(() => {
          window.dispatchEvent(new CustomEvent('project-home:refresh'))
        })
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
  project,
  slug,
  todoEnabled,
  loading,
  onClose,
  onSaved,
}: {
  project: WorkspaceProject
  slug?: string
  todoEnabled: boolean
  loading: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<HomePluginTaskMode>('agent')
  const [skills, setSkills] = useState<AgentContextSlashItem[]>([])
  const [selectedSkills, setSelectedSkills] = useState<HomePluginTaskSkillStep[]>([])
  const [draftTodoEnabled, setDraftTodoEnabled] = useState(todoEnabled)
  const [runCount, setRunCount] = useState(1)
  const [schedule, setSchedule] = useState<HomePluginTaskSchedule>(() => defaultTaskSchedule())
  const [saving, setSaving] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [draggingStepId, setDraggingStepId] = useState('')
  const editing = Boolean(slug)

  useEffect(() => {
    let cancelled = false
    const listAgentContext = window.desktop?.listAgentContext
    if (!listAgentContext) {
      setSkills([])
      setSkillsLoading(false)
      return () => {
        cancelled = true
      }
    }
    setSkillsLoading(true)
    listAgentContext(project.path)
      .then((result) => {
        if (cancelled) return
        setSkills(result.ok ? result.skills.filter((skill) => skill.kind === 'skill' && skill.scope === 'project') : [])
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.path])

  useEffect(() => {
    if (!slug) {
      setTitle('')
      setMode('agent')
      setSelectedSkills([])
      setDraftTodoEnabled(todoEnabled)
      setRunCount(1)
      setSchedule(defaultTaskSchedule())
      setDialogError('')
      return
    }

    let cancelled = false
    const getTaskHomePlugin = window.desktop?.getTaskHomePlugin
    setDialogError('')
    if (!getTaskHomePlugin) {
      setDialogError(t('workspace.taskBridgeUnavailable'))
      setSaving(false)
      return () => {
        cancelled = true
      }
    }
    setSaving(true)
    getTaskHomePlugin(project.path, slug)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setDialogError(result.message)
          return
        }
        setTitle(result.task.title)
        setMode(result.task.mode)
        setSelectedSkills(result.task.skillSteps)
        setDraftTodoEnabled(result.task.todoEnabled)
        setRunCount(result.task.runCount)
        setSchedule(result.task.schedule)
      })
      .catch((error) => {
        if (!cancelled) setDialogError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setSaving(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.path, slug, todoEnabled, t])

  const addSkill = (skill: AgentContextSlashItem) => {
    setSelectedSkills((prev) => [
      ...prev,
      {
        id: createTaskStepId(),
        command: skill.command,
        path: skill.path,
        title: skill.title || skill.name || skill.command,
        description: skill.description,
        addedAt: new Date().toISOString(),
      },
    ])
  }

  const removeSkillStep = (stepId: string) => {
    setSelectedSkills((prev) => prev.filter((step) => step.id !== stepId))
  }

  const moveSkillStep = (stepId: string, offset: number) => {
    setSelectedSkills((prev) => {
      const index = prev.findIndex((step) => step.id === stepId)
      const nextIndex = index + offset
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev
      const next = [...prev]
      const [step] = next.splice(index, 1)
      next.splice(nextIndex, 0, step)
      return next
    })
  }

  const onStepDrop = (event: DragEvent<HTMLDivElement>, targetStepId: string) => {
    event.preventDefault()
    const sourceStepId = event.dataTransfer.getData('text/plain') || draggingStepId
    if (!sourceStepId || sourceStepId === targetStepId) return
    setSelectedSkills((prev) => {
      const sourceIndex = prev.findIndex((step) => step.id === sourceStepId)
      const targetIndex = prev.findIndex((step) => step.id === targetStepId)
      if (sourceIndex < 0 || targetIndex < 0) return prev
      const next = [...prev]
      const [step] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, step)
      return next
    })
    setDraggingStepId('')
  }

  const updateTime = (value: string) => {
    const [hourRaw, minuteRaw] = value.split(':')
    const hour = clampInt(Number.parseInt(hourRaw ?? '', 10), 0, 23, schedule.hour)
    const minute = clampInt(Number.parseInt(minuteRaw ?? '', 10), 0, 59, schedule.minute)
    setSchedule((prev) => ({ ...prev, hour, minute }))
  }

  const save = async () => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) {
      setDialogError(t('workspace.taskTitleRequired'))
      return
    }
    if (mode === 'skills' && selectedSkills.length === 0) {
      setDialogError(t('workspace.taskSkillRequired'))
      return
    }
    const saveTaskHomePlugin = window.desktop?.saveTaskHomePlugin
    if (!saveTaskHomePlugin) {
      setDialogError(t('workspace.taskBridgeUnavailable'))
      return
    }

    setSaving(true)
    setDialogError('')
    try {
      const result = await saveTaskHomePlugin(project.path, {
        slug,
        title: normalizedTitle,
        mode,
        skillSteps: mode === 'skills' ? selectedSkills : [],
        todoEnabled: draftTodoEnabled,
        runCount: clampInt(runCount, 1, 100, 1),
        schedule,
        enabled: true,
      })
      if (!result.ok) {
        setDialogError(result.message)
        return
      }
      onSaved()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const timeValue = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  const canSave = title.trim().length > 0 && (mode === 'agent' || selectedSkills.length > 0) && !saving

  return (
    <div className="project-home-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="project-home-modal project-home-modal--task" role="dialog" aria-modal="true" aria-label={t('workspace.addTaskCard')} onMouseDown={(event) => event.stopPropagation()}>
        <div className="project-home-modal__header">
          <h2>{editing ? t('workspace.editTaskCard') : t('workspace.addTaskCard')}</h2>
          <button type="button" className="project-home-icon-button" aria-label={t('filePanel.closeAria')} onClick={onClose}>
            <IconInline name="x" />
          </button>
        </div>
        <div className="project-home-task-form">
          <label className="project-home-field">
            <span>{t('workspace.taskTitle')}</span>
            <input
              className="settings-input"
              value={title}
              maxLength={64}
              placeholder={t('workspace.taskTitlePlaceholder')}
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <div className="project-home-segmented" role="group" aria-label={t('workspace.taskMode')}>
            <button
              type="button"
              className={mode === 'agent' ? 'is-active' : ''}
              aria-pressed={mode === 'agent'}
              disabled={saving}
              onClick={() => setMode('agent')}
            >
              <IconInline name="agent" />
              <span>{t('workspace.taskModeAgent')}</span>
            </button>
            <button
              type="button"
              className={mode === 'skills' ? 'is-active' : ''}
              aria-pressed={mode === 'skills'}
              disabled={saving}
              onClick={() => setMode('skills')}
            >
              <IconInline name="checklist" />
              <span>{t('workspace.taskModeSkills')}</span>
            </button>
          </div>

          {mode === 'skills' ? (
            <div className="project-home-skill-picker">
              <div className="project-home-skill-pane">
                <div className="project-home-skill-pane__heading">{t('workspace.taskProjectSkills')}</div>
                <div className="project-home-skill-list">
                  {skillsLoading ? <div className="project-home-skill-empty">{t('sidebar.scanning')}</div> : null}
                  {!skillsLoading && skills.length === 0 ? <div className="project-home-skill-empty">{t('workspace.taskNoSkills')}</div> : null}
                  {skills.map((skill) => (
                    <div key={`${skill.path}:${skill.command}`} className="project-home-skill-row">
                      <span>
                        <span>{skill.title || skill.name}</span>
                        <span>{skill.command}</span>
                      </span>
                      <button type="button" className="project-home-icon-button" title={t('workspace.taskAddSkill')} aria-label={t('workspace.taskAddSkill')} disabled={saving} onClick={() => addSkill(skill)}>
                        <IconInline name="plus" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="project-home-skill-pane">
                <div className="project-home-skill-pane__heading">{t('workspace.taskSelectedSkills')}</div>
                <div className="project-home-selected-skill-list">
                  {selectedSkills.length === 0 ? <div className="project-home-skill-empty">{t('workspace.taskSelectedSkillsEmpty')}</div> : null}
                  {selectedSkills.map((step, index) => (
                    <div
                      key={step.id}
                      className="project-home-selected-skill-row"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', step.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setDraggingStepId(step.id)
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => onStepDrop(event, step.id)}
                      onDragEnd={() => setDraggingStepId('')}
                    >
                      <span className="project-home-sort-row__grab" aria-hidden="true">
                        <IconInline name="sort" />
                      </span>
                      <span className="project-home-step-index">{index + 1}</span>
                      <span className="project-home-selected-skill-row__copy">
                        <span>{step.title}</span>
                        <span>{step.command}</span>
                      </span>
                      <button type="button" className="project-home-icon-button" disabled={saving || index === 0} onClick={() => moveSkillStep(step.id, -1)} aria-label={t('workspace.moveCardUp')}>
                        <IconInline name="arrowUp" />
                      </button>
                      <button type="button" className="project-home-icon-button" disabled={saving || index === selectedSkills.length - 1} onClick={() => moveSkillStep(step.id, 1)} aria-label={t('workspace.moveCardDown')}>
                        <IconInline name="arrowDown" />
                      </button>
                      <button type="button" className="project-home-icon-button" disabled={saving} onClick={() => removeSkillStep(step.id)} aria-label={t('workspace.taskRemoveSkill')}>
                        <IconInline name="x" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <label className="agent-mode-switch project-home-task-switch">
            <span className="agent-mode-switch__copy">
              <span>{t('workspace.todoModeToggle')}</span>
              <span>{t('workspace.todoModeToggleDesc')}</span>
            </span>
            <span className="settings-switch-control">
              <input
                className="settings-switch-input"
                type="checkbox"
                checked={draftTodoEnabled}
                disabled={loading || saving}
                onChange={(event) => setDraftTodoEnabled(event.target.checked)}
              />
              <span className="settings-switch-track" aria-hidden="true">
                <span className="settings-switch-thumb" />
              </span>
            </span>
          </label>

          <label className="project-home-field project-home-field--compact">
            <span>{t('workspace.taskRunCount')}</span>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={100}
              value={runCount}
              disabled={saving}
              onChange={(event) => setRunCount(clampInt(Number.parseInt(event.target.value, 10), 1, 100, 1))}
            />
          </label>

          <label className="agent-mode-switch project-home-task-switch">
            <span className="agent-mode-switch__copy">
              <span>{t('workspace.taskScheduleToggle')}</span>
              {/* <span>{t('workspace.taskScheduleToggleDesc')}</span> */}
            </span>
            <span className="settings-switch-control">
              <input
                className="settings-switch-input"
                type="checkbox"
                checked={schedule.enabled}
                disabled={saving}
                onChange={(event) => setSchedule((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              <span className="settings-switch-track" aria-hidden="true">
                <span className="settings-switch-thumb" />
              </span>
            </span>
          </label>

          {schedule.enabled ? (
            <div className="project-home-schedule-grid">
              <label className="project-home-field">
                <span>{t('workspace.taskScheduleTime')}</span>
                <input className="settings-input" type="time" value={timeValue} disabled={saving} onChange={(event) => updateTime(event.target.value)} />
              </label>
              <label className="project-home-field">
                <span>{t('workspace.taskScheduleInterval')}</span>
                <select
                  className="settings-input settings-select"
                  value={schedule.interval}
                  disabled={saving}
                  onChange={(event) => setSchedule((prev) => ({ ...prev, interval: event.target.value as HomePluginTaskSchedule['interval'] }))}
                >
                  <option value="off">{t('workspace.taskIntervalOff')}</option>
                  <option value="1h">{t('workspace.taskInterval1h')}</option>
                  <option value="2h">{t('workspace.taskInterval2h')}</option>
                  <option value="3h">{t('workspace.taskInterval3h')}</option>
                  <option value="6h">{t('workspace.taskInterval6h')}</option>
                  <option value="12h">{t('workspace.taskInterval12h')}</option>
                  <option value="1d">{t('workspace.taskInterval1d')}</option>
                </select>
              </label>
            </div>
          ) : null}

          {dialogError ? <div className="project-home-task-error" role="alert">{dialogError}</div> : null}
        </div>
        <div className="project-home-modal__footer">
          <button type="button" className="agent-card-secondary-button" disabled={saving} onClick={onClose}>
            {t('settings.agentMode.cancel')}
          </button>
          <button type="button" className="agent-card-primary-button" disabled={!canSave} onClick={() => void save()}>
            {saving ? t('workspace.taskSaving') : t('settings.agentMode.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

function SortCardsDialog({
  plugins,
  draftOrder,
  draftSizes,
  onDraftOrderChange,
  onDraftSizeChange,
  deletingSlug,
  onDelete,
  onClose,
  onSave,
}: {
  plugins: HomePluginRunItem[]
  draftOrder: string[]
  draftSizes: Record<string, HomePluginCardSize>
  onDraftOrderChange: (order: string[]) => void
  onDraftSizeChange: (slug: string, preferredSize: HomePluginCardSize) => void
  deletingSlug: string
  onDelete: (item: HomePluginRunItem) => void
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
              <div className="project-home-size-switch" role="group" aria-label={t('workspace.sortAgentCards')}>
                {(['small', 'medium', 'large'] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`project-home-size-switch__button${(draftSizes[item.slug] ?? item.manifest.preferredSize) === size ? ' is-active' : ''}`}
                    aria-pressed={(draftSizes[item.slug] ?? item.manifest.preferredSize) === size}
                    onClick={() => onDraftSizeChange(item.slug, size)}
                  >
                    {t(`workspace.cardSize.${size}`)}
                  </button>
                ))}
              </div>
              <span className="project-home-kind-badge">{item.manifest.kind === 'task' ? t('workspace.addTaskCard') : t('workspace.addDataCard')}</span>
              <button type="button" className="project-home-icon-button" disabled={index === 0} onClick={() => move(item.slug, -1)} aria-label={t('workspace.moveCardUp')}>
                <IconInline name="arrowUp" />
              </button>
              <button type="button" className="project-home-icon-button" disabled={index === ordered.length - 1} onClick={() => move(item.slug, 1)} aria-label={t('workspace.moveCardDown')}>
                <IconInline name="arrowDown" />
              </button>
              <button
                type="button"
                className="project-home-icon-button project-home-icon-button--danger"
                disabled={Boolean(deletingSlug)}
                title={t('workspace.deleteAgentCard')}
                onClick={() => onDelete(item)}
                aria-label={t('workspace.deleteAgentCard')}
              >
                <IconInline name={deletingSlug === item.slug ? 'refresh' : 'trash'} />
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

function buildHomeGridItems(plugins: HomePluginRunItem[]): HomeGridItem[] {
  const output: HomeGridItem[] = []
  let column = 1
  let fillerCount = 0

  const createFiller = (id: string, span: number): HomeGridFillerItem | null => {
    if (span !== 1 && span !== 2) return null
    const tones: HomeGridFillerItem['tone'][] = ['grid', 'signal', 'trace']
    const filler: HomeGridFillerItem = {
      kind: 'filler',
      id,
      span,
      tone: tones[fillerCount % tones.length],
    }
    fillerCount += 1
    return filler
  }

  plugins.forEach((item, index) => {
    const span = Math.min(HOME_GRID_COLUMNS, Math.max(1, sizeToColumnSpan(item.manifest.preferredSize)))
    const remaining = HOME_GRID_COLUMNS - column + 1
    if (column > 1 && span > remaining) {
      const filler = createFiller(`before-${item.slug}-${index}`, remaining)
      if (filler) output.push(filler)
      column = 1
    }

    output.push({ kind: 'plugin', item })
    column = span >= HOME_GRID_COLUMNS ? 1 : column + span
    if (column > HOME_GRID_COLUMNS) column = 1
  })

  if (plugins.length > 0 && column > 1) {
    const remaining = HOME_GRID_COLUMNS - column + 1
    const filler = createFiller(`after-${plugins[plugins.length - 1]?.slug ?? 'last'}`, remaining)
    if (filler) output.push(filler)
  }

  return output
}

function useMasonrySpan(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const content = element.querySelector('.project-home-card__measure') as HTMLElement | null
    if (!content) return
    const sync = () => {
      const grid = element.parentElement
      const gridStyle = grid ? window.getComputedStyle(grid) : null
      const rowHeight = Number.parseFloat(gridStyle?.gridAutoRows || '') || 8
      const rowGap = Number.parseFloat(gridStyle?.rowGap || '') || Number.parseFloat(gridStyle?.gap || '') || 24
      const contentHeight = content.scrollHeight || content.getBoundingClientRect().height
      const span = Math.max(1, Math.ceil((contentHeight + rowGap) / (rowHeight + rowGap)))
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

function taskCardViewModelFromMessages(item: HomePluginRunItem, messages: A2uiMessage[]): TaskHomeCardViewModel | null {
  const data = messages
    .map((message) => {
      if (!isRecord(message) || !isRecord(message.updateDataModel)) return null
      const value = message.updateDataModel.value
      return isRecord(value) && isRecord(value.task) ? value.task : null
    })
    .find((task): task is Record<string, unknown> => Boolean(task))

  if (!data) return null

  const scheduleLabel = readTaskText(data.scheduleLabel)
  const todoLabel = readTaskText(data.todoLabel)
  const runCountLabel = readTaskText(data.runCountLabel)
  const threadTitle = readTaskText(data.threadTitle)
  const statusLabel = readTaskText(data.statusLabel) || '待执行'
  const summary = readTaskText(data.summary) || '等待执行'
  const rawDetail = readTaskText(data.detail)
  const detail = [scheduleLabel, todoLabel].includes(rawDetail) ? '' : rawDetail
  const statusTone = taskStatusTone(statusLabel)

  return {
    slug: readTaskText(data.slug) || item.slug,
    title: readTaskText(data.title) || item.manifest.name,
    modeLabel: readTaskText(data.modeLabel),
    statusLabel,
    statusTone,
    summary,
    detail,
    meta: [scheduleLabel, todoLabel, runCountLabel].filter(Boolean),
    threadTitle,
    active: statusTone === 'active',
  }
}

function readTaskText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function taskStatusTone(label: string): TaskHomeCardTone {
  const normalized = label.toLowerCase()
  if (normalized.includes('失败') || normalized.includes('error')) return 'error'
  if (normalized.includes('完成') || normalized.includes('done')) return 'done'
  if (normalized.includes('终止') || normalized.includes('cancel')) return 'cancelled'
  if (normalized.includes('正在执行') || normalized.includes('等待中') || normalized.includes('running') || normalized.includes('queued') || normalized.includes('waiting')) {
    return 'active'
  }
  return 'idle'
}

function hasRenderableMessages(item: HomePluginRunItem): boolean {
  return messagesForSize(item, item.manifest.preferredSize).length > 0
}

function sizeToColumnSpan(size: HomePluginCardSize): number {
  if (size === 'large') return 3
  if (size === 'medium') return 2
  return 1
}

function defaultTaskSchedule(): HomePluginTaskSchedule {
  return { enabled: false, hour: 9, minute: 0, interval: 'off' }
}

function createTaskStepId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function sameProjectPath(a: string, b: string): boolean {
  return normalizeComparablePath(a) === normalizeComparablePath(b)
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function resolveActionPath(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  return resolveActionPath(value.path)
}

function resolveActionText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  return resolveActionText(value.value ?? value.slug ?? value.path)
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) return ''
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
