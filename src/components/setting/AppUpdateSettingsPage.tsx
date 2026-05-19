/**
 * 设置 · 版本更新：独立承载自动下载与安装入口。
 * Settings · Version updates: dedicated update download and install surface.
 */

import { useI18n } from '../../i18n/i18n'
import { AppUpdateSection } from './AppUpdateSection'

/** `#settings/updates` 应用更新设置页 / App update settings route */
export function AppUpdateSettingsPage() {
  const { t } = useI18n()

  return (
    <section className="app-main-inner settings-page" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">{t('settings.updates.pageTitle')}</h1>
        <p className="settings-lede">{t('settings.updates.pageLede')}</p>
      </header>

      <div className="settings-stack">
        <AppUpdateSection />
      </div>
    </section>
  )
}
