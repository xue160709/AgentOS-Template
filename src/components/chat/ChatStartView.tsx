/**
 * 空状态起始卡片网格（快捷提示插入 Composer）。
 * Empty-state starter grid feeding canned prompts into the composer.
 */

import type { ReactNode } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { HomePluginRunItem } from '../../desktop-types'
import type { ProjectSkillRunRequest, ThreadRunState, WorkspaceProject, WorkspaceThread } from '../types'
import { ProjectHomeSurface } from './ProjectHomeSurface'

type ChatStartViewProps = {
  project: WorkspaceProject
  composer: ReactNode
  agentModeEnabled: boolean
  todoEnabled: boolean
  agentModeLoading: boolean
  threads: WorkspaceThread[]
  threadRunStates: Record<string, ThreadRunState>
  hiddenSkillPaths: string[]
  heading?: string
  onStartDataCardDraft: () => void
  onEditHomePluginCard: (item: HomePluginRunItem) => void
  onRunProjectSkill: (projectId: string, skill: ProjectSkillRunRequest) => void
  onStopProjectSkillRun: (projectId: string, skillPath: string) => void
}

/** 项目主页空状态 / Project home empty rail */
export function ChatStartView({
  project,
  composer,
  agentModeEnabled,
  todoEnabled,
  agentModeLoading,
  threads,
  threadRunStates,
  hiddenSkillPaths,
  heading,
  onStartDataCardDraft,
  onEditHomePluginCard,
  onRunProjectSkill,
  onStopProjectSkillRun,
}: ChatStartViewProps) {
  const { t } = useI18n()

  return (
    <div className="chat-start-view">
      {project.pathMissing ? (
        <div className="project-path-missing-banner" role="status">
          <strong>{t('shell.projectPathMissing')}</strong>
          <p>{t('shell.projectPathMissingHint')}</p>
        </div>
      ) : null}
      <div className="chat-start-view__hero" id="chat-project-home">
        <h1>{heading ?? t('chat.emptyHeading')}</h1>
      </div>
      {composer}
      <div className="chat-start-view__below-composer">
        {agentModeEnabled ? (
          <ProjectHomeSurface
            project={project}
            todoEnabled={todoEnabled}
            loading={agentModeLoading}
            threads={threads}
            threadRunStates={threadRunStates}
            hiddenSkillPaths={hiddenSkillPaths}
            onStartDataCardDraft={onStartDataCardDraft}
            onEditHomePluginCard={onEditHomePluginCard}
            onRunProjectSkill={onRunProjectSkill}
            onStopProjectSkillRun={onStopProjectSkillRun}
          />
        ) : (
          <div className="chat-start-view__project" title={project.path}>
            <IconInline name="folder" />
            <span>{project.name}</span>
          </div>
        )}
      </div>
    </div>
  )
}
