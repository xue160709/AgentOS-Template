import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  breaks: true,
  gfm: true,
})

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    USE_PROFILES: { html: true },
  })
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
