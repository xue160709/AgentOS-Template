/**
 * 空状态起始卡片网格（快捷提示插入 Composer）。
 * Empty-state starter grid feeding canned prompts into the composer.
 */

import type { ReactNode } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { WorkspaceProject } from '../types'
import { ProjectHomeSurface } from './ProjectHomeSurface'

type ChatStartViewProps = {
  project: WorkspaceProject
  composer: ReactNode
  onCustomizeHome: () => void
}

/** 项目主页空状态 / Project home empty rail */
export function ChatStartView({ project, composer, onCustomizeHome }: ChatStartViewProps) {
  const { t } = useI18n()

  return (
    <div className="chat-start-view">
      <div className="chat-start-view__hero" id="chat-project-home">
        <h1>{t('chat.emptyHeading')}</h1>
      </div>
      {composer}
      <div className="chat-start-view__below-composer">
        <div className="chat-start-view__project" title={project.path}>
          <IconInline name="folder" />
          <span>{project.name}</span>
        </div>
        <ProjectHomeSurface project={project} onCustomizeHome={onCustomizeHome} />
      </div>
    </div>
  )
}
