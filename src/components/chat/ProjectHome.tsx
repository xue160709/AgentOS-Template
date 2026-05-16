import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { WorkspaceProject } from '../types'

type ProjectHomeProps = {
  project: WorkspaceProject
}

export function ProjectHome({ project }: ProjectHomeProps) {
  const { t } = useI18n()

  return (
    <div className="chat-project-home" id="chat-project-home">
      <div className="chat-project-home__eyebrow" title={project.path}>
        <IconInline name="folder" />
        <span>{project.name}</span>
      </div>
      <h1>{t('chat.emptyHeading')}</h1>
    </div>
  )
}
