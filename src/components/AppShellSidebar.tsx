/**
 * 左侧会话列表、项目切换与设置导航。
 * Conversation rail listing threads/projects plus settings navigation chrome.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { IconInline } from '../icon-inline'
import type { AppLocale } from '../i18n/i18n'
import { useI18n } from '../i18n/i18n'
import type {
  AppViewId,
  ProjectSkillListState,
  SelectedProjectSkill,
  SettingsCategoryId,
  ThreadRunState,
  WorkspaceProject,
  WorkspaceThread,
} from './types'
import { SETTINGS_SIDEBAR_NAV } from './app-shell-constants.ts'

/** 侧栏单区块预览条数（超过则显示「展开显示」）/ Max items before "show more" in sidebar sections */
const SIDEBAR_SECTION_PREVIEW_LIMIT = 5

type ContextMenuItem = {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

type ContextMenuState = {
  x: number
  y: number
  items: ContextMenuItem[]
}

type AppShellSidebarProps = {
  activeViewId: AppViewId
  settingsCategory: SettingsCategoryId
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
  threadRunStates: Record<string, ThreadRunState>
  activeProjectId: string
  activeThreadId: string
  collapsedProjectIds: readonly string[]
  showProjectSkills: boolean
  projectSkillStates: Record<string, ProjectSkillListState>
  selectedProjectSkill: SelectedProjectSkill | null
  hiddenSkillPathsByProject: Record<string, string[]>
  canBack: boolean
  canForward: boolean
  onCreateProject: (mode: 'scratch' | 'existing') => void | Promise<void>
  onSelectProject: (projectId: string) => void
  onSelectThread: (threadId: string) => void
  onSelectProjectSkill: (projectId: string, skill: Omit<SelectedProjectSkill, 'projectId'>) => void
  onRunProjectSkill: (projectId: string, prompt: string) => void
  onToggleThreadPinned: (threadId: string) => void
  onArchiveThread: (threadId: string) => void
  onToggleProjectPinned: (projectId: string) => void
  onToggleSidebarProjectCollapsed: (projectId: string) => void
  onRemoveProject: (projectId: string) => void
  onRevealProjectInFileManager: (projectPath: string) => void
  onHideProjectSkill: (projectId: string, skillPath: string) => void
  onToggleCollapsed: () => void
  sidebarRef: RefObject<HTMLElement | null>
  splitterRef: RefObject<HTMLDivElement | null>
  onSplitterPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 可拖拽分割的可折叠侧栏 / Resizable collapsible sidebar with splitter affordance */
export function AppShellSidebar({
  activeViewId,
  settingsCategory,
  projects,
  threads,
  threadRunStates,
  activeProjectId,
  activeThreadId,
  collapsedProjectIds,
  showProjectSkills,
  projectSkillStates,
  selectedProjectSkill,
  hiddenSkillPathsByProject,
  canBack,
  canForward,
  onCreateProject,
  onSelectProject,
  onSelectThread,
  onSelectProjectSkill,
  onRunProjectSkill,
  onToggleThreadPinned,
  onArchiveThread,
  onToggleProjectPinned,
  onToggleSidebarProjectCollapsed,
  onRemoveProject,
  onRevealProjectInFileManager,
  onHideProjectSkill,
  onToggleCollapsed,
  sidebarRef,
  splitterRef,
  onSplitterPointerDown,
}: AppShellSidebarProps) {
  const { locale, t } = useI18n()
  const isSettingsSidebar = activeViewId === 'settings'
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const collapsedProjectIdSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds])
  const [skillTip, setSkillTip] = useState<{
    text: string
    skillPath: string
    anchor: { left: number; top: number; width: number; height: number }
  } | null>(null)
  const [expandedSkillListByProject, setExpandedSkillListByProject] = useState<Record<string, boolean>>({})
  const [expandedThreadListByProject, setExpandedThreadListByProject] = useState<Record<string, boolean>>({})
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const skillTipPanelRef = useRef<HTMLDivElement>(null)
  const isDarwin = typeof window !== 'undefined' && window.desktop?.platform === 'darwin'

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      return pinDiff || b.updatedAt - a.updatedAt
    })
  }, [projects])

  const closeContextMenu = () => setContextMenu(null)

  useEffect(() => {
    if (contextMenu) setSkillTip(null)
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!skillTip) return
    const panel = skillTipPanelRef.current
    if (!panel) return
    const pad = 8
    const gap = 8
    const rect = panel.getBoundingClientRect()
    const { left: ax, top: ay, width: aw, height: ah } = skillTip.anchor
    let top = ay - rect.height - gap
    if (top < pad) {
      top = ay + ah + gap
    }
    let left = ax + aw / 2 - rect.width / 2
    left = Math.min(Math.max(pad, left), window.innerWidth - pad - rect.width)
    top = Math.min(Math.max(pad, top), window.innerHeight - pad - rect.height)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }, [skillTip])

  useEffect(() => {
    if (!skillTip) return
    const close = () => setSkillTip(null)
    window.addEventListener('resize', close)
    const scrollRoot = sidebarRef.current?.querySelector('.app-sidebar-scroll')
    scrollRoot?.addEventListener('scroll', close, { passive: true })
    return () => {
      window.removeEventListener('resize', close)
      scrollRoot?.removeEventListener('scroll', close)
    }
  }, [skillTip, sidebarRef])

  useEffect(() => {
    if (!contextMenu) return
    const onDocMouseDown = (event: MouseEvent) => {
      const panel = menuPanelRef.current
      if (panel && event.target instanceof Node && panel.contains(event.target)) return
      closeContextMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu) return
    const panel = menuPanelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const pad = 8
    let left = contextMenu.x
    let top = contextMenu.y
    if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - rect.width)
    if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - rect.height)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }, [contextMenu])

  const goLeaveSettings = () => {
    window.location.hash = ''
  }

  const visibleThreads = threads.filter((thread) => !thread.archivedAt)
  const threadsByProject = new Map<string, WorkspaceThread[]>()
  for (const thread of visibleThreads) {
    const list = threadsByProject.get(thread.projectId) ?? []
    list.push(thread)
    threadsByProject.set(thread.projectId, list)
  }
  for (const list of threadsByProject.values()) {
    list.sort((a, b) => {
      const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      return pinDiff || b.updatedAt - a.updatedAt
    })
  }

  const requestArchive = (threadId: string) => {
    if (confirmingArchiveThreadId === threadId) {
      onArchiveThread(threadId)
      setConfirmingArchiveThreadId(null)
      return
    }
    setConfirmingArchiveThreadId(threadId)
  }

  const openProjectMenu = (event: ReactMouseEvent, project: WorkspaceProject) => {
    setSkillTip(null)
    event.preventDefault()
    event.stopPropagation()
    const isPinned = Boolean(project.pinnedAt)
    const canRemove = projects.length > 1
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: 'pin-project',
          label: isPinned ? t('sidebar.menuUnpinProject') : t('sidebar.menuPinProject'),
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onToggleProjectPinned(project.id)
          },
        },
        {
          id: 'reveal',
          label: isDarwin ? t('sidebar.menuRevealInFinder') : t('sidebar.menuRevealInFileManager'),
          disabled: !window.desktop?.showItemInFolder,
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onRevealProjectInFileManager(project.path)
          },
        },
        {
          id: 'remove-project',
          label: t('sidebar.menuRemoveProject'),
          danger: true,
          disabled: !canRemove,
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            if (canRemove) onRemoveProject(project.id)
          },
        },
      ],
    })
  }

  const openSkillMenu = (event: ReactMouseEvent, projectId: string, skill: { path: string; title: string }) => {
    setSkillTip(null)
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: 'run-skill',
          label: t('sidebar.menuRunSkill'),
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onRunProjectSkill(projectId, skill.title)
          },
        },
        {
          id: 'hide-skill',
          label: t('sidebar.menuHideSkill'),
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onHideProjectSkill(projectId, skill.path)
          },
        },
      ],
    })
  }

  const openThreadMenu = (event: ReactMouseEvent, thread: WorkspaceThread) => {
    setSkillTip(null)
    event.preventDefault()
    event.stopPropagation()
    const isPinned = Boolean(thread.pinnedAt)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: 'pin-thread',
          label: isPinned ? t('sidebar.menuUnpinThread') : t('sidebar.menuPinThread'),
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onToggleThreadPinned(thread.id)
          },
        },
        {
          id: 'remove-thread',
          label: t('sidebar.menuRemoveThread'),
          danger: true,
          onSelect: () => {
            closeContextMenu()
            setConfirmingArchiveThreadId(null)
            onArchiveThread(thread.id)
          },
        },
      ],
    })
  }

  return (
    <>
      <div className="app-chrome-toolbar no-drag" aria-label={t('sidebar.windowNav')}>
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-toggle-sidebar"
          title={t('sidebar.toggleSidebar')}
          aria-label={t('sidebar.toggleSidebar')}
          onClick={onToggleCollapsed}
        >
          <IconInline name="sidebar" />
        </button>
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-back"
          title={t('sidebar.back')}
          aria-label={t('sidebar.back')}
          disabled={!canBack}
          onClick={() => window.history.back()}
        >
          <IconInline name="back" />
        </button>
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-forward"
          title={t('sidebar.forward')}
          aria-label={t('sidebar.forward')}
          disabled={!canForward}
          onClick={() => window.history.forward()}
        >
          <IconInline name="forward" />
        </button>
      </div>
      <aside
        className={`app-sidebar${isSettingsSidebar ? ' is-settings-mode' : ''}`}
        aria-label={isSettingsSidebar ? t('sidebar.settingsNav') : t('sidebar.appNav')}
        ref={sidebarRef}
      >
        <div className="app-sidebar-scroll">
          <div className="app-sidebar-inner">
            {isSettingsSidebar ? (
              <>
                <button type="button" className="app-sidebar-new-thread" id="btn-settings-back-app" onClick={goLeaveSettings}>
                  <IconInline name="back" />
                  <span>{t('sidebar.backToApp')}</span>
                </button>
                <div className="app-sidebar-section-label">{t('sidebar.settingsSection')}</div>
                {SETTINGS_SIDEBAR_NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    title={item.disabled ? t('sidebar.notImplemented') : undefined}
                    className={`app-nav-item${settingsCategory === item.id ? ' is-active' : ''}`}
                    data-settings-category={item.id}
                    onClick={() => {
                      if (item.disabled) {
                        return
                      }
                      window.location.hash = `settings/${item.id}`
                    }}
                  >
                    <IconInline name={item.icon} />
                    <span>{t(item.labelKey)}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="app-sidebar-new-thread"
                  id="btn-sidebar-new-project"
                  onClick={() => void onCreateProject('existing')}
                >
                  <IconInline name="plus" />
                  <span>{t('sidebar.addProject')}</span>
                </button>
                <div className="app-sidebar-section-label">{t('sidebar.projectsSection')}</div>
                <div className="app-project-list">
                  {sortedProjects.map((project) => {
                    const projectThreads = threadsByProject.get(project.id) ?? []
                    const projectActive = activeProjectId === project.id
                    const projectExpanded = !collapsedProjectIdSet.has(project.id)
                    const projectSkillState = projectSkillStates[project.id]
                    const projectSkills = projectSkillState?.skills ?? []
                    const hiddenPaths = new Set(hiddenSkillPathsByProject[project.id] ?? [])
                    const visibleSkills = projectSkills.filter((skill) => !hiddenPaths.has(skill.path))
                    const showSkillsSection = Boolean(projectSkillState?.loading) || visibleSkills.length > 0
                    const showThreadHistoryDivider = showProjectSkills
                    const skillsListOverflow = visibleSkills.length > SIDEBAR_SECTION_PREVIEW_LIMIT
                    const skillsListFullyExpanded = expandedSkillListByProject[project.id] ?? false
                    const displayedSkills =
                      skillsListOverflow && !skillsListFullyExpanded
                        ? visibleSkills.slice(0, SIDEBAR_SECTION_PREVIEW_LIMIT)
                        : visibleSkills
                    const threadsListOverflow = projectThreads.length > SIDEBAR_SECTION_PREVIEW_LIMIT
                    const threadsListFullyExpanded = expandedThreadListByProject[project.id] ?? false
                    const displayedThreads =
                      threadsListOverflow && !threadsListFullyExpanded
                        ? projectThreads.slice(0, SIDEBAR_SECTION_PREVIEW_LIMIT)
                        : projectThreads
                    return (
                      <section key={project.id} className={`app-project-group${projectActive ? ' is-active' : ''}${project.pinnedAt ? ' is-pinned' : ''}`}>
                        <div
                          className="app-project-row"
                          onContextMenu={(event) => openProjectMenu(event, project)}
                        >
                          <button
                            type="button"
                            className="app-project-select"
                            aria-current={projectActive ? 'true' : undefined}
                            onClick={() => {
                              setConfirmingArchiveThreadId(null)
                              onSelectProject(project.id)
                            }}
                          >
                            <IconInline name="folder" />
                            <span className="app-project-copy">
                              <span className="app-project-name">{project.name}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`app-project-toggle${projectExpanded ? ' is-expanded' : ' is-collapsed'}`}
                            title={projectExpanded ? t('sidebar.collapseProject') : t('sidebar.expandProject')}
                            aria-label={
                              projectExpanded
                                ? t('sidebar.collapseProjectAria', { name: project.name })
                                : t('sidebar.expandProjectAria', { name: project.name })
                            }
                            aria-expanded={projectExpanded}
                            onClick={(event) => {
                              event.stopPropagation()
                              setConfirmingArchiveThreadId(null)
                              onToggleSidebarProjectCollapsed(project.id)
                            }}
                          >
                            <IconInline name="chevron" />
                          </button>
                        </div>
                        {projectExpanded ? (
                          <div className="app-project-content">
                            {showProjectSkills && showSkillsSection ? (
                              <div className="app-project-skill-block" aria-label={`${project.name} Skills`}>
                                <div className="app-sidebar-divider">
                                  <span>{t('sidebar.skillsDivider')}</span>
                                </div>
                                <div className="app-skill-list">
                                  {projectSkillState?.loading ? (
                                    <div className="app-skill-empty">{t('sidebar.scanning')}</div>
                                  ) : (
                                    <>
                                      {displayedSkills.map((skill) => {
                                      const tipText = skill.description.trim()
                                      const tipActive = Boolean(tipText) && skillTip?.skillPath === skill.path
                                      const skillActive =
                                        selectedProjectSkill?.projectId === project.id &&
                                        selectedProjectSkill.path === skill.path
                                      return (
                                        <div
                                          key={skill.path}
                                          className={`app-skill-row-wrap${skillActive ? ' is-active' : ''}`}
                                          role="presentation"
                                          onPointerEnter={(event) => {
                                            if (!tipText) return
                                            const r = event.currentTarget.getBoundingClientRect()
                                            setSkillTip({
                                              text: tipText,
                                              skillPath: skill.path,
                                              anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
                                            })
                                          }}
                                          onPointerLeave={() => {
                                            setSkillTip((prev) => (prev?.skillPath === skill.path ? null : prev))
                                          }}
                                          onContextMenu={(event) => openSkillMenu(event, project.id, skill)}
                                        >
                                          <span className="app-skill-lead" aria-hidden="true">
                                            <span className="app-skill-icon">
                                              <IconInline name="chip" />
                                            </span>
                                          </span>
                                          <button
                                            type="button"
                                            className="app-skill-select"
                                            title={tipText ? undefined : skill.relativePath}
                                            aria-current={skillActive ? 'page' : undefined}
                                            aria-describedby={tipActive ? 'app-sidebar-skill-tip' : undefined}
                                            onClick={() => {
                                              setConfirmingArchiveThreadId(null)
                                              onSelectProjectSkill(project.id, {
                                                title: skill.title,
                                                description: skill.description,
                                                path: skill.path,
                                                relativePath: skill.relativePath,
                                                argumentHint: skill.argumentHint,
                                              })
                                            }}
                                          >
                                            <span className="app-skill-title">{skill.title}</span>
                                          </button>
                                          <div className="app-skill-trailing">
                                            {skillActive ? (
                                              <button
                                                type="button"
                                                className="app-skill-run"
                                                title={t('sidebar.menuRunSkill')}
                                                aria-label={t('sidebar.runSkillAria', { title: skill.title })}
                                                onClick={(event) => {
                                                  event.stopPropagation()
                                                  setSkillTip(null)
                                                  setConfirmingArchiveThreadId(null)
                                                  onRunProjectSkill(project.id, skill.title)
                                                }}
                                              >
                                                <span>{t('sidebar.menuRunSkill')}</span>
                                              </button>
                                            ) : null}
                                          </div>
                                        </div>
                                      )
                                    })}
                                      {skillsListOverflow && !skillsListFullyExpanded ? (
                                        <button
                                          type="button"
                                          className="app-sidebar-expand-section"
                                          aria-label={t('sidebar.expandListShowAria', { section: t('sidebar.skillsDivider') })}
                                          onClick={() => {
                                            setConfirmingArchiveThreadId(null)
                                            setExpandedSkillListByProject((prev) => ({ ...prev, [project.id]: true }))
                                          }}
                                        >
                                          {t('sidebar.expandListShow')}
                                        </button>
                                      ) : null}
                                      {skillsListOverflow && skillsListFullyExpanded ? (
                                        <button
                                          type="button"
                                          className="app-sidebar-expand-section"
                                          aria-label={t('sidebar.collapseListShowAria', { section: t('sidebar.skillsDivider') })}
                                          onClick={() => {
                                            setConfirmingArchiveThreadId(null)
                                            setSkillTip(null)
                                            setExpandedSkillListByProject((prev) => ({ ...prev, [project.id]: false }))
                                          }}
                                        >
                                          {t('sidebar.collapseListShow')}
                                        </button>
                                      ) : null}
                                    </>
                                  )}
                                </div>
                              </div>
                            ) : null}
                            {showThreadHistoryDivider ? (
                              <div className="app-sidebar-divider app-sidebar-divider--threads">
                                <span>{t('sidebar.threadHistory')}</span>
                              </div>
                            ) : null}
                            <div className="app-thread-list" aria-label={t('sidebar.threadsForProjectAria', { name: project.name })}>
                              {projectThreads.length === 0 ? (
                                <div className="app-thread-empty">{t('sidebar.noThreadHistory')}</div>
                              ) : null}
                              {displayedThreads.map((thread) => {
                                const isThreadActive = activeThreadId === thread.id
                                const isConfirming = confirmingArchiveThreadId === thread.id
                                const isPinned = Boolean(thread.pinnedAt)
                                const isHomePluginThread = thread.purpose === 'home-plugin-customization'
                                const runState = threadRunStates[thread.id]
                                const isThreadRunning = Boolean(runState)
                                const timeLabel = formatThreadTime(thread.updatedAt, locale, t)
                                return (
                                  <div
                                    key={thread.id}
                                    className={`app-thread-row${isThreadActive ? ' is-active' : ''}${isPinned ? ' is-pinned' : ''}${isThreadRunning ? ' is-running' : ''}${isConfirming ? ' is-confirming-archive' : ''}`}
                                    onContextMenu={(event) => openThreadMenu(event, thread)}
                                  >
                                    <button
                                      type="button"
                                      className={`app-thread-pin${isPinned ? ' is-pinned' : ''}`}
                                      title={isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
                                      aria-label={
                                        isPinned
                                          ? t('sidebar.unpinThreadAria', { title: thread.title })
                                          : t('sidebar.pinThreadAria', { title: thread.title })
                                      }
                                      aria-pressed={isPinned}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        setConfirmingArchiveThreadId(null)
                                        onToggleThreadPinned(thread.id)
                                      }}
                                    >
                                      <IconInline name="pin" />
                                    </button>
                                    <button
                                      type="button"
                                      className="app-thread-select"
                                      aria-current={isThreadActive ? 'page' : undefined}
                                      onClick={() => {
                                        setConfirmingArchiveThreadId(null)
                                        onSelectThread(thread.id)
                                      }}
                                    >
                                      <span className="app-thread-title">{thread.title}</span>
                                      {isHomePluginThread ? (
                                        <IconInline name="agent" className="app-thread-purpose-icon" />
                                      ) : null}
                                    </button>
                                    <div className="app-thread-trailing">
                                      {runState ? (
                                        <span
                                          className={`app-thread-running${runState.status === 'waiting' ? ' is-waiting' : ''}`}
                                          title={
                                            runState.status === 'waiting'
                                              ? t('sidebar.threadWaiting')
                                              : t('sidebar.threadRunning')
                                          }
                                          aria-label={
                                            runState.status === 'waiting'
                                              ? t('sidebar.threadWaiting')
                                              : t('sidebar.threadRunning')
                                          }
                                        />
                                      ) : (
                                        <span className="app-thread-time" aria-label={t('sidebar.lastChatAria', { time: timeLabel })}>
                                          {timeLabel}
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        className={`app-thread-archive${isConfirming ? ' is-confirming' : ''}`}
                                        title={isConfirming ? t('sidebar.confirmArchive') : t('sidebar.archive')}
                                        aria-label={
                                          isConfirming
                                            ? t('sidebar.confirmArchiveAria', { title: thread.title })
                                            : t('sidebar.archiveAria', { title: thread.title })
                                        }
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          requestArchive(thread.id)
                                        }}
                                      >
                                        {isConfirming ? <span>{t('sidebar.confirm')}</span> : <IconInline name="trash" />}
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                              {threadsListOverflow && !threadsListFullyExpanded ? (
                                <button
                                  type="button"
                                  className="app-sidebar-expand-section"
                                  aria-label={t('sidebar.expandListShowAria', { section: t('sidebar.threadHistory') })}
                                  onClick={() => {
                                    setConfirmingArchiveThreadId(null)
                                    setExpandedThreadListByProject((prev) => ({ ...prev, [project.id]: true }))
                                  }}
                                >
                                  {t('sidebar.expandListShow')}
                                </button>
                              ) : null}
                              {threadsListOverflow && threadsListFullyExpanded ? (
                                <button
                                  type="button"
                                  className="app-sidebar-expand-section"
                                  aria-label={t('sidebar.collapseListShowAria', { section: t('sidebar.threadHistory') })}
                                  onClick={() => {
                                    setConfirmingArchiveThreadId(null)
                                    setExpandedThreadListByProject((prev) => ({ ...prev, [project.id]: false }))
                                  }}
                                >
                                  {t('sidebar.collapseListShow')}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </section>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        {!isSettingsSidebar && (
          <footer className="app-sidebar-footer">
            <button
              type="button"
              className="btn btn-toolbar"
              id="btn-footer-settings"
              title={t('sidebar.settings')}
              aria-label={t('sidebar.settings')}
              onClick={() => {
                window.location.hash = 'settings/general'
              }}
            >
              <IconInline name="settings" />
            </button>
          </footer>
        )}
      </aside>
      <div
        className="app-sidebar-splitter no-drag"
        id="app-sidebar-splitter"
        ref={splitterRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resizeSidebar')}
        onPointerDown={onSplitterPointerDown}
      />
      {contextMenu ? (
        <div
          ref={menuPanelRef}
          className="app-sidebar-context-menu"
          role="menu"
          aria-label={t('sidebar.contextMenuAria')}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`app-sidebar-context-menu__item${item.danger ? ' is-danger' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                if (item.disabled) return
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {skillTip ? (
        <div
          ref={skillTipPanelRef}
          id="app-sidebar-skill-tip"
          className="app-sidebar-context-menu app-sidebar-context-menu--skill-tip"
          role="tooltip"
          style={{ left: 0, top: 0 }}
        >
          <p className="app-sidebar-context-menu__tip-text">{skillTip.text}</p>
        </div>
      ) : null}
    </>
  )
}

// --- Module helpers / 模块内工具 ---

function formatThreadTime(timestamp: number, locale: AppLocale, t: (path: string, vars?: Record<string, string | number>) => string): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return t('sidebar.justNow')
  if (diff < 3_600_000) return t('sidebar.minutesShort', { n: Math.max(1, Math.floor(diff / 60_000)) })
  if (diff < 86_400_000) return t('sidebar.hoursShort', { n: Math.floor(diff / 3_600_000) })
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric' }).format(timestamp)
}
