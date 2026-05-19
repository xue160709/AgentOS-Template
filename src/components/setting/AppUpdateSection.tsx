/**
 * 设置 · 常规：应用版本与 GitHub Releases 更新。
 * General settings: app version and GitHub Releases updates.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppUpdaterState } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'

export function AppUpdateSection() {
  const { t } = useI18n()
  const [state, setState] = useState<AppUpdaterState | null>(null)
  const [busy, setBusy] = useState(false)

  const desktopUpdaterReady =
    typeof window !== 'undefined' &&
    typeof window.desktop?.getAppUpdaterState === 'function' &&
    typeof window.desktop?.checkForAppUpdates === 'function'
  const updaterAvailable = desktopUpdaterReady && state?.updatesSupported === true

  const applyState = useCallback((next: AppUpdaterState) => {
    setState(next)
  }, [])

  useEffect(() => {
    if (!desktopUpdaterReady) return
    const unsubscribe = window.desktop?.onAppUpdaterState?.((next) => {
      applyState(next)
    })
    return () => {
      unsubscribe?.()
    }
  }, [applyState, desktopUpdaterReady])

  useEffect(() => {
    if (!desktopUpdaterReady) return
    let cancelled = false
    void window.desktop?.getAppUpdaterState?.().then((next) => {
      if (!cancelled) applyState(next)
    })
    return () => {
      cancelled = true
    }
  }, [applyState, desktopUpdaterReady])

  const statusText = useMemo(() => {
    if (!state) return t('settings.general.updateLoading')
    switch (state.phase) {
      case 'checking':
        return t('settings.general.updateChecking')
      case 'available':
        return t('settings.general.updateAvailable', { version: state.availableVersion ?? '' })
      case 'not-available':
        return t('settings.general.updateNotAvailable')
      case 'downloading':
        return t('settings.general.updateDownloading')
      case 'downloaded':
        return t('settings.general.updateDownloaded', { version: state.availableVersion ?? '' })
      case 'error':
        return state.errorMessage || t('settings.general.updateError')
      default:
        return t('settings.general.updateIdle')
    }
  }, [state, t])

  const onCheck = useCallback(async () => {
    if (!window.desktop?.checkForAppUpdates) return
    setBusy(true)
    try {
      const next = await window.desktop.checkForAppUpdates()
      applyState(next)
    } finally {
      setBusy(false)
    }
  }, [applyState])

  const onDownload = useCallback(async () => {
    if (!window.desktop?.downloadAppUpdate) return
    setBusy(true)
    try {
      const next = await window.desktop.downloadAppUpdate()
      applyState(next)
    } finally {
      setBusy(false)
    }
  }, [applyState])

  const onInstall = useCallback(() => {
    void window.desktop?.quitAndInstallAppUpdate?.()
  }, [])

  const showDownload = updaterAvailable && state?.phase === 'error' && Boolean(state.availableVersion)
  const showInstall = updaterAvailable && state?.phase === 'downloaded'
  const showCheck =
    updaterAvailable &&
    !showInstall &&
    !showDownload &&
    state?.phase !== 'checking' &&
    state?.phase !== 'downloading' &&
    state?.phase !== 'available'
  const hasUpdateAction = showCheck || showDownload || showInstall

  const currentVersion = state?.currentVersion ?? '—'
  const statusTone =
    state?.phase === 'downloaded'
      ? 'is-ready'
      : state?.phase === 'error'
        ? 'is-error'
        : state?.phase === 'not-available'
          ? 'is-current'
          : state?.phase === 'checking' || state?.phase === 'available' || state?.phase === 'downloading'
            ? 'is-active'
            : 'is-idle'

  return (
    <section className="settings-section" aria-labelledby="settings-section-update-heading">
      <h2 id="settings-section-update-heading" className="settings-section-heading">
        {t('settings.general.updateHeading')}
      </h2>
      <p className="settings-section-caption">{t('settings.general.updateCaption')}</p>
      <div className="settings-update-panel">
        <div className="settings-update-overview">
          <div className="settings-update-version-block">
            <p className="settings-update-kicker">{t('settings.general.updateCurrentVersion')}</p>
            <p className="settings-update-version">{currentVersion}</p>
            {!updaterAvailable ? <p className="settings-update-dev-hint">{t('settings.general.updateDevHint')}</p> : null}
          </div>
          <div className={`settings-update-status ${statusTone}`} role="status" aria-live="polite">
            <span className="settings-update-status-dot" aria-hidden="true" />
            <p>{statusText}</p>
          </div>
        </div>

        {updaterAvailable ? (
          <>
            {state?.releaseNotes ? (
              <pre className="settings-update-notes">{state.releaseNotes}</pre>
            ) : null}
            {hasUpdateAction ? (
              <div className="settings-update-actions">
                {showCheck ? (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onCheck()}>
                    {t('settings.general.updateCheck')}
                  </button>
                ) : null}
                {showDownload ? (
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onDownload()}>
                    {t('settings.general.updateDownload')}
                  </button>
                ) : null}
                {showInstall ? (
                  <button type="button" className="btn btn-primary" onClick={onInstall}>
                    {t('settings.general.updateInstall')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
