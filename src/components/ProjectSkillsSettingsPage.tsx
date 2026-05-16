import { IconInline } from '../icon-inline'

type ProjectSkillsSettingsPageProps = {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}

export function ProjectSkillsSettingsPage({ enabled, onEnabledChange }: ProjectSkillsSettingsPageProps) {
  return (
    <section className="app-main-inner settings-page settings-page--models" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">常规</h1>
        <p className="settings-lede">
          与应用相关的通用选项。
        </p>
      </header>

      <div className="settings-stack">
        <section className="settings-section" aria-labelledby="settings-section-project-skills-heading">
          <h2 id="settings-section-project-skills-heading" className="settings-section-heading">
            项目 Skills
          </h2>
          <p className="settings-section-caption">
            开启后，每个项目会在对话历史上方列出项目目录中的 skills，并与对话历史用分割线区分。
          </p>
          <div className="settings-group">
            <label className="settings-switch-row">
              <span className="settings-field-row__meta">
                <span className="settings-field-row__label">
                  <IconInline name="chip" />
                  显示项目 Skills
                </span>
                <span className="settings-field-row__hint">
                  只显示项目级 skill 条目；点击后会新建对话并发送对应 slash command。
                </span>
              </span>
              <span className="settings-switch-control">
                <input
                  type="checkbox"
                  className="settings-switch-input"
                  checked={enabled}
                  onChange={(event) => onEnabledChange(event.target.checked)}
                />
                <span className="settings-switch-track" aria-hidden="true">
                  <span className="settings-switch-thumb" />
                </span>
              </span>
            </label>
          </div>
          <p className="settings-switch-status" role="status">
            {enabled ? '已开启，侧边栏会显示项目 skills。' : '已关闭，侧边栏只显示项目和对话历史。'}
          </p>
        </section>
      </div>
    </section>
  )
}
