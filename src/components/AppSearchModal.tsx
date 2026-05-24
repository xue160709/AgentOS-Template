/**
 * App-level search modal for project files, message history, chats, tasks, and skills.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import type { AgentContextSlashItem, AgentKnowledgeSearchItem, ChatHistorySearchItem, ProjectFileSearchItem } from '../claude-chat-types'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type {
  AppSearchHighlightRange,
  AppSearchResult,
  AppSearchResultKind,
  AppSearchScope,
  ProjectSkillRunRequest,
  ThreadRunState,
  WorkspaceProject,
  WorkspaceThread,
} from './types'

const MAX_SECTION_RESULTS = 8
const FILE_SEARCH_DEBOUNCE_MS = 90
const MESSAGE_SEARCH_DEBOUNCE_MS = 120

type AppSearchModalProps = {
  activeProject: WorkspaceProject
  projects: WorkspaceProject[]
  threads: WorkspaceThread[]
  projectSkills: AgentContextSlashItem[]
  threadRunStates: Record<string, ThreadRunState>
  initialScope: AppSearchScope
  onClose: () => void
  onOpenFile: (item: ProjectFileSearchItem) => void
  onRunProjectSkill: (projectId: string, skill: ProjectSkillRunRequest) => void
  onAskKnowledge: (item: AgentKnowledgeSearchItem) => void
  onInsertKnowledgeContext: (item: AgentKnowledgeSearchItem) => void
  onSelectMessage: (threadId: string, itemId?: string) => void
  onSelectThread: (threadId: string) => void
}

type SearchHit =
  | (AppSearchResult & {
      kind: 'directory' | 'file'
      file: ProjectFileSearchItem
    })
  | (AppSearchResult & {
      kind: 'chat' | 'task'
      thread: WorkspaceThread
    })
  | (AppSearchResult & {
      kind: 'message'
      message: ChatHistorySearchItem
    })
  | (AppSearchResult & {
      kind: 'agent' | 'command' | 'home-plugin' | 'memory'
      knowledge: AgentKnowledgeSearchItem
    })
  | (AppSearchResult & {
      kind: 'skill'
      knowledge: AgentKnowledgeSearchItem
    })
  | (AppSearchResult & {
      kind: 'task'
      knowledge: AgentKnowledgeSearchItem
    })
  | (AppSearchResult & {
      kind: 'skill'
      skill: AgentContextSlashItem
    })

type SearchSection = {
  key: AppSearchResultKind | 'files-loading' | 'messages-loading'
  title: string
  items: SearchHit[]
  state?: 'empty' | 'error' | 'loading'
  message?: string
}

type TextMatch = {
  score: number
  ranges: Array<[number, number]>
}

type SearchProjectScope = 'all' | 'current'
type SearchRecentFilter = '30d' | '7d' | 'all'

export function AppSearchModal({
  activeProject,
  projects,
  threads,
  projectSkills,
  threadRunStates,
  initialScope,
  onClose,
  onOpenFile,
  onRunProjectSkill,
  onAskKnowledge,
  onInsertKnowledgeContext,
  onSelectMessage,
  onSelectThread,
}: AppSearchModalProps) {
  const { locale, t } = useI18n()
  const [scope, setScope] = useState<AppSearchScope>(initialScope)
  const [query, setQuery] = useState('')
  const [fileItems, setFileItems] = useState<ProjectFileSearchItem[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [messageItems, setMessageItems] = useState<ChatHistorySearchItem[]>([])
  const [messageLoading, setMessageLoading] = useState(false)
  const [messageError, setMessageError] = useState('')
  const [knowledgeItems, setKnowledgeItems] = useState<AgentKnowledgeSearchItem[]>([])
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [projectScope, setProjectScope] = useState<SearchProjectScope>('current')
  const [recentFilter, setRecentFilter] = useState<SearchRecentFilter>('all')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const trimmedQuery = query.trim()
  const shouldSearchFiles = (scope === 'all' || scope === 'files') && trimmedQuery.length > 0
  const shouldSearchMessages = (scope === 'all' || scope === 'messages') && trimmedQuery.length > 0
  const shouldSearchKnowledge =
    (scope === 'all' || scope === 'memory' || scope === 'skills' || scope === 'tasks') && trimmedQuery.length > 0
  const targetProjects = useMemo(() => (projectScope === 'all' ? projects : [activeProject]), [activeProject, projectScope, projects])
  const targetProjectKey = useMemo(() => targetProjects.map((project) => `${project.id}:${project.path}`).join('\n'), [targetProjects])
  const recentDays = recentFilter === '7d' ? 7 : recentFilter === '30d' ? 30 : undefined

  useEffect(() => {
    setScope(initialScope)
  }, [initialScope])

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  useEffect(() => {
    if (!shouldSearchFiles) {
      setFileItems([])
      setFileLoading(false)
      setFileError('')
      return
    }

    const searchProjectFiles = window.desktop?.searchProjectFiles
    if (!searchProjectFiles) {
      setFileItems([])
      setFileLoading(false)
      setFileError(t('search.fileSearchUnavailable'))
      return
    }

    let cancelled = false
    setFileLoading(true)
    setFileError('')

    const timer = window.setTimeout(() => {
      searchProjectFiles(activeProject.path, trimmedQuery)
        .then((result) => {
          if (cancelled) return
          setFileItems(result.ok ? result.items : [])
          setFileError(result.ok ? '' : result.message)
        })
        .catch((error) => {
          if (cancelled) return
          setFileItems([])
          setFileError(error instanceof Error ? error.message : t('search.fileSearchFailed'))
        })
        .finally(() => {
          if (!cancelled) setFileLoading(false)
        })
    }, FILE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeProject.path, shouldSearchFiles, t, trimmedQuery])

  useEffect(() => {
    if (!shouldSearchMessages) {
      setMessageItems([])
      setMessageLoading(false)
      setMessageError('')
      return
    }

    const searchChatHistory = window.desktop?.searchChatHistory
    if (!searchChatHistory) {
      setMessageItems([])
      setMessageLoading(false)
      setMessageError(t('search.messageSearchUnavailable'))
      return
    }

    let cancelled = false
    setMessageLoading(true)
    setMessageError('')

    const timer = window.setTimeout(() => {
      searchChatHistory(projectScope === 'all' ? '' : activeProject.id, trimmedQuery, { includeArchived, limit: MAX_SECTION_RESULTS * 3 })
        .then((result) => {
          if (cancelled) return
          setMessageItems(result.ok ? result.items : [])
          setMessageError(result.ok ? '' : result.message)
        })
        .catch((error) => {
          if (cancelled) return
          setMessageItems([])
          setMessageError(error instanceof Error ? error.message : t('search.messageSearchFailed'))
        })
        .finally(() => {
          if (!cancelled) setMessageLoading(false)
        })
    }, MESSAGE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeProject.id, includeArchived, projectScope, shouldSearchMessages, t, trimmedQuery])

  useEffect(() => {
    if (!shouldSearchKnowledge) {
      setKnowledgeItems([])
      setKnowledgeLoading(false)
      setKnowledgeError('')
      return
    }

    const searchAgentKnowledge = window.desktop?.searchAgentKnowledge
    if (!searchAgentKnowledge) {
      setKnowledgeItems([])
      setKnowledgeLoading(false)
      setKnowledgeError(t('search.knowledgeSearchUnavailable'))
      return
    }

    let cancelled = false
    setKnowledgeLoading(true)
    setKnowledgeError('')

    const kinds =
      scope === 'memory'
        ? (['memory'] as const)
        : scope === 'skills'
          ? (['skill', 'command', 'agent'] as const)
          : scope === 'tasks'
            ? (['task', 'home-plugin'] as const)
            : undefined

    const timer = window.setTimeout(() => {
      searchAgentKnowledge(
        targetProjects.map((project) => ({ id: project.id, name: project.name, path: project.path })),
        trimmedQuery,
        { kinds: kinds ? [...kinds] : undefined, limit: MAX_SECTION_RESULTS * 4, recentDays },
      )
        .then((result) => {
          if (cancelled) return
          setKnowledgeItems(result.ok ? result.items : [])
          setKnowledgeError(result.ok ? '' : result.message)
        })
        .catch((error) => {
          if (cancelled) return
          setKnowledgeItems([])
          setKnowledgeError(error instanceof Error ? error.message : t('search.knowledgeSearchFailed'))
        })
        .finally(() => {
          if (!cancelled) setKnowledgeLoading(false)
        })
    }, MESSAGE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [recentDays, scope, shouldSearchKnowledge, t, targetProjectKey, targetProjects, trimmedQuery])

  const threadHits = useMemo(
    () => buildThreadHits({ activeProject, includeArchived, locale, projectScope, projects, query: trimmedQuery, recentDays, t, threadRunStates, threads }),
    [activeProject, includeArchived, locale, projectScope, projects, recentDays, trimmedQuery, t, threadRunStates, threads],
  )
  const skillHits = useMemo(
    () => buildSkillHits({ activeProject, projectSkills, query: trimmedQuery, t }),
    [activeProject, projectSkills, trimmedQuery, t],
  )
  const fileHits = useMemo(
    () => buildFileHits({ activeProject, fileItems, query: trimmedQuery, t }),
    [activeProject, fileItems, trimmedQuery, t],
  )
  const messageHits = useMemo(
    () => buildMessageHits({ activeProject, locale, messageItems, projectScope, query: trimmedQuery, recentDays, t }),
    [activeProject, locale, messageItems, projectScope, recentDays, trimmedQuery, t],
  )
  const knowledgeHits = useMemo(
    () => buildKnowledgeHits({ activeProject, knowledgeItems, locale, projectScope, query: trimmedQuery, t }),
    [activeProject, knowledgeItems, locale, projectScope, trimmedQuery, t],
  )

  const sections = useMemo(
    () =>
      buildSections({
        fileError,
        fileHits,
        fileLoading,
        messageError,
        messageHits,
        messageLoading,
        knowledgeError,
        knowledgeHits,
        knowledgeLoading,
        query: trimmedQuery,
        scope,
        skillHits,
        t,
        threadHits,
      }),
    [
      fileError,
      fileHits,
      fileLoading,
      knowledgeError,
      knowledgeHits,
      knowledgeLoading,
      messageError,
      messageHits,
      messageLoading,
      scope,
      skillHits,
      t,
      threadHits,
      trimmedQuery,
    ],
  )

  const flatHits = useMemo(() => sections.flatMap((section) => section.items), [sections])
  const activeHit = flatHits[activeIndex] ?? null

  useEffect(() => {
    setActiveIndex(flatHits.length > 0 ? 0 : -1)
  }, [flatHits.length, scope, trimmedQuery])

  useEffect(() => {
    if (activeIndex < 0) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const selectHit = (hit: SearchHit | null) => {
    if (!hit) return
    if (hit.kind === 'file' || hit.kind === 'directory') {
      onOpenFile(hit.file)
      onClose()
      return
    }
    if ((hit.kind === 'chat' || hit.kind === 'task') && 'thread' in hit) {
      onSelectThread(hit.thread.id)
      onClose()
      return
    }
    if (hit.kind === 'message') {
      onSelectMessage(hit.message.threadId, hit.message.itemId)
      onClose()
      return
    }
    if ('knowledge' in hit) {
      if (hit.kind === 'memory' && hit.knowledge.path) {
        onOpenFile({
          label: hit.knowledge.relativePath?.split('/').pop() || hit.knowledge.title,
          path: hit.knowledge.path,
          relativePath: hit.knowledge.relativePath ?? hit.knowledge.path,
          type: 'file',
        })
        onClose()
        return
      }
      if ((hit.kind === 'skill' || hit.kind === 'command') && hit.knowledge.command && hit.knowledge.path) {
        onRunProjectSkill(hit.knowledge.projectId, {
          title: hit.knowledge.title,
          command: hit.knowledge.command,
          description: hit.knowledge.snippet || hit.knowledge.subtitle,
          path: hit.knowledge.path,
          relativePath: hit.knowledge.relativePath ?? hit.knowledge.path,
        })
        onClose()
        return
      }
      if ((hit.kind === 'task' || hit.kind === 'home-plugin') && hit.knowledge.threadId) {
        onSelectThread(hit.knowledge.threadId)
        onClose()
        return
      }
      if (hit.kind === 'agent') {
        onInsertKnowledgeContext(hit.knowledge)
        onClose()
        return
      }
      onAskKnowledge(hit.knowledge)
      onClose()
      return
    }
    if (hit.kind === 'skill') {
      onRunProjectSkill(activeProject.id, {
        title: hit.skill.title,
        command: hit.skill.command,
        description: hit.skill.description,
        path: hit.skill.path,
        relativePath: hit.skill.relativePath,
      })
      onClose()
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (flatHits.length > 0) setActiveIndex((current) => (current < 0 ? 0 : (current + 1) % flatHits.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (flatHits.length > 0) setActiveIndex((current) => (current < 0 ? flatHits.length - 1 : (current - 1 + flatHits.length) % flatHits.length))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      if (flatHits.length > 0) setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      if (flatHits.length > 0) setActiveIndex(flatHits.length - 1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      selectHit(activeHit)
    }
  }

  let runningIndex = 0

  return (
    <div className="app-search-overlay" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="app-search-panel" role="dialog" aria-modal="true" aria-labelledby="app-search-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="sr-only" id="app-search-title">
          {t('search.open')}
        </h2>
        <header className="app-search-header">
          <div className="app-search-input-shell">
            <IconInline name="search" className="app-search-input-icon" />
            <label className="sr-only" htmlFor="app-search-input">
              {t('search.inputLabel')}
            </label>
            <input
              ref={inputRef}
              id="app-search-input"
              type="search"
              value={query}
              placeholder={t('search.placeholder', { project: activeProject.name })}
              aria-controls="app-search-results"
              aria-activedescendant={activeIndex >= 0 ? `app-search-result-${activeIndex}` : undefined}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            <button type="button" className="btn btn-toolbar app-search-close" aria-label={t('search.close')} onClick={onClose}>
              <IconInline name="x" />
            </button>
          </div>
          <nav className="app-search-scopes" aria-label={t('search.scopeAria')}>
            {(['all', 'files', 'messages', 'memory', 'chats', 'skills', 'tasks'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={`app-search-scope${scope === item ? ' is-active' : ''}`}
                aria-pressed={scope === item}
                onClick={() => setScope(item)}
              >
                {t(`search.scope.${item}`)}
              </button>
            ))}
          </nav>
          <div className="app-search-options" aria-label={t('search.filtersAria')}>
            <label className="app-search-select">
              <span>{t('search.projectScope.label')}</span>
              <select value={projectScope} onChange={(event) => setProjectScope(event.currentTarget.value as SearchProjectScope)}>
                <option value="current">{t('search.projectScope.current')}</option>
                <option value="all">{t('search.projectScope.all')}</option>
              </select>
            </label>
            <label className="app-search-select">
              <span>{t('search.recent.label')}</span>
              <select value={recentFilter} onChange={(event) => setRecentFilter(event.currentTarget.value as SearchRecentFilter)}>
                <option value="all">{t('search.recent.all')}</option>
                <option value="7d">{t('search.recent.7d')}</option>
                <option value="30d">{t('search.recent.30d')}</option>
              </select>
            </label>
            <label className="app-search-option">
              <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.currentTarget.checked)} />
              <span>{t('search.includeArchived')}</span>
            </label>
          </div>
        </header>

        <div ref={listRef} className="app-search-results" id="app-search-results" role="listbox" aria-label={t('search.resultsAria')}>
          {sections.length === 0 ? (
            <div className="app-search-empty" role="status">
              {trimmedQuery ? t('search.noResults', { project: activeProject.name }) : t('search.empty', { project: activeProject.name })}
            </div>
          ) : (
            sections.map((section) => {
              if (section.items.length === 0) {
                return (
                  <section className="app-search-section" key={section.key}>
                    <h2>{section.title}</h2>
                    <div className={`app-search-empty${section.state === 'error' ? ' is-error' : ''}`} role={section.state === 'error' ? 'alert' : 'status'}>
                      {section.message}
                    </div>
                  </section>
                )
              }

              return (
                <section className="app-search-section" key={section.key}>
                  <h2>{section.title}</h2>
                  <div className="app-search-section-list">
                    {section.items.map((hit) => {
                      const index = runningIndex
                      runningIndex += 1
                      const isActive = index === activeIndex
                      return (
                        <button
                          key={hit.id}
                          type="button"
                          id={`app-search-result-${index}`}
                          data-search-index={index}
                          role="option"
                          aria-selected={isActive}
                          className={`app-search-result${isActive ? ' is-active' : ''}`}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => selectHit(hit)}
                        >
                          <span className={`app-search-result-icon is-${hit.kind}`}>
                            <IconInline name={iconForHit(hit)} />
                          </span>
                          <span className="app-search-result-copy">
                            <span className="app-search-result-title">{highlightText(hit.title, hit.highlights, 'title')}</span>
                            {hit.subtitle ? (
                              <span className="app-search-result-subtitle">{highlightText(hit.subtitle, hit.highlights, 'subtitle')}</span>
                            ) : null}
                          </span>
                          <span className="app-search-result-action">{actionLabelForHit(hit, t)}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })
          )}
        </div>
      </section>
    </div>
  )
}

function buildSections({
  fileError,
  fileHits,
  fileLoading,
  knowledgeError,
  knowledgeHits,
  knowledgeLoading,
  messageError,
  messageHits,
  messageLoading,
  query,
  scope,
  skillHits,
  t,
  threadHits,
}: {
  fileError: string
  fileHits: SearchHit[]
  fileLoading: boolean
  knowledgeError: string
  knowledgeHits: SearchHit[]
  knowledgeLoading: boolean
  messageError: string
  messageHits: SearchHit[]
  messageLoading: boolean
  query: string
  scope: AppSearchScope
  skillHits: SearchHit[]
  t: (path: string, vars?: Record<string, string | number>) => string
  threadHits: SearchHit[]
}): SearchSection[] {
  const sections: SearchSection[] = []
  const chatHits = threadHits.filter((hit) => hit.kind === 'chat')
  const taskHits = threadHits.filter((hit) => hit.kind === 'task')
  const memoryHits = knowledgeHits.filter((hit) => hit.kind === 'memory')
  const knowledgeSkillHits = knowledgeHits.filter((hit) => hit.kind === 'skill' || hit.kind === 'command' || hit.kind === 'agent')
  const knowledgeTaskHits = knowledgeHits.filter((hit) => hit.kind === 'task' || hit.kind === 'home-plugin')

  if (scope === 'all' || scope === 'files') {
    if (fileError) {
      sections.push({ key: 'file', title: t('search.section.files'), items: [], state: 'error', message: fileError })
    } else if (fileLoading) {
      sections.push({ key: 'files-loading', title: t('search.section.files'), items: [], state: 'loading', message: t('search.loading') })
    } else if (fileHits.length > 0) {
      sections.push({ key: 'file', title: t('search.section.files'), items: fileHits.slice(0, MAX_SECTION_RESULTS) })
    } else if (scope === 'files') {
      sections.push({
        key: 'file',
        title: t('search.section.files'),
        items: [],
        state: 'empty',
        message: query ? t('search.noFileResults') : t('search.typeForFiles'),
      })
    }
  }

  if (scope === 'all' || scope === 'messages') {
    if (messageError) {
      sections.push({ key: 'message', title: t('search.section.messages'), items: [], state: 'error', message: messageError })
    } else if (messageLoading) {
      sections.push({ key: 'messages-loading', title: t('search.section.messages'), items: [], state: 'loading', message: t('search.loading') })
    } else if (messageHits.length > 0) {
      sections.push({ key: 'message', title: t('search.section.messages'), items: messageHits.slice(0, MAX_SECTION_RESULTS) })
    } else if (scope === 'messages') {
      sections.push({
        key: 'message',
        title: t('search.section.messages'),
        items: [],
        state: 'empty',
        message: query ? t('search.noMessageResults') : t('search.typeForMessages'),
      })
    }
  }

  if (scope === 'all' || scope === 'memory') {
    if (knowledgeError) {
      sections.push({ key: 'memory', title: t('search.section.memory'), items: [], state: 'error', message: knowledgeError })
    } else if (knowledgeLoading) {
      sections.push({ key: 'memory', title: t('search.section.memory'), items: [], state: 'loading', message: t('search.loading') })
    } else if (memoryHits.length > 0) {
      sections.push({ key: 'memory', title: t('search.section.memory'), items: memoryHits.slice(0, MAX_SECTION_RESULTS) })
    } else if (scope === 'memory') {
      sections.push({ key: 'memory', title: t('search.section.memory'), items: [], state: 'empty', message: query ? t('search.noMemoryResults') : t('search.typeForMemory') })
    }
  }

  if (scope === 'all' || scope === 'chats') {
    if (chatHits.length > 0) sections.push({ key: 'chat', title: t('search.section.chats'), items: chatHits.slice(0, MAX_SECTION_RESULTS) })
    else if (scope === 'chats') sections.push({ key: 'chat', title: t('search.section.chats'), items: [], state: 'empty', message: t('search.noChatResults') })
  }

  if (scope === 'all' || scope === 'tasks') {
    const combinedTaskHits = [...taskHits, ...knowledgeTaskHits].sort(compareHits)
    if (combinedTaskHits.length > 0) sections.push({ key: 'task', title: t('search.section.tasks'), items: combinedTaskHits.slice(0, MAX_SECTION_RESULTS) })
    else if (scope === 'tasks') sections.push({ key: 'task', title: t('search.section.tasks'), items: [], state: 'empty', message: t('search.noTaskResults') })
  }

  if (scope === 'all' || scope === 'skills') {
    const combinedSkillHits = [...skillHits, ...knowledgeSkillHits].sort(compareHits)
    if (combinedSkillHits.length > 0) sections.push({ key: 'skill', title: t('search.section.skills'), items: combinedSkillHits.slice(0, MAX_SECTION_RESULTS) })
    else if (scope === 'skills') sections.push({ key: 'skill', title: t('search.section.skills'), items: [], state: 'empty', message: t('search.noSkillResults') })
  }

  return sections
}

function buildFileHits({
  activeProject,
  fileItems,
  query,
  t,
}: {
  activeProject: WorkspaceProject
  fileItems: ProjectFileSearchItem[]
  query: string
  t: (path: string, vars?: Record<string, string | number>) => string
}): SearchHit[] {
  return fileItems
    .map((file, index): SearchHit => {
      const title = file.type === 'directory' ? `${file.label}/` : file.label
      const subtitle = file.relativePath
      const titleMatch = scoreText(title, query)
      const subtitleMatch = scoreText(subtitle, query)
      return {
        id: `file:${file.path}`,
        kind: file.type,
        projectId: activeProject.id,
        title,
        subtitle: subtitle || t('search.currentProject'),
        path: file.path,
        score: titleMatch.score * 1.4 + subtitleMatch.score + Math.max(0, 24 - index),
        highlights: buildHighlights(titleMatch, subtitleMatch),
        file,
      }
    })
    .sort(compareHits)
}

function buildThreadHits({
  activeProject,
  includeArchived,
  locale,
  projectScope,
  projects,
  query,
  recentDays,
  t,
  threadRunStates,
  threads,
}: {
  activeProject: WorkspaceProject
  includeArchived: boolean
  locale: string
  projectScope: SearchProjectScope
  projects: WorkspaceProject[]
  query: string
  recentDays: number | undefined
  t: (path: string, vars?: Record<string, string | number>) => string
  threadRunStates: Record<string, ThreadRunState>
  threads: WorkspaceThread[]
}): SearchHit[] {
  return threads
    .filter((thread) => (projectScope === 'all' || thread.projectId === activeProject.id) && (includeArchived || !thread.archivedAt))
    .filter((thread) => !recentDays || thread.updatedAt >= Date.now() - recentDays * 86_400_000)
    .flatMap((thread): SearchHit[] => {
      const threadProject = projects.find((project) => project.id === thread.projectId) ?? activeProject
      const firstPrompt = firstUserPrompt(thread)
      const purpose = threadPurposeLabel(thread, t)
      const titleMatch = scoreText(thread.title, query)
      const fields = [
        scoreText(firstPrompt, query),
        scoreText(thread.skillTitle ?? '', query),
        scoreText(thread.skillCommand ?? '', query),
        scoreText(purpose, query),
        scoreText(threadProject.name, query),
        scoreText(threadProject.path, query),
      ]
      const bestSecondary = fields.reduce((best, item) => (item.score > best.score ? item : best), { score: 0, ranges: [] })
      if (query && titleMatch.score === 0 && bestSecondary.score === 0) return []

      const isTask = thread.purpose === 'task-run'
      const running = Boolean(threadRunStates[thread.id])
      const subtitleParts = [
        projectScope === 'all' && thread.projectId !== activeProject.id ? threadProject.name : '',
        purpose,
        thread.archivedAt ? t('search.archived') : '',
        running ? t('search.running') : '',
        firstPrompt,
        formatDate(thread.updatedAt, locale),
      ].filter(Boolean)
      const score =
        (query ? titleMatch.score * 1.6 + bestSecondary.score : 40) +
        (thread.pinnedAt ? 80 : 0) +
        (running ? 25 : 0) +
        recencyScore(thread.updatedAt) -
        (thread.archivedAt ? 80 : 0)

      return [
        {
          id: `${isTask ? 'task' : 'chat'}:${thread.id}`,
          kind: isTask ? 'task' : 'chat',
          projectId: activeProject.id,
          title: thread.title,
          subtitle: subtitleParts.join(' · '),
          threadId: thread.id,
          score,
          updatedAt: thread.updatedAt,
          highlights: buildHighlights(titleMatch, bestSecondary),
          thread,
        },
      ]
    })
    .sort(compareHits)
}

function buildMessageHits({
  activeProject,
  locale,
  messageItems,
  projectScope,
  query,
  recentDays,
  t,
}: {
  activeProject: WorkspaceProject
  locale: string
  messageItems: ChatHistorySearchItem[]
  projectScope: SearchProjectScope
  query: string
  recentDays: number | undefined
  t: (path: string, vars?: Record<string, string | number>) => string
}): SearchHit[] {
  return messageItems
    .filter((item) => projectScope === 'all' || item.projectId === activeProject.id)
    .filter((item) => !recentDays || item.updatedAt >= Date.now() - recentDays * 86_400_000)
    .map((item): SearchHit => {
      const label = messageDocumentLabel(item, t)
      const dateLabel = formatRelativeTime(item.updatedAt, locale, t)
      const archived = item.archivedAt ? t('search.archived') : ''
      const snippet = compactText(item.snippet || item.body, 180)
      const subtitle = [label, archived, dateLabel, snippet].filter(Boolean).join(' · ')
      const titleMatch = scoreText(item.threadTitle || item.title, query)
      const subtitleMatch = scoreText(subtitle, query)
      return {
        id: item.id,
        kind: 'message',
        projectId: activeProject.id,
        title: item.threadTitle || item.title || t('search.message'),
        subtitle,
        path: item.itemId ? `thread:${item.threadId}#${item.itemId}` : `thread:${item.threadId}`,
        threadId: item.threadId,
        score: item.score + titleMatch.score * 0.2 + subtitleMatch.score * 0.4,
        updatedAt: item.updatedAt,
        highlights: buildHighlights(titleMatch, subtitleMatch),
        message: item,
      }
    })
    .sort(compareHits)
}

function buildKnowledgeHits({
  activeProject,
  knowledgeItems,
  locale,
  projectScope,
  query,
  t,
}: {
  activeProject: WorkspaceProject
  knowledgeItems: AgentKnowledgeSearchItem[]
  locale: string
  projectScope: SearchProjectScope
  query: string
  t: (path: string, vars?: Record<string, string | number>) => string
}): SearchHit[] {
  return knowledgeItems
    .filter((item) => projectScope === 'all' || item.projectId === activeProject.id)
    .map((item): SearchHit => {
      const kindLabel = knowledgeKindLabel(item, t)
      const projectLabel = projectScope === 'all' && item.projectId !== activeProject.id ? item.projectName : ''
      const dateLabel = item.updatedAt ? formatRelativeTime(item.updatedAt, locale, t) : ''
      const snippet = compactText(item.snippet || item.body, 180)
      const subtitle = [kindLabel, projectLabel, item.subtitle, dateLabel, snippet].filter(Boolean).join(' · ')
      const titleMatch = scoreText(item.title, query)
      const subtitleMatch = scoreText(subtitle, query)
      return {
        id: item.id,
        kind: item.kind,
        projectId: item.projectId,
        title: item.title,
        subtitle,
        path: item.path,
        threadId: item.threadId,
        score: item.score + titleMatch.score * 0.2 + subtitleMatch.score * 0.3,
        updatedAt: item.updatedAt,
        highlights: buildHighlights(titleMatch, subtitleMatch),
        knowledge: item,
      } as SearchHit
    })
    .sort(compareHits)
}

function buildSkillHits({
  activeProject,
  projectSkills,
  query,
  t,
}: {
  activeProject: WorkspaceProject
  projectSkills: AgentContextSlashItem[]
  query: string
  t: (path: string, vars?: Record<string, string | number>) => string
}): SearchHit[] {
  return projectSkills
    .flatMap((skill): SearchHit[] => {
      const titleMatch = scoreText(skill.title, query)
      const secondaryMatches = [
        scoreText(skill.description, query),
        scoreText(skill.command, query),
        scoreText(skill.relativePath, query),
      ]
      const bestSecondary = secondaryMatches.reduce((best, item) => (item.score > best.score ? item : best), { score: 0, ranges: [] })
      if (query && titleMatch.score === 0 && bestSecondary.score === 0) return []
      return [
        {
          id: `skill:${skill.path}`,
          kind: 'skill',
          projectId: activeProject.id,
          title: skill.title,
          subtitle: skill.description || skill.relativePath || t('search.skill'),
          path: skill.path,
          score: (query ? titleMatch.score * 1.5 + bestSecondary.score : 35) + (skill.scope === 'project' ? 12 : 0),
          highlights: buildHighlights(titleMatch, bestSecondary),
          skill,
        },
      ]
    })
    .sort(compareHits)
}

function scoreText(value: string | undefined, query: string): TextMatch {
  const source = value ?? ''
  const normalizedSource = normalizeSearchText(source)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return { score: source.trim() ? 1 : 0, ranges: [] }
  if (!normalizedSource) return { score: 0, ranges: [] }
  if (normalizedSource === normalizedQuery) return { score: 320, ranges: [[0, source.length]] }
  const index = normalizedSource.indexOf(normalizedQuery)
  if (index >= 0) {
    const starts = index === 0
    return { score: (starts ? 240 : 160) - Math.min(index, 80), ranges: [[index, index + normalizedQuery.length]] }
  }
  const fuzzy = fuzzyScore(normalizedSource, normalizedQuery)
  return { score: fuzzy, ranges: [] }
}

function fuzzyScore(value: string, query: string): number {
  let lastIndex = -1
  let score = 0
  for (const char of query) {
    const index = value.indexOf(char, lastIndex + 1)
    if (index < 0) return 0
    score += index === lastIndex + 1 ? 16 : 8
    if (index === 0 || '/-_ .'.includes(value[index - 1] ?? '')) score += 8
    lastIndex = index
  }
  return Math.max(0, score - value.length / 8)
}

function compareHits(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title)
}

function recencyScore(updatedAt: number): number {
  if (!Number.isFinite(updatedAt)) return 0
  const ageDays = Math.max(0, Date.now() - updatedAt) / 86_400_000
  return Math.max(0, 40 - ageDays)
}

function firstUserPrompt(thread: WorkspaceThread): string {
  const item = thread.chatState.items.find((item) => item.type === 'message' && item.role === 'user')
  if (!item || item.type !== 'message') return ''
  return compactText(item.content, 120)
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`
}

function threadPurposeLabel(thread: WorkspaceThread, t: (path: string) => string): string {
  if (thread.purpose === 'home-plugin-customization') return t('search.purpose.homePlugin')
  if (thread.purpose === 'home-plugin-card-customization') return t('search.purpose.homePluginCard')
  if (thread.purpose === 'task-run') return t('search.purpose.task')
  if (thread.purpose === 'skill-run') return thread.skillTitle || t('search.purpose.skill')
  return t('search.purpose.chat')
}

function messageDocumentLabel(item: ChatHistorySearchItem, t: (path: string) => string): string {
  if (item.documentKind === 'thread') return t('search.messageKind.thread')
  if (item.documentKind === 'tool') return t('search.messageKind.tool')
  if (item.documentKind === 'activity') return t('search.messageKind.activity')
  if (item.role === 'user') return t('search.messageKind.user')
  if (item.role === 'assistant') return t('search.messageKind.assistant')
  return t('search.message')
}

function knowledgeKindLabel(item: AgentKnowledgeSearchItem, t: (path: string) => string): string {
  return t(`search.knowledgeKind.${item.kind}`)
}

function actionLabelForHit(hit: SearchHit, t: (path: string) => string): string {
  if (hit.kind === 'file') return t('search.action.openFile')
  if (hit.kind === 'directory') return t('search.action.openDirectory')
  if (hit.kind === 'message') return t('search.action.openMessage')
  if ('knowledge' in hit) {
    if (hit.kind === 'memory') return t('search.action.openMemory')
    if (hit.kind === 'skill' || hit.kind === 'command') return t('search.action.runSkill')
    if ((hit.kind === 'task' || hit.kind === 'home-plugin') && hit.knowledge.threadId) return t('search.action.continueThread')
    if (hit.kind === 'agent') return t('search.action.addContext')
    return t('search.action.askAgent')
  }
  if (hit.kind === 'skill') return t('search.action.runSkill')
  return t('search.action.openChat')
}

function iconForHit(hit: SearchHit): 'checklist' | 'file' | 'folder' | 'message' | 'play' | 'search' {
  if (hit.kind === 'directory') return 'folder'
  if (hit.kind === 'file') return 'file'
  if (hit.kind === 'memory') return 'file'
  if (hit.kind === 'agent' || hit.kind === 'command' || hit.kind === 'home-plugin') return 'search'
  if (hit.kind === 'skill') return 'play'
  if (hit.kind === 'task') return 'checklist'
  return 'message'
}

function buildHighlights(titleMatch: TextMatch, subtitleMatch: TextMatch): AppSearchHighlightRange[] {
  const highlights: AppSearchHighlightRange[] = []
  if (titleMatch.ranges.length > 0) highlights.push({ field: 'title', ranges: titleMatch.ranges })
  if (subtitleMatch.ranges.length > 0) highlights.push({ field: 'subtitle', ranges: subtitleMatch.ranges })
  return highlights
}

function highlightText(text: string, highlights: AppSearchHighlightRange[] | undefined, field: AppSearchHighlightRange['field']): ReactNode {
  const ranges = highlights?.find((item) => item.field === field)?.ranges ?? []
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const nodes: ReactNode[] = []
  let cursor = 0
  sorted.forEach(([start, end], index) => {
    const safeStart = Math.max(cursor, Math.min(text.length, start))
    const safeEnd = Math.max(safeStart, Math.min(text.length, end))
    if (safeStart > cursor) nodes.push(text.slice(cursor, safeStart))
    if (safeEnd > safeStart) nodes.push(<mark key={`${field}-${index}`}>{text.slice(safeStart, safeEnd)}</mark>)
    cursor = safeEnd
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/')
}

function formatDate(value: number, locale: string): string {
  if (!Number.isFinite(value)) return ''
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatRelativeTime(value: number, locale: string, t: (path: string, vars?: Record<string, string | number>) => string): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const deltaMs = value - Date.now()
  const absMs = Math.abs(deltaMs)
  const rtf = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { numeric: 'auto' })
  if (absMs < 60_000) return t('search.justNow')
  if (absMs < 3_600_000) return rtf.format(Math.round(deltaMs / 60_000), 'minute')
  if (absMs < 86_400_000) return rtf.format(Math.round(deltaMs / 3_600_000), 'hour')
  if (absMs < 30 * 86_400_000) return rtf.format(Math.round(deltaMs / 86_400_000), 'day')
  return formatDate(value, locale)
}
