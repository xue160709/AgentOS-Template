/**
 * 设置 · 常规：应用版本与 GitHub Releases 更新。
 * General settings: app version and GitHub Releases updates.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppUpdaterState } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'

const DOWNLOAD_PROGRESS_MAX = 100

function getProgressPercent(percent?: number): number | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  return Math.min(DOWNLOAD_PROGRESS_MAX, Math.max(0, percent))
}

function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`
}

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(maximumFractionDigits)} ${units[unitIndex]}`
}

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

  const progressPercent = getProgressPercent(state?.percent)
  const progressPercentLabel = progressPercent === null ? null : formatPercent(progressPercent)
  const progressTransferred = formatBytes(state?.transferred)
  const progressTotal = formatBytes(state?.total)
  const progressSpeed = formatBytes(state?.bytesPerSecond)
  const progressTitle = progressPercentLabel
    ? t('settings.general.updateDownloadProgress', { percent: progressPercentLabel })
    : t('settings.general.updateDownloadProgressUnknown')
  const progressMeta = [
    progressTransferred && progressTotal
      ? t('settings.general.updateDownloadSize', { transferred: progressTransferred, total: progressTotal })
      : progressTransferred
        ? t('settings.general.updateDownloadTransferred', { transferred: progressTransferred })
        : null,
    progressSpeed ? t('settings.general.updateDownloadSpeed', { speed: progressSpeed }) : null,
  ].filter(Boolean)
  const showProgress = updaterAvailable && state?.phase === 'downloading'

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
            <div className="settings-update-status-content">
              <p>{statusText}</p>
              {showProgress ? (
                <div
                  className="settings-update-progress"
                  role="progressbar"
                  aria-label={progressTitle}
                  aria-valuemin={0}
                  aria-valuemax={DOWNLOAD_PROGRESS_MAX}
                  aria-valuenow={progressPercent === null ? undefined : Math.round(progressPercent)}
                >
                  <div className="settings-update-progress-copy">
                    <span>{progressTitle}</span>
                    {progressMeta.length > 0 ? <span>{progressMeta.join(' - ')}</span> : null}
                  </div>
                  <div
                    className={`settings-update-progress-track${progressPercent === null ? ' is-indeterminate' : ''}`}
                    aria-hidden="true"
                  >
                    <span
                      className="settings-update-progress-fill"
                      style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
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
