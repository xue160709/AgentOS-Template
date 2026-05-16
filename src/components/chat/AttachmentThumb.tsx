/**
 * 聊天附件缩略图（图像 data URL 或类型占位）。
 * Attachment glyph rendering previews or kind placeholders.
 */

import type { ClaudeChatAttachment } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import type { ChatMessageAttachment } from '../types'

/** Composer / transcript 共用微型预览 / Tiny preview shared by composer & bubbles */
export function AttachmentThumb({ attachment }: { attachment: ClaudeChatAttachment | ChatMessageAttachment }) {
  if (attachment.kind === 'image' && attachment.dataUrl) {
    return <img className="attachment-thumb attachment-thumb--image" src={attachment.dataUrl} alt="" />
  }
  return (
    <span className={`attachment-thumb attachment-thumb--${attachment.kind}`} aria-hidden="true">
      <IconInline name={attachment.kind === 'image' ? 'image' : 'file'} />
    </span>
  )
}
