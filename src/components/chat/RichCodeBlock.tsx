/**
 * Rich code presentation for assistant Markdown, including Mermaid rendering.
 */

import DOMPurify from 'dompurify'
import { memo, useEffect, useId, useMemo, useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { copySvgAsPng, downloadSvgFile, writeClipboardText } from './clipboard'

type CopyState = 'idle' | 'copying' | 'copied' | 'failed'
type MermaidRenderState = 'rendering' | 'ready' | 'failed'

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  graphql: 'GraphQL',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  md: 'Markdown',
  mermaid: 'Mermaid',
  php: 'PHP',
  plaintext: 'Plain text',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  ts: 'TypeScript',
  tsx: 'TSX',
  txt: 'Plain text',
  typescript: 'TypeScript',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Zsh',
}

export const RichCodeBlock = memo(function RichCodeBlock({
  code,
  language,
}: {
  code: string
  language: string
}) {
  const normalizedLanguage = normalizeLanguage(language)
  if (normalizedLanguage === 'mermaid') {
    return <MermaidDiagram code={code} />
  }
  return <CodeBlock code={code} language={normalizedLanguage} />
})

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n()
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const languageLabel = getLanguageLabel(language, t('chat.codeBlockPlainText'))
  const codeLabel = t('chat.codeBlockLanguageLabel', { language: languageLabel })
  const copyLabel = copyState === 'copied' ? t('chat.codeBlockCopied') : copyState === 'failed' ? t('chat.copyFailed') : t('chat.codeBlockCopy')

  const copyCode = () => {
    setCopyState('copying')
    void writeClipboardText(code).then((ok) => {
      setTimedCopyState(ok ? 'copied' : 'failed', setCopyState)
    })
  }

  return (
    <figure className="rich-code-block">
      <figcaption className="rich-code-block__header">
        <span className="rich-code-block__label">
          <IconInline name="code" />
          <span>{codeLabel}</span>
        </span>
        <button
          type="button"
          className="rich-code-block__action"
          disabled={copyState === 'copying'}
          title={t('chat.codeBlockCopyAria', { language: languageLabel })}
          aria-label={t('chat.codeBlockCopyAria', { language: languageLabel })}
          onClick={copyCode}
        >
          <IconInline name={copyState === 'copied' ? 'check' : 'copy'} />
          <span>{copyLabel}</span>
        </button>
      </figcaption>
      <pre className="rich-code-block__pre">
        <code>{code}</code>
      </pre>
    </figure>
  )
})

const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n()
  const reactId = useId()
  const baseId = useMemo(() => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [reactId])
  const [renderState, setRenderState] = useState<MermaidRenderState>('rendering')
  const [svg, setSvg] = useState('')
  const [renderedCode, setRenderedCode] = useState(code)
  const [wasRepaired, setWasRepaired] = useState(false)
  const [error, setError] = useState('')
  const [copySourceState, setCopySourceState] = useState<CopyState>('idle')
  const [copyPngState, setCopyPngState] = useState<CopyState>('idle')

  useEffect(() => {
    let cancelled = false

    setRenderState('rendering')
    setSvg('')
    setRenderedCode(code)
    setWasRepaired(false)
    setError('')

    void import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize(getMermaidConfig())
        const candidates = buildMermaidRenderCandidates(code)
        return renderMermaidCandidate(mermaid, baseId, candidates)
      })
      .then(({ svg: renderedSvg, source, repaired }) => {
        if (cancelled) return
        const cleanSvg = DOMPurify.sanitize(renderedSvg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['style'],
          ADD_ATTR: ['style'],
        })
        setSvg(cleanSvg)
        setRenderedCode(source)
        setWasRepaired(repaired)
        setRenderState('ready')
      })
      .catch((renderError: unknown) => {
        if (cancelled) return
        setError(formatMermaidError(renderError))
        setRenderState('failed')
      })

    return () => {
      cancelled = true
    }
  }, [baseId, code])

  const copySource = () => {
    setCopySourceState('copying')
    void writeClipboardText(renderedCode).then((ok) => {
      setTimedCopyState(ok ? 'copied' : 'failed', setCopySourceState)
    })
  }

  const copyPng = () => {
    if (!svg) return
    setCopyPngState('copying')
    void copySvgAsPng(svg).then((ok) => {
      setTimedCopyState(ok ? 'copied' : 'failed', setCopyPngState)
    })
  }

  const sourceCopyLabel =
    copySourceState === 'copied'
      ? t('chat.codeBlockCopied')
      : copySourceState === 'failed'
        ? t('chat.copyFailed')
        : t('chat.mermaidCopySource')
  const copyPngLabel =
    copyPngState === 'copying'
      ? t('chat.generativeUiCopyingPng')
      : copyPngState === 'copied'
        ? t('chat.generativeUiCopiedPng')
        : copyPngState === 'failed'
          ? t('chat.copyFailed')
          : t('chat.generativeUiCopyPng')

  return (
    <figure className="mermaid-diagram">
      <figcaption className="mermaid-diagram__header">
        <span className="mermaid-diagram__label">
          <IconInline name="diagram" />
          <span>{t('chat.mermaidDiagramLabel')}</span>
        </span>
        <span className={`mermaid-diagram__status mermaid-diagram__status--${wasRepaired ? 'repaired' : renderState}`}>
          {wasRepaired
            ? t('chat.mermaidAutoFixed')
            : renderState === 'ready'
              ? t('chat.mermaidRendered')
              : renderState === 'failed'
                ? t('chat.mermaidRenderFailed')
                : t('chat.mermaidRendering')}
        </span>
        <div className="mermaid-diagram__actions">
          <button
            type="button"
            className="mermaid-diagram__action"
            disabled={copySourceState === 'copying'}
            onClick={copySource}
          >
            <IconInline name={copySourceState === 'copied' ? 'check' : 'copy'} />
            <span>{sourceCopyLabel}</span>
          </button>
          <button
            type="button"
            className="mermaid-diagram__action"
            disabled={!svg}
            onClick={() => downloadSvgFile(svg, 'mermaid-diagram')}
          >
            <IconInline name="download" />
            <span>{t('chat.generativeUiDownloadSvg')}</span>
          </button>
          <button
            type="button"
            className="mermaid-diagram__action"
            disabled={!svg || copyPngState === 'copying'}
            onClick={copyPng}
          >
            <IconInline name={copyPngState === 'copied' ? 'check' : 'copy'} />
            <span>{copyPngLabel}</span>
          </button>
        </div>
      </figcaption>
      <div className="mermaid-diagram__stage">
        {renderState === 'rendering' ? (
          <div className="mermaid-diagram__loading" role="status" aria-live="polite">
            <span />
            <strong>{t('chat.mermaidRendering')}</strong>
          </div>
        ) : null}
        {renderState === 'ready' ? <div className="mermaid-diagram__svg" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
        {renderState === 'failed' ? (
          <div className="mermaid-diagram__error" role="alert">
            <strong>{t('chat.mermaidRenderFailed')}</strong>
            <span>{error}</span>
          </div>
        ) : null}
      </div>
      {renderState === 'failed' ? (
        <pre className="mermaid-diagram__source">
          <code>{renderedCode}</code>
        </pre>
      ) : null}
    </figure>
  )
})

