import { useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { IconInline } from '../icon-inline'
import type { AppViewId, ProjectSkillListState, SettingsCategoryId, WorkspaceProject, WorkspaceThread } from './types'
import { SETTINGS_SIDEBAR_NAV } from './app-shell-constants.ts'

type AppShellSidebarProps = {
  activeViewId: AppViewId
  settingsCategory: SettingsCategoryId
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
  activeProjectId: string
  activeThreadId: string
  showProjectSkills: boolean
  projectSkillStates: Record<string, ProjectSkillListState>
  canBack: boolean
  canForward: boolean
  onNewThread: () => void
  onSelectProject: (projectId: string) => void
  onSelectThread: (threadId: string) => void
  onCreateThreadInProject: (projectId: string) => void
  onRunProjectSkill: (projectId: string, prompt: string) => void
  onToggleThreadPinned: (threadId: string) => void
  onArchiveThread: (threadId: string) => void
  onToggleCollapsed: () => void
  sidebarRef: RefObject<HTMLElement | null>
  splitterRef: RefObject<HTMLDivElement | null>
  onSplitterPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function AppShellSidebar({
  activeViewId,
  settingsCategory,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  showProjectSkills,
  projectSkillStates,
  canBack,
  canForward,
  onNewThread,
  onSelectProject,
  onSelectThread,
  onCreateThreadInProject,
  onRunProjectSkill,
  onToggleThreadPinned,
  onArchiveThread,
  onToggleCollapsed,
  sidebarRef,
  splitterRef,
  onSplitterPointerDown,
}: AppShellSidebarProps) {
  const isSettingsSidebar = activeViewId === 'settings'
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<string | null>(null)

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

  return (
    <>
      <div className="app-chrome-toolbar no-drag" aria-label="窗口导航">
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-toggle-sidebar"
          title="切换侧栏"
          aria-label="切换侧栏"
          onClick={onToggleCollapsed}
        >
          <IconInline name="sidebar" />
        </button>
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-back"
          title="后退"
          aria-label="后退"
          disabled={!canBack}
          onClick={() => window.history.back()}
        >
          <IconInline name="back" />
        </button>
        <button
          type="button"
          className="btn btn-toolbar"
          id="btn-forward"
          title="前进"
          aria-label="前进"
          disabled={!canForward}
          onClick={() => window.history.forward()}
        >
          <IconInline name="forward" />
        </button>
      </div>
      <aside
        className={`app-sidebar${isSettingsSidebar ? ' is-settings-mode' : ''}`}
        aria-label={isSettingsSidebar ? '设置导航' : '侧栏导航'}
        ref={sidebarRef}
      >
        <div className="app-sidebar-scroll">
          <div className="app-sidebar-inner">
            {isSettingsSidebar ? (
              <>
                <button type="button" className="app-sidebar-new-thread" id="btn-settings-back-app" onClick={goLeaveSettings}>
                  <IconInline name="back" />
                  <span>返回应用</span>
                </button>
                <div className="app-sidebar-section-label">设置</div>
                {SETTINGS_SIDEBAR_NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    title={item.disabled ? '尚未实现' : undefined}
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
                    <span>{item.label}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button type="button" className="app-sidebar-new-thread" id="btn-sidebar-new-thread" onClick={onNewThread}>
                  <IconInline name="plus" />
                  <span>新对话</span>
                </button>
                <div className="app-sidebar-section-label">项目</div>
                <div className="app-project-list">
                  {projects.map((project) => {
                    const projectThreads = threadsByProject.get(project.id) ?? []
                    const projectActive = activeProjectId === project.id
                    const projectSkillState = projectSkillStates[project.id]
                    const projectSkills = projectSkillState?.skills ?? []
                    return (
                      <section key={project.id} className={`app-project-group${projectActive ? ' is-active' : ''}`}>
                        <div className="app-project-row">
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
                            className="app-project-new-thread"
                            title="在此项目中新建对话"
                            aria-label={`在 ${project.name} 中新建对话`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setConfirmingArchiveThreadId(null)
                              onCreateThreadInProject(project.id)
                            }}
                          >
                            <IconInline name="plus" />
                          </button>
                        </div>
                        {showProjectSkills ? (
                          <div className="app-project-skill-block" aria-label={`${project.name} Skills`}>
                            <div className="app-sidebar-divider">
                              <span>Skills</span>
                            </div>
                            <div className="app-skill-list">
                              {projectSkillState?.loading ? (
                                <div className="app-skill-empty">扫描中</div>
                              ) : projectSkills.length > 0 ? (
                                projectSkills.map((skill) => (
                                  <button
                                    key={skill.path}
                                    type="button"
                                    className="app-skill-row"
                                    title={skill.description || skill.relativePath}
                                    onClick={() => {
                                      setConfirmingArchiveThreadId(null)
                                      onRunProjectSkill(project.id, skill.title)
                                    }}
                                  >
                                    <IconInline name="chip" />
                                    <span className="app-skill-copy">
                                      <span className="app-skill-title">{skill.title}</span>
                                      <span className="app-skill-meta">{formatSkillMeta(skill.relativePath)}</span>
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <div className="app-skill-empty">
                                  {projectSkillState?.message ? '无法读取项目 skills' : '没有项目 skills'}
                                </div>
                              )}
                            </div>
                            <div className="app-sidebar-divider app-sidebar-divider--threads">
                              <span>对话历史</span>
                            </div>
                          </div>
                        ) : null}
                        <div className="app-thread-list" aria-label={`${project.name} 对话`}>
                          {projectThreads.map((thread) => {
                            const isThreadActive = activeThreadId === thread.id
                            const isConfirming = confirmingArchiveThreadId === thread.id
                            const isPinned = Boolean(thread.pinnedAt)
                            return (
                              <div
                                key={thread.id}
                                className={`app-thread-row${isThreadActive ? ' is-active' : ''}${isPinned ? ' is-pinned' : ''}${isConfirming ? ' is-confirming-archive' : ''}`}
                              >
                                <button
                                  type="button"
                                  className={`app-thread-pin${isPinned ? ' is-pinned' : ''}`}
                                  title={isPinned ? '取消置顶' : '置顶'}
                                  aria-label={isPinned ? `取消置顶 ${thread.title}` : `置顶 ${thread.title}`}
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
                                </button>
                                <div className="app-thread-trailing">
                                  <span className="app-thread-time" aria-label={`最后聊天时间 ${formatThreadTime(thread.updatedAt)}`}>
                                    {formatThreadTime(thread.updatedAt)}
                                  </span>
                                  <button
                                    type="button"
                                    className={`app-thread-archive${isConfirming ? ' is-confirming' : ''}`}
                                    title={isConfirming ? '确认归档' : '归档'}
                                    aria-label={isConfirming ? `确认归档 ${thread.title}` : `归档 ${thread.title}`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      requestArchive(thread.id)
                                    }}
                                  >
                                    {isConfirming ? <span>确认</span> : <IconInline name="trash" />}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {projectThreads.length === 0 ? <div className="app-thread-empty">还没有对话</div> : null}
                        </div>
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
                title="设置"
                aria-label="设置"
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
        aria-label="调整侧栏宽度"
        onPointerDown={onSplitterPointerDown}
      />
    </>
  )
}

function formatThreadTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp)
}

function formatSkillMeta(relativePath: string): string {
  return relativePath
    .replace(/\/SKILL\.md$/i, '')
    .replace(/^\.agents\/skills\//, '')
    .replace(/^\.agent\/skills\//, '')
    .replace(/^\.claude\/skills\//, '')
    .replace(/^\.cursor\/skills\//, '')
}
