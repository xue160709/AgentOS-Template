/**
 * A2UI-backed project home surface rendered from a per-project Home Plugin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { A2uiSurface, basicCatalog, MarkdownContext, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import { MessageProcessor, type A2uiClientAction, type A2uiMessage, type SurfaceModel } from '@a2ui/web_core/v0_9'
import { renderMarkdown } from './markdown'
import type { WorkspaceProject } from '../types'

type ProjectHomeSurfaceProps = {
  project: WorkspaceProject
  onCustomizeHome: () => void
}

const messageCache = new Map<string, { outputHash: string; messages: A2uiMessage[] }>()

/** Runs the project Home Plugin and renders its A2UI v0.9 surface. */
export function ProjectHomeSurface({ project, onCustomizeHome }: ProjectHomeSurfaceProps) {
  const outputHashRef = useRef<string>(messageCache.get(project.path)?.outputHash ?? '')
  const surfacesRef = useRef<SurfaceModel<ReactComponentImplementation>[]>([])
  const projectPathRef = useRef(project.path)
  const onCustomizeHomeRef = useRef(onCustomizeHome)
  const [surfaces, setSurfaces] = useState<SurfaceModel<ReactComponentImplementation>[]>([])
  const [surfaceRevision, setSurfaceRevision] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    projectPathRef.current = project.path
  }, [project.path])

  useEffect(() => {
    onCustomizeHomeRef.current = onCustomizeHome
  }, [onCustomizeHome])

  const handleAction = useCallback(
    (action: A2uiClientAction) => {
      if (action.name === 'customize_home') {
        onCustomizeHomeRef.current()
        return
      }
      if (action.name === 'refresh_home') {
        outputHashRef.current = ''
        window.dispatchEvent(new CustomEvent('project-home:refresh'))
        return
      }
      if (action.name === 'open_file') {
        const rawPath = resolveActionPath(action.context?.filePath ?? action.context?.path)
        if (rawPath) {
          const safePath = normalizeProjectRelativePath(rawPath)
          if (safePath) {
            const targetPath = `${projectPathRef.current}/${safePath}`
            if (window.desktop?.openPath) {
              void window.desktop.openPath(targetPath).catch(() => window.desktop?.showItemInFolder?.(targetPath))
            } else {
              void window.desktop?.showItemInFolder?.(targetPath)
            }
          }
        }
      }
    },
    [],
  )

  const processor = useMemo(() => {
    return new MessageProcessor<ReactComponentImplementation>([basicCatalog], handleAction)
  }, [handleAction])

  const syncSurfacesFromProcessor = useCallback(() => {
    const next = Array.from(processor.model.surfacesMap.values())
    surfacesRef.current = next
    setSurfaces(next)
    setSurfaceRevision((revision) => revision + 1)
    return next
  }, [processor])

  const clearProcessorSurfaces = useCallback(() => {
    surfacesRef.current = []
    setSurfaces([])
    setSurfaceRevision((revision) => revision + 1)
    Array.from(processor.model.surfacesMap.keys()).forEach((id) => processor.model.deleteSurface(id))
  }, [processor])

  const processMessages = useCallback(
    (messages: A2uiMessage[]) => {
      try {
        clearProcessorSurfaces()
        processor.processMessages(messages)
        syncSurfacesFromProcessor()
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        console.error(error)
      }
    },
    [clearProcessorSurfaces, processor, syncSurfacesFromProcessor],
  )

  useEffect(() => {
    const onCreated = processor.onSurfaceCreated((surface) => {
      setSurfaces((prev) => {
        const next = [...prev.filter((item) => item.id !== surface.id), surface]
        surfacesRef.current = next
        return next
      })
      setSurfaceRevision((revision) => revision + 1)
    })
    const onDeleted = processor.onSurfaceDeleted((id) => {
      setSurfaces((prev) => {
        const next = prev.filter((surface) => surface.id !== id)
        surfacesRef.current = next
        return next
      })
      setSurfaceRevision((revision) => revision + 1)
    })
    return () => {
      onCreated.unsubscribe()
      onDeleted.unsubscribe()
      processor.model.dispose()
    }
  }, [processor])

  const loadHomePlugin = useCallback(async () => {
    const runHomePlugin = window.desktop?.runHomePlugin
    if (!runHomePlugin) return
    try {
      const result = await runHomePlugin(project.path, { knownOutputHash: outputHashRef.current || undefined })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setError('')
      if (result.status === 'empty') {
        outputHashRef.current = ''
        messageCache.delete(project.path)
        clearProcessorSurfaces()
        return
      }
      if (result.status === 'unchanged') {
        if (surfacesRef.current.length === 0) {
          const existing = syncSurfacesFromProcessor()
          if (existing.length > 0) return
          const cached = messageCache.get(project.path)
          if (cached) processMessages(cached.messages)
        }
        return
      }
      if (!result.messages) return

      outputHashRef.current = result.outputHash ?? ''
      const messages = result.messages as A2uiMessage[]
      messageCache.set(project.path, { outputHash: outputHashRef.current, messages })
      processMessages(messages)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      console.error(error)
    }
  }, [clearProcessorSurfaces, processMessages, project.path, syncSurfacesFromProcessor])

  useEffect(() => {
    outputHashRef.current = messageCache.get(project.path)?.outputHash ?? ''
    clearProcessorSurfaces()
    setError('')
    void loadHomePlugin()
  }, [clearProcessorSurfaces, loadHomePlugin, project.path])

  useEffect(() => {
    const onRefresh = () => void loadHomePlugin()
    window.addEventListener('project-home:refresh', onRefresh)
    return () => window.removeEventListener('project-home:refresh', onRefresh)
  }, [loadHomePlugin])

  if (error) {
    return <div className="project-home-surface-error">{error}</div>
  }

  if (surfaces.length === 0) return null

  return (
    <MarkdownContext.Provider value={(text) => Promise.resolve(renderMarkdown(text))}>
      <div className="project-home-surface">
        {surfaces.map((surface) => (
          <A2uiSurface key={`${surface.id}:${surfaceRevision}`} surface={surface} />
        ))}
      </div>
    </MarkdownContext.Provider>
  )
}

function resolveActionPath(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  return resolveActionPath(value.path)
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) return ''
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
