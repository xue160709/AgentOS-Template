import { memo, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n/i18n'
import type {
  ActivityStatus,
  ChatActivityItem,
  ChatMessageAttachment,
  ChatMessageItem,
  ChatThinkingItem,
  ChatToolItem,
  ToolStatus,
  TranscriptItem,
} from '../types'
import { AttachmentThumb } from './AttachmentThumb'
import { formatBytes } from './format'
import { escapeHtml, renderMarkdown } from './markdown'

export const Transcript = memo(function Transcript({ items }: { items: TranscriptItem[] }) {
  return (
    <>
      {items.map((item) => {
        if (item.type === 'tool') return <ToolRow key={item.id} item={item} />
        if (item.type === 'thinking') return <ThinkingRow key={item.id} item={item} />
        if (item.type === 'activity') return <ActivityRow key={item.id} item={item} />
        return <ChatMessage key={item.id} item={item} />
      })}
    </>
  )
})

const ChatMessage = memo(function ChatMessage({ item }: { item: ChatMessageItem }) {
  const bodyHtml = useMemo(() => {
    if (item.role === 'assistant') {
      return renderMarkdown(item.content || (item.status === 'streaming' ? '' : ' '))
    }
    return `<p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>`
  }, [item.content, item.role, item.status])

  if (item.role === 'assistant' && !item.content.trim() && item.status === 'streaming') return null

  const suffix = item.role === 'assistant' && item.status === 'streaming' ? '<span class="typing-dot"></span>' : ''
  const hasBody = item.content.trim().length > 0 || item.role === 'assistant'
  const attachments = item.attachments ?? []

  return (
    <article className={`chat-message chat-message--${item.role} chat-message--${item.status}`}>
      <div className="chat-message__bubble markdown-body">
        {attachments.length > 0 ? <ChatAttachmentList attachments={attachments} /> : null}
        {hasBody ? <div dangerouslySetInnerHTML={{ __html: bodyHtml + suffix }} /> : null}
      </div>
    </article>
  )
})

const ToolRow = memo(function ToolRow({ item }: { item: ChatToolItem }) {
  const { t } = useI18n()
  const statusLabel: Record<ToolStatus, string> = {
    denied: t('chat.toolDenied'),
    done: t('chat.toolDone'),
    error: t('chat.toolError'),
    running: t('chat.toolRunning'),
  }
  const hasDetails = Boolean(item.detail || item.inputPreview)
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`tool-row tool-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="status-row__summary">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="tool-row__dot" />
        <span className="tool-row__name">{item.name}</span>
        <span className="tool-row__status">{statusLabel[item.status]}</span>
        {item.detail ? <span className="tool-row__detail">{item.detail}</span> : null}
      </summary>
      {hasDetails ? (
        <div className="status-row__body">
          {item.inputPreview ? <code>{item.inputPreview}</code> : null}
        </div>
      ) : null}
    </details>
  )
})

const ThinkingRow = memo(function ThinkingRow({ item }: { item: ChatThinkingItem }) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`thinking-row thinking-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="thinking-row__header">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="thinking-row__dot" />
        <span className="thinking-row__title">{item.title}</span>
        <span className="thinking-row__status">{item.status === 'running' ? t('chat.thinkingRunning') : t('chat.thinkingDone')}</span>
      </summary>
      {item.content ? <pre>{item.content}</pre> : null}
    </details>
  )
})

const ActivityRow = memo(function ActivityRow({ item }: { item: ChatActivityItem }) {
  const { t } = useI18n()
  const statusLabel: Record<ActivityStatus, string> = {
    done: t('chat.activityDone'),
    error: t('chat.activityError'),
    info: t('chat.activityInfo'),
    running: t('chat.activityRunning'),
  }
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  return (
    <details
      className={`activity-row activity-row--${item.status}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="activity-row__main">
        <span className="status-row__chevron" aria-hidden="true" />
        <span className="activity-row__dot" />
        <span className="activity-row__title">{item.title}</span>
        <span className="activity-row__status">{statusLabel[item.status]}</span>
        {item.detail ? <span className="activity-row__detail">{item.detail}</span> : null}
      </summary>
      {item.preview ? <pre>{item.preview}</pre> : null}
    </details>
  )
})

function ChatAttachmentList({ attachments }: { attachments: ChatMessageAttachment[] }) {
  return (
    <div className="chat-message-attachments">
      {attachments.map((attachment) => (
        <div key={attachment.id} className={`chat-message-attachment chat-message-attachment--${attachment.kind}`}>
          <AttachmentThumb attachment={attachment} />
          <span className="chat-message-attachment__copy">
            <span>{attachment.name}</span>
            <span>{attachment.preview || formatBytes(attachment.size)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
