/**
 * 文档占位视图（主导航「Docs」）。
 * Placeholder docs surface reachable from primary navigation.
 */

import { useI18n } from '../i18n/i18n'

type DocsPageProps = { hidden: boolean }

/** Shell 内文档面板 / Docs route panel inside AppShell */
export function DocsPage({ hidden }: DocsPageProps) {
  const { t } = useI18n()
  return (
    <section className="app-main-inner" id="panel-docs" hidden={hidden} aria-hidden={hidden}>
      <div className="app-main-eyebrow">{t('docs.eyebrow')}</div>
      <h1 className="app-main-heading">{t('docs.heading')}</h1>
      <section className="app-panel">
        <p className="text-token-secondary" style={{ margin: 0 }}>
          {t('docs.placeholder')}
        </p>
      </section>
    </section>
  )
}
