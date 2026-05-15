import type { IconName } from './icons'
import { Icons } from './icons'

type IconInlineProps = { name: IconName; className?: string }

export function IconInline({ name, className }: IconInlineProps) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: Icons[name] }} />
}
