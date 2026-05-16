/**
 * 空状态起始卡片网格（快捷提示插入 Composer）。
 * Empty-state starter grid feeding canned prompts into the composer.
 */

import type { ReactNode } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { WorkspaceProject } from '../types'

type ChatStartViewProps = {
  project: WorkspaceProject
  composer: ReactNode
  onUseSuggestion: (prompt: string) => void
}

type StartCard = {
  id: string
  icon: 'files' | 'branch' | 'chip'
  titleKey: string
  descriptionKey: string
  promptKey: string
}

const START_CARDS: StartCard[] = [
  {
    id: 'plan',
    icon: 'files',
    titleKey: 'chat.startCardPlanTitle',
    descriptionKey: 'chat.startCardPlanDesc',
    promptKey: 'chat.startCardPlanPrompt',
  },
  {
    id: 'refactor',
    icon: 'branch',
    titleKey: 'chat.startCardRefactorTitle',
    descriptionKey: 'chat.startCardRefactorDesc',
    promptKey: 'chat.startCardRefactorPrompt',
  },
  {
    id: 'agent',
    icon: 'chip',
    titleKey: 'chat.startCardAgentTitle',
    descriptionKey: 'chat.startCardAgentDesc',
    promptKey: 'chat.startCardAgentPrompt',
  },
]

/** 项目主页空状态 / Project home empty rail */
export function ChatStartView({ project, composer, onUseSuggestion }: ChatStartViewProps) {
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
        <div className="chat-start-view__cards" aria-label={t('chat.startCardsAria')}>
          {START_CARDS.map((card) => {
            const prompt = t(card.promptKey)
            return (
              <button
                key={card.id}
                type="button"
                className="chat-start-card"
                onClick={() => onUseSuggestion(prompt)}
              >
                <span className="chat-start-card__icon" aria-hidden="true">
                  <IconInline name={card.icon} />
                </span>
                <span className="chat-start-card__copy">
                  <span>{t(card.titleKey)}</span>
                  <span>{t(card.descriptionKey)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
