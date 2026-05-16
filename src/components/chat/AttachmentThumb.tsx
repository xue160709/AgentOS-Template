import type { ClaudeChatAttachment } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import type { ChatMessageAttachment } from '../types'

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