async function renderMermaidCandidate(
  mermaid: Awaited<typeof import('mermaid')>['default'],
  baseId: string,
  candidates: Array<{ source: string; repaired: boolean }>,
) {
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const renderId = `${baseId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const result = await mermaid.render(renderId, candidate.source)
      return { svg: result.svg, source: candidate.source, repaired: candidate.repaired }
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw lastError
}

function buildMermaidRenderCandidates(source: string): Array<{ source: string; repaired: boolean }> {
  const repairedSource = repairMermaidSource(source)
  if (repairedSource.trim() && repairedSource !== source) {
    return [
      { source, repaired: false },
      { source: repairedSource, repaired: true },
    ]
  }
  return [{ source, repaired: false }]
}

function repairMermaidSource(source: string): string {
  const normalized = source
    .replace(/\r\n/g, '\n')
    .replace(/[﹣－–—]/g, '-')
    .replace(/[＞〉]/g, '>')
    .replace(/[＜〈]/g, '<')

  if (/^\s*sequenceDiagram\b/m.test(normalized)) {
    return repairSequenceDiagramParticipants(normalized)
  }

  return normalized
}

function repairSequenceDiagramParticipants(source: string): string {
  const reserved = new Set([
    'alt',
    'and',
    'break',
    'critical',
    'else',
    'end',
    'loop',
    'option',
    'opt',
    'par',
    'rect',
  ])
  const participantIds = new Set<string>()
  const replacements = new Map<string, string>()

  for (const line of source.split('\n')) {
    const match = line.match(/^\s*(?:participant|actor)\s+([A-Za-z][\w-]*)\b/)
    if (match?.[1]) participantIds.add(match[1])
  }

  for (const id of participantIds) {
    if (!reserved.has(id.toLowerCase())) continue
    let nextId = `${id}Node`
    let suffix = 2
    while (participantIds.has(nextId)) {
      nextId = `${id}Node${suffix}`
      suffix += 1
    }
    participantIds.add(nextId)
    replacements.set(id, nextId)
  }

  let repaired = source
  for (const [from, to] of replacements) {
    repaired = repaired.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to)
  }
  return repaired
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (normalized === 'mmd') return 'mermaid'
  if (normalized === 'text') return 'plaintext'
  return normalized
}

function getLanguageLabel(language: string, plainTextLabel: string): string {
  if (!language) return plainTextLabel
  return LANGUAGE_LABELS[language] ?? language.toUpperCase()
}

function setTimedCopyState(state: 'copied' | 'failed', setState: (value: CopyState) => void) {
  setState(state)
  window.setTimeout(() => setState('idle'), 1800)
}

function formatMermaidError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error || 'Unknown Mermaid render error')
}

function getMermaidConfig() {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: 'base' as const,
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
    },
    themeVariables: prefersDark
      ? {
          background: '#111827',
          mainBkg: '#1f2937',
          primaryColor: '#1f2937',
          primaryTextColor: '#f9fafb',
          primaryBorderColor: '#475569',
          lineColor: '#94a3b8',
          secondaryColor: '#0f766e',
          tertiaryColor: '#312e81',
          textColor: '#f9fafb',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }
      : {
          background: '#ffffff',
          mainBkg: '#f8fafc',
          primaryColor: '#f8fafc',
          primaryTextColor: '#111827',
          primaryBorderColor: '#cbd5e1',
          lineColor: '#64748b',
          secondaryColor: '#dbeafe',
          tertiaryColor: '#ecfeff',
          textColor: '#111827',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }
  }
}
