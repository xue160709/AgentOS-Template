/**
 * 将 `icons.ts` 中的 SVG 片段以内联 HTML 渲染。
 * Render trusted inline SVG snippets from the Icons catalog.
 */

import type { IconName } from './icons'
import { Icons } from './icons'

type IconInlineProps = { name: IconName; className?: string }

/** span + `dangerouslySetInnerHTML` 图标封装 / Icon span wrapper around embedded SVG */
export function IconInline({ name, className }: IconInlineProps) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: Icons[name] }} />
}
