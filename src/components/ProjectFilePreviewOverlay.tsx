/**
 * 项目文件预览浮层：只覆盖中央工作区，不进入左右侧栏。
 * Project file preview overlay scoped to the center workspace only.
 */

import { useEffect, useMemo } from 'react'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import type { ProjectFilePreviewResult } from './types'
import { renderMarkdown } from './chat/markdown'

type ProjectFilePreviewReady = Extract<ProjectFilePreviewResult, { ok: true }>

export type ProjectFilePreviewOverlayState =
  | {
      status: 'loading'
      path: string
      relativePath: string
      name: string
    }
  | {
      status: 'ready'
      file: ProjectFilePreviewReady
    }
  | {
      status: 'error'
      path: string
      relativePath?: string
      name?: string
      message: string
    }

type ProjectFilePreviewOverlayProps = {
  preview: ProjectFilePreviewOverlayState
  onClose: () => void
}

export function ProjectFilePreviewOverlay({ preview, onClose }: ProjectFilePreviewOverlayProps) {
  const { t } = useI18n()
  const title = preview.status === 'ready' ? preview.file.name : preview.name || t('filePanel.previewTitle')
  const relativePath = preview.status === 'ready' ? preview.file.relativePath : preview.relativePath
  const kind = preview.status === 'ready' ? preview.file.kind : null
  const size = preview.status === 'ready' ? preview.file.size : null
  const markdownHtml = useMemo(() => {
    if (preview.status !== 'ready' || preview.file.kind !== 'markdown') return ''
    return renderMarkdown(preview.file.content ?? '')
  }, [preview])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onClose])

  return (
    <div className="project-file-preview-overlay" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="project-file-preview-panel" role="dialog" aria-labelledby="project-file-preview-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="project-file-preview-header">
          <div className="project-file-preview-title-block">
            <span className="project-file-preview-title-icon">
              <IconInline name={kind === 'image' ? 'image' : 'file'} />
            </span>
            <div className="project-file-preview-title-text">
              <h2 id="project-file-preview-title">{title}</h2>
              {relativePath ? <span title={relativePath}>{relativePath}</span> : null}
            </div>
          </div>
          <div className="project-file-preview-actions">
            {kind ? <span className="project-file-preview-chip">{previewKindLabel(kind, t)}</span> : null}
            {size !== null ? <span className="project-file-preview-chip">{formatBytes(size)}</span> : null}
            <button
              type="button"
              className="btn btn-toolbar project-file-preview-close"
              title={t('filePanel.previewCloseTitle')}
              aria-label={t('filePanel.previewCloseAria')}
              onClick={onClose}
            >
              <IconInline name="x" />
            </button>
          </div>
        </header>

        <div className="project-file-preview-content">
          {preview.status === 'loading' ? (
            <div className="project-file-preview-state" role="status">
              {t('filePanel.previewLoading')}
            </div>
          ) : null}

          {preview.status === 'error' ? (
            <div className="project-file-preview-state is-error" role="alert">
              <IconInline name="file" />
              <span>{preview.message}</span>
            </div>
          ) : null}

          {preview.status === 'ready' && preview.file.kind === 'image' ? (
            preview.file.dataUrl ? (
              <div className="project-file-preview-image-stage">
                <img src={preview.file.dataUrl} alt={preview.file.name} />
              </div>
            ) : (
              <div className="project-file-preview-state is-error" role="alert">
                {t('filePanel.previewUnavailable')}
              </div>
            )
          ) : null}

          {preview.status === 'ready' && preview.file.kind === 'markdown' ? (
            <article className="markdown-body project-file-preview-markdown" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          ) : null}

          {preview.status === 'ready' && (preview.file.kind === 'text' || preview.file.kind === 'json') ? (
            <pre className={`project-file-preview-text${preview.file.kind === 'json' ? ' is-json' : ''}`}>{preview.file.content ?? ''}</pre>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function previewKindLabel(kind: ProjectFilePreviewReady['kind'], t: (path: string) => string): string {
  if (kind === 'markdown') return t('filePanel.previewMarkdown')
  if (kind === 'json') return t('filePanel.previewJson')
  if (kind === 'image') return t('filePanel.previewImage')
  return t('filePanel.previewText')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
