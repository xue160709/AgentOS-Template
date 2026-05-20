/**
 * 设置 · 关于：作者、联系方式与许可证。
 * Settings · About: author, contact, and license.
 */

import { useEffect, useState } from 'react'
import { APP_METADATA } from '../../app-metadata'
import { useI18n } from '../../i18n/i18n'

export function AboutSection() {
  const { t } = useI18n()
  const [version, setVersion] = useState<string>('—')

  useEffect(() => {
    const updater = window.desktop
    if (!updater?.getAppUpdaterState) return
    void updater.getAppUpdaterState().then((state) => {
      if (state.currentVersion) setVersion(state.currentVersion)
    })
  }, [])

  const githubUrl = APP_METADATA.homepage

  return (
    <section className="settings-section" aria-labelledby="settings-section-about-heading">
      <h2 id="settings-section-about-heading" className="settings-section-heading">
        {t('settings.about.heading')}
      </h2>
      <p className="settings-section-caption">{t('settings.about.caption')}</p>
      <div className="settings-about-panel">
        <dl className="settings-about-list">
          <div className="settings-about-row">
            <dt>{t('settings.about.email')}</dt>
            <dd>
              <a href={`mailto:${APP_METADATA.authorEmail}`}>{APP_METADATA.authorEmail}</a>
            </dd>
          </div>
          <div className="settings-about-row">
            <dt>{t('settings.about.github')}</dt>
            <dd>
              <a href={githubUrl} target="_blank" rel="noreferrer">
                github.com/{APP_METADATA.githubOwner}/{APP_METADATA.githubRepo}
              </a>
            </dd>
          </div>
          <div className="settings-about-row">
            <dt>{t('settings.about.license')}</dt>
            <dd>{APP_METADATA.license}</dd>
          </div>
          <div className="settings-about-row">
            <dt>{t('settings.about.copyright')}</dt>
            <dd>© {APP_METADATA.copyrightYear} {APP_METADATA.authorName}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}
