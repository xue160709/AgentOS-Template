/**
 * Markdown → HTML（同步）并经 DOMPurify 消毒。
 * Sync Markdown rendering with DOMPurify sanitization for assistant bubbles.
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  breaks: true,
  gfm: true,
})

/** 渲染助手 Markdown 为安全 HTML / Render assistant markdown into sanitized HTML */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    USE_PROFILES: { html: true },
  })
}

export type RenderedMarkdownSegment =
  | {
      type: 'html'
      html: string
    }
  | {
      type: 'code'
      code: string
      language: string
    }

type MarkdownToken = {
  type: string
  raw?: string
  text?: string
  lang?: string
}

/** Split fenced code from Markdown so React controls copy and diagram actions. */
export function renderMarkdownSegments(markdown: string): RenderedMarkdownSegment[] {
  const tokens = marked.lexer(markdown) as MarkdownToken[]
  const segments: RenderedMarkdownSegment[] = []
  let pendingMarkdown = ''

  const flushMarkdown = () => {
    if (!pendingMarkdown.trim()) {
      pendingMarkdown = ''
      return
    }
    const html = renderMarkdown(pendingMarkdown)
    if (html.trim()) segments.push({ type: 'html', html })
    pendingMarkdown = ''
  }

  for (const token of tokens) {
    if (token.type === 'code') {
      flushMarkdown()
      segments.push({
        type: 'code',
        code: token.text ?? '',
        language: token.lang?.trim() ?? '',
      })
      continue
    }
    pendingMarkdown += token.raw ?? ''
  }

  flushMarkdown()
  return segments
}

/** 纯文本注入前的 HTML 转义 / Escape text before injecting into HTML contexts */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
