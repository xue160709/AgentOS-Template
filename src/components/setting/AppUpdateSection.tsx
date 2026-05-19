/**
 * 设置 · 常规：应用版本与 GitHub Releases 更新。
 * General settings: app version and GitHub Releases updates.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppUpdaterState } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
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
        return t('settings.general.updateDownloading', {
          percent: Math.round(state.percent ?? 0),
          transferred: formatBytes(state.transferred),
          total: formatBytes(state.total),
        })
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

  const showDownload = state?.phase === 'error' && Boolean(state.availableVersion)
  const showInstall = state?.phase === 'downloaded'
  const showCheck = !showInstall && state?.phase !== 'downloading' && state?.phase !== 'available'

  const currentVersion = state?.currentVersion ?? '—'
  const downloadPercent = Math.max(0, Math.min(100, Math.round(state?.percent ?? 0)))

  return (
    <section className="settings-section" aria-labelledby="settings-section-update-heading">
      <h2 id="settings-section-update-heading" className="settings-section-heading">
        {t('settings.general.updateHeading')}
      </h2>
      <p className="settings-section-caption">{t('settings.general.updateCaption')}</p>
      <div className="settings-group">
        <div className="settings-field-row">
          <div className="settings-field-row__meta">
            <p className="settings-field-row__label">{t('settings.general.updateCurrentVersion')}</p>
            <p className="settings-field-row__hint" role="status">
              {currentVersion}
              {!updaterAvailable ? ` · ${t('settings.general.updateDevHint')}` : null}
            </p>
          </div>
        </div>

        {updaterAvailable ? (
          <>
            <p className="settings-switch-status" role="status">
              {statusText}
            </p>
            {state?.phase === 'downloading' ? (
              <div className="settings-update-progress" aria-hidden="true">
                <span style={{ width: `${downloadPercent}%` }} />
              </div>
            ) : null}
            {state?.releaseNotes ? (
              <pre className="settings-update-notes">{state.releaseNotes}</pre>
            ) : null}
            <div className="settings-restart-dialog__actions settings-update-actions">
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
          </>
        ) : null}
      </div>
    </section>
  )
}
