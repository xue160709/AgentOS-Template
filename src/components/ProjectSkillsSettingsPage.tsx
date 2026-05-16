import { useCallback, useEffect, useRef, useState } from 'react'
import { IconInline } from '../icon-inline'
import { getInitialLocale, LOCALE_STORAGE_KEY, useI18n, type AppLocale } from '../i18n/i18n'

type ProjectSkillsSettingsPageProps = {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}

export function ProjectSkillsSettingsPage({ enabled, onEnabledChange }: ProjectSkillsSettingsPageProps) {
  const { locale: sessionLocale, t } = useI18n()
  const [pickerLocale, setPickerLocale] = useState<AppLocale>(() => getInitialLocale())
  const [languageRestartDialogOpen, setLanguageRestartDialogOpen] = useState(false)
  const languageRestartDialogRef = useRef<HTMLDialogElement>(null)
  const [closeToTray, setCloseToTray] = useState(false)
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [desktopPrefsHydrated, setDesktopPrefsHydrated] = useState(false)

  const desktopPrefsAvailable = typeof window !== 'undefined' && typeof window.desktop?.getDesktopPreferences === 'function'

  useEffect(() => {
    if (!desktopPrefsAvailable) return
    let cancelled = false
    void window.desktop?.getDesktopPreferences?.().then((prefs) => {
      if (cancelled) return
      setCloseToTray(prefs.closeToTray)
      setOpenAtLogin(prefs.openAtLogin)
      setDesktopPrefsHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [desktopPrefsAvailable])

  useEffect(() => {
    void window.desktop?.setDesktopPreferences?.({ locale: pickerLocale })
    void window.desktop?.syncTrayLocale?.(pickerLocale)
  }, [pickerLocale])

  const requestQuit = useCallback(() => {
    const quit = window.desktop?.quitApp
    if (quit) {
      void quit()
      return
    }
    window.close()
  }, [])

  const onCloseToTrayChange = useCallback((next: boolean) => {
    setCloseToTray(next)
    void window.desktop?.setDesktopPreferences?.({ closeToTray: next })
  }, [])

  const onOpenAtLoginChange = useCallback((next: boolean) => {
    setOpenAtLogin(next)
    void window.desktop?.setDesktopPreferences?.({ openAtLogin: next })
  }, [])

  useEffect(() => {
    const el = languageRestartDialogRef.current
    if (!el) return
    if (languageRestartDialogOpen) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      el.close()
    }
  }, [languageRestartDialogOpen])

  useEffect(() => {
    if (pickerLocale === sessionLocale && languageRestartDialogOpen) {
      setLanguageRestartDialogOpen(false)
    }
  }, [pickerLocale, sessionLocale, languageRestartDialogOpen])

  const handleLocaleSelectChange = useCallback(
    (next: AppLocale) => {
      if (next === pickerLocale) return
      setPickerLocale(next)
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next)
      } catch {
        /* ignore */
      }
      void window.desktop?.setDesktopPreferences?.({ locale: next })
      if (next !== sessionLocale) {
        setLanguageRestartDialogOpen(true)
      }
    },
    [pickerLocale, sessionLocale],
  )

  return (
    <section className="app-main-inner settings-page settings-page--models" id="panel-settings" aria-hidden={false}>
      <header className="settings-page-header">
        <h1 className="app-main-heading">{t('settings.general.pageTitle')}</h1>
        <p className="settings-lede">{t('settings.general.pageLede')}</p>
      </header>

      <div className="settings-stack">
        <section className="settings-section" aria-labelledby="settings-section-language-heading">
          <h2 id="settings-section-language-heading" className="settings-section-heading">
            {t('settings.general.languageHeading')}
          </h2>
          <div className="settings-group">
            <div className="settings-select-row">
              <div className="settings-field-row__meta">
                <p className="settings-select-row__lede">{t('settings.general.languageCaption')}</p>
              </div>
              <div className="settings-select-wrap">
                <select
                  id="settings-locale-select"
                  className="settings-input settings-select"
                  value={pickerLocale}
                  aria-labelledby="settings-section-language-heading"
                  onChange={(event) => handleLocaleSelectChange(event.target.value as AppLocale)}
                >
                  <option value="zh">{t('settings.general.languageZh')}</option>
                  <option value="en">{t('settings.general.languageEn')}</option>
                </select>
                <span className="settings-select-wrap__chevron" aria-hidden>
                  <IconInline name="chevron" />
                </span>
              </div>
            </div>
          </div>
          <dialog
            ref={languageRestartDialogRef}
            className="settings-restart-dialog"
            aria-labelledby="settings-language-restart-title"
            onClose={() => setLanguageRestartDialogOpen(false)}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                languageRestartDialogRef.current?.close()
              }
            }}
          >
            <div className="settings-restart-dialog__panel" onClick={(event) => event.stopPropagation()}>
              <h3 id="settings-language-restart-title" className="settings-restart-dialog__title">
                {t('settings.general.languageRestartTitle')}
              </h3>
              <p className="settings-restart-dialog__body">{t('settings.general.languageRestartHint')}</p>
              <div className="settings-restart-dialog__actions">
                <button type="button" className="btn btn-ghost" onClick={() => languageRestartDialogRef.current?.close()}>
                  {t('settings.general.languageRestartLater')}
                </button>
                <button type="button" className="btn btn-primary" onClick={requestQuit}>
                  {t('settings.general.quitApp')}
                </button>
              </div>
            </div>
          </dialog>
        </section>

        {desktopPrefsAvailable ? (
          <section className="settings-section" aria-labelledby="settings-section-desktop-heading">
            <h2 id="settings-section-desktop-heading" className="settings-section-heading">
              {t('settings.general.desktopHeading')}
            </h2>
            <div className="settings-group">
              <label className="settings-switch-row">
                <span className="settings-field-row__meta">
                  <span className="settings-field-row__label">{t('settings.general.closeToTray')}</span>
                  <span className="settings-field-row__hint">{t('settings.general.closeToTrayHint')}</span>
                </span>
                <span className="settings-switch-control">
                  <input
                    type="checkbox"
                    className="settings-switch-input"
                    checked={closeToTray}
                    disabled={!desktopPrefsHydrated}
                    onChange={(event) => onCloseToTrayChange(event.target.checked)}
                  />
                  <span className="settings-switch-track" aria-hidden="true">
                    <span className="settings-switch-thumb" />
                  </span>
                </span>
              </label>
              <label className="settings-switch-row">
                <span className="settings-field-row__meta">
                  <span className="settings-field-row__label">{t('settings.general.openAtLogin')}</span>
                  <span className="settings-field-row__hint">{t('settings.general.openAtLoginHint')}</span>
                </span>
                <span className="settings-switch-control">
                  <input
                    type="checkbox"
                    className="settings-switch-input"
                    checked={openAtLogin}
                    disabled={!desktopPrefsHydrated}
                    onChange={(event) => onOpenAtLoginChange(event.target.checked)}
                  />
                  <span className="settings-switch-track" aria-hidden="true">
                    <span className="settings-switch-thumb" />
                  </span>
                </span>
              </label>
            </div>
          </section>
        ) : null}

        <section className="settings-section" aria-labelledby="settings-section-project-skills-heading">
          <h2 id="settings-section-project-skills-heading" className="settings-section-heading">
            {t('settings.general.projectSkillsHeading')}
          </h2>
          <p className="settings-section-caption">{t('settings.general.projectSkillsCaption')}</p>
          <div className="settings-group">
            <label className="settings-switch-row">
              <span className="settings-field-row__meta">
                <span className="settings-field-row__label">
                  <IconInline name="chip" />
                  {t('settings.general.showProjectSkills')}
                </span>
                <span className="settings-field-row__hint">{t('settings.general.showProjectSkillsHint')}</span>
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
            {enabled ? t('settings.general.statusOn') : t('settings.general.statusOff')}
          </p>
        </section>
      </div>
    </section>
  )
}
