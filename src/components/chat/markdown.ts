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

/** 纯文本注入前的 HTML 转义 / Escape text before injecting into HTML contexts */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
