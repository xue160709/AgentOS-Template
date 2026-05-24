/**
 * 会话条目渲染（助手 Markdown、工具卡、思考、活动）。
 * Timeline renderer for messages, tool chips, thinking, and agent activity rows.
 */

import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type {
  ActivityStatus,
  ChatActivityItem,
  ChatFileDiffItem,
  ChatMessageAttachment,
  ChatMessageItem,
  ChatThinkingItem,
  ChatToolItem,
  ToolStatus,
  TranscriptItem,
} from '../types'
import { AttachmentThumb } from './AttachmentThumb'
import { formatBytes, formatDuration } from './format'
import { GenerativeWidget } from './GenerativeWidget'
import { containsGenerativeWidget, parseGenerativeUiSegments } from './generative-ui'
import { escapeHtml, renderMarkdownSegments } from './markdown'
import { RichCodeBlock } from './RichCodeBlock'

type ProcessTranscriptItem = ChatToolItem | ChatThinkingItem | ChatActivityItem

type TranscriptRenderEntry =
  | {
      kind: 'item'
      item: TranscriptItem
    }
  | {
      kind: 'assistant-turn'
      message: ChatMessageItem
      processItems: ProcessTranscriptItem[]
    }

/** Memoized transcript map / Memoized transcript list renderer */
export const Transcript = memo(function Transcript({
  items,
  isRunning = false,
  onCopyMessage,
  onEditUserMessage,
  onUserMessageEditDismissed,
  onReviewFileChanges,
  onRewindFileChanges,
}: {
  items: TranscriptItem[]
  isRunning?: boolean
  onCopyMessage?: (text: string) => void
  onEditUserMessage?: (messageId: string, text: string) => void
  onUserMessageEditDismissed?: () => void
  onReviewFileChanges?: (changeSetId: string) => void
  onRewindFileChanges?: (item: ChatFileDiffItem) => void
}) {
  const entries = useMemo(() => groupTranscriptForRendering(items), [items])
  const renderItem = (item: TranscriptItem): ReactNode => {
    if (item.type === 'tool') return <ToolRow key={item.id} item={item} />
    if (item.type === 'thinking') return <ThinkingRow key={item.id} item={item} />
    if (item.type === 'activity') return <ActivityRow key={item.id} item={item} />
    if (item.type === 'file_diff') {
      return (
        <FileDiffRow
          key={item.id}
          item={item}
          onReviewFileChanges={onReviewFileChanges}
          onRewindFileChanges={onRewindFileChanges}
        />
      )
    }
    return (
      <ChatMessage
        key={item.id}
        item={item}
        canEdit={!isRunning}
        onCopyMessage={onCopyMessage}
        onEditUserMessage={onEditUserMessage}
        onUserMessageEditDismissed={onUserMessageEditDismissed}
      />
    )
  }

  return (
    <>
      {entries.map((entry) => {
        if (entry.kind !== 'assistant-turn') return renderItem(entry.item)
        const hasProcessTrace = Boolean(entry.message.durationMs && entry.processItems.length > 0)
        return (
          <Fragment key={`assistant-turn-${entry.message.id}`}>
            {hasProcessTrace ? (
              <ProcessTraceBlock
                durationMs={entry.message.durationMs}
                processItems={entry.processItems}
                renderItem={renderItem}
              />
            ) : (
              entry.processItems.map((item) => renderItem(item))
            )}
            <ChatMessage
              item={entry.message}
              canEdit={!isRunning}
              showDurationLabel={!hasProcessTrace}
              onCopyMessage={onCopyMessage}
              onEditUserMessage={onEditUserMessage}
              onUserMessageEditDismissed={onUserMessageEditDismissed}
            />
          </Fragment>
        )
      })}
    </>
  )
})

function groupTranscriptForRendering(items: TranscriptItem[]): TranscriptRenderEntry[] {
  const assistantRequestIds = new Set<string>()
  for (const item of items) {
    if (item.type === 'message' && item.role === 'assistant') {
      const requestId = getAssistantRequestId(item)
      if (requestId) assistantRequestIds.add(requestId)
    }
  }

  const processItemsByRequestId = new Map<string, ProcessTranscriptItem[]>()
  for (const item of items) {
    if (!isProcessTranscriptItem(item)) continue
    const requestId = getProcessRequestId(item)
    if (!requestId || !assistantRequestIds.has(requestId)) continue
    const current = processItemsByRequestId.get(requestId) ?? []
    current.push(item)
    processItemsByRequestId.set(requestId, current)
  }

  const entries: TranscriptRenderEntry[] = []
  let pendingProcessItems: ProcessTranscriptItem[] = []
  let lastAssistantEntry: Extract<TranscriptRenderEntry, { kind: 'assistant-turn' }> | null = null

  const flushProcessItems = () => {
    for (const item of pendingProcessItems) entries.push({ kind: 'item', item })
    pendingProcessItems = []
  }

  for (const item of items) {
    if (isProcessTranscriptItem(item)) {
      const requestId = getProcessRequestId(item)
      if (requestId && assistantRequestIds.has(requestId)) continue
      if (lastAssistantEntry) {
        lastAssistantEntry.processItems = uniqueProcessItems([...lastAssistantEntry.processItems, item])
        continue
      }
      pendingProcessItems.push(item)
      continue
    }

    if (item.type === 'message' && item.role === 'assistant') {
      const requestId = getAssistantRequestId(item)
      const requestProcessItems = requestId ? processItemsByRequestId.get(requestId) ?? [] : []
      const entry: Extract<TranscriptRenderEntry, { kind: 'assistant-turn' }> = {
        kind: 'assistant-turn',
        message: item,
        processItems: uniqueProcessItems([...pendingProcessItems, ...requestProcessItems]),
      }
      entries.push(entry)
      pendingProcessItems = []
      lastAssistantEntry = entry
      continue
    }

    flushProcessItems()
    entries.push({ kind: 'item', item })
    if (item.type === 'message' && item.role === 'user') lastAssistantEntry = null
  }

  flushProcessItems()
  return entries
}

function isProcessTranscriptItem(item: TranscriptItem): item is ProcessTranscriptItem {
  return item.type === 'tool' || item.type === 'thinking' || item.type === 'activity'
}

function getAssistantRequestId(item: ChatMessageItem): string | undefined {
  return item.id.startsWith('assistant-') ? item.id.slice('assistant-'.length) : undefined
}

function getProcessRequestId(item: ProcessTranscriptItem): string | undefined {
  if ('requestId' in item && item.requestId) return item.requestId
  const id = item.type === 'activity' ? item.id : item.type === 'thinking' ? item.thinkingId : ''
  const match = id.match(/^(?:activity|thinking)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i)
  return match?.[1]
}

function uniqueProcessItems(items: ProcessTranscriptItem[]): ProcessTranscriptItem[] {
  const seen = new Set<string>()
  const unique: ProcessTranscriptItem[] = []
  for (const item of items) {
    const key = getProcessItemKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function getProcessItemKey(item: ProcessTranscriptItem): string {
  if (item.type === 'tool') return `tool:${item.toolUseId}`
  if (item.type === 'thinking') return `thinking:${item.thinkingId}`
  return `activity:${item.id}`
}

/** ChatPage ResizeObserver listens for this to skip stick-to-bottom during local expand/collapse. */
const TRANSCRIPT_LAYOUT_TOGGLE_EVENT = 'chat-process-trace:toggle'

function getChatScrollRegion(node: EventTarget | null): HTMLElement | null {
  if (!node || !(node instanceof Element)) return null
  return node.closest('.chat-scroll-region') as HTMLElement | null
}

/** Keep scroll position stable when transcript blocks change height (details, process group, file diff). */
function handleTranscriptLayoutToggle(
  event: { currentTarget: EventTarget | null },
  applyToggle: () => void,
) {
  const scrollRegion = getChatScrollRegion(event.currentTarget)
  const scrollTop = scrollRegion?.scrollTop
  window.dispatchEvent(new CustomEvent(TRANSCRIPT_LAYOUT_TOGGLE_EVENT))
  applyToggle()
  if (!scrollRegion || scrollTop === undefined) return
  const restoreScroll = () => {
    const maxTop = Math.max(0, scrollRegion.scrollHeight - scrollRegion.clientHeight)
    scrollRegion.scrollTop = Math.min(scrollTop, maxTop)
  }
  window.requestAnimationFrame(() => {
    restoreScroll()
    window.requestAnimationFrame(restoreScroll)
  })
}

function ProcessTraceBlock({
  durationMs,
  processItems,
  renderItem,
}: {
  durationMs?: number
  processItems: ProcessTranscriptItem[]
  renderItem: (item: TranscriptItem) => ReactNode
}) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const durationLabel = durationMs ? formatDuration(durationMs) : ''

  if (!durationLabel || processItems.length === 0) return null

  return (
    <section className="chat-process-group">
      <button
        type="button"
        className="chat-message__duration chat-message__duration--toggle chat-process-group__summary"
        title={t('chat.responseDurationTitle')}
        aria-label={t('chat.responseDurationTitle')}
        aria-expanded={isOpen}
        onClick={(event) => handleTranscriptLayoutToggle(event, () => setIsOpen((value) => !value))}
      >
        <span>{t('chat.responseProcessed')}</span>
        <span>{durationLabel}</span>
        <IconInline name="chevron" />
      </button>
      {isOpen ? <div className="chat-process-group__body">{processItems.map((item) => renderItem(item))}</div> : null}
    </section>
  )
}

const ChatMessage = memo(function ChatMessage({
  item,
  canEdit,
  showDurationLabel = true,
  onCopyMessage,
  onEditUserMessage,
  onUserMessageEditDismissed,
}: {
  item: ChatMessageItem
  canEdit: boolean
  showDurationLabel?: boolean
  onCopyMessage?: (text: string) => void
  onEditUserMessage?: (messageId: string, text: string) => void
  onUserMessageEditDismissed?: () => void
}) {
  const { t } = useI18n()
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(item.content)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isEditing) setDraft(item.content)
  }, [isEditing, item.content])

  useLayoutEffect(() => {
    if (!isEditing) return
    editTextareaRef.current?.focus({ preventScroll: true })
  }, [isEditing])

  const bodyHtml = useMemo(() => {
    if (item.role === 'assistant') return ''
    return `<p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>`
  }, [item.content, item.role])

  if (item.role === 'assistant' && !item.content.trim() && item.status === 'streaming') return null

  const attachments = item.attachments ?? []
  const hasBody =
    item.role === 'assistant' ? item.content.trim().length > 0 || attachments.length > 0 : item.content.trim().length > 0
  const durationLabel = showDurationLabel && item.role === 'assistant' && item.durationMs ? formatDuration(item.durationMs) : ''
  const canCopy = item.content.trim().length > 0
  const canSaveEdit = draft.trim().length > 0 && draft.trim() !== item.content.trim()
  const shouldRenderBubble = isEditing || hasBody

  const saveEdit = () => {
    const next = draft.trim()
    if (!next) return
    setIsEditing(false)
    onEditUserMessage?.(item.id, next)
  }

  const contentNode = (
    <>
      {attachments.length > 0 ? <ChatAttachmentList attachments={attachments} /> : null}
      {isEditing ? (
        <div className="chat-message-edit">
          <textarea
            ref={editTextareaRef}
            value={draft}
            aria-label={t('chat.editMessageAria')}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                if (canSaveEdit) saveEdit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onUserMessageEditDismissed?.()
                setIsEditing(false)
                setDraft(item.content)
              }
            }}
          />
          <div className="chat-message-edit__actions">
            <button
              type="button"
              className="chat-message-edit__btn chat-message-edit__btn--cancel"
              onClick={() => {
                onUserMessageEditDismissed?.()
                setIsEditing(false)
              }}
            >
              <IconInline name="x" />
              <span>{t('chat.editCancel')}</span>
            </button>
            <button type="button" className="chat-message-edit__btn chat-message-edit__btn--submit" disabled={!canSaveEdit} onClick={saveEdit}>
              <IconInline name="check" />
              <span>{t('chat.editSubmit')}</span>
            </button>
          </div>
        </div>
      ) : hasBody ? (
        item.role === 'assistant' ? (
          <AssistantMessageContent content={item.content} status={item.status} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        )
      ) : null}
    </>
  )

  return (
    <article className={`chat-message chat-message--${item.role} chat-message--${item.status}`} data-transcript-item-id={item.id}>
      <div className="chat-message__stack">
        {durationLabel ? (
          <span className="chat-message__duration" title={t('chat.responseDurationTitle')} aria-label={t('chat.responseDurationTitle')}>
            <span>{t('chat.responseProcessed')}</span>
            <span>{durationLabel}</span>
          </span>
        ) : null}
        {shouldRenderBubble ? <div className="chat-message__bubble markdown-body">{contentNode}</div> : null}
        {!isEditing && shouldRenderBubble ? (
          <div className="chat-message-actions" aria-label={t('chat.messageActionsAria')}>
            <button
              type="button"
              className="chat-message-action"
              disabled={!canCopy}
              title={t('chat.copyMessage')}
              aria-label={t('chat.copyMessage')}
              onClick={() => onCopyMessage?.(item.content)}
            >
              <IconInline name="copy" />
            </button>
            {item.role === 'user' ? (
              <button
                type="button"
                className="chat-message-action"
                disabled={!canEdit}
                title={t('chat.editMessage')}
                aria-label={t('chat.editMessage')}
                onClick={() => setIsEditing(true)}
              >
                <IconInline name="edit" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
})

const AssistantMessageContent = memo(function AssistantMessageContent({
  content,
  status,
}: {
  content: string
  status: ChatMessageItem['status']
}) {
  const { t } = useI18n()
  const isStreaming = status === 'streaming'
  const segments = useMemo(
    () => (containsGenerativeWidget(content) ? parseGenerativeUiSegments(content, isStreaming) : []),
    [content, isStreaming],
  )

  if (segments.length === 0) {
    return (
      <>
        <AssistantMarkdown content={content || (isStreaming ? '' : ' ')} />
        {isStreaming ? <span className="typing-dot" /> : null}
      </>
    )
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <AssistantMarkdown key={`text-${index}`} className="assistant-text-segment" content={segment.content} />
          )
        }
        if (segment.type === 'pending') {
          return (
            <div key={`pending-${index}`} className="generative-widget-pending" role="status" aria-live="polite">
              <span />
              <strong>{t('chat.generativeUiPreparing')}</strong>
            </div>
          )
        }
        return (
          <GenerativeWidget
            key={`widget-${index}`}
            widgetCode={segment.data.widgetCode}
            title={segment.data.title}
            streaming={isStreaming && segment.data.streaming}
            showOverlay={segment.data.scriptTruncated}
          />
        )
      })}
      {isStreaming ? <span className="typing-dot" /> : null}
    </>
  )
})

const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  const segments = useMemo(() => renderMarkdownSegments(content), [content])
  const body = segments.map((segment, index) => {
    if (segment.type === 'code') {
      return <RichCodeBlock key={`code-${index}`} code={segment.code} language={segment.language} />
    }
    return (
      <div
        key={`html-${index}`}
        className="assistant-markdown__html"
        dangerouslySetInnerHTML={{ __html: segment.html }}
      />
    )
  })

  if (className) return <div className={className}>{body}</div>
  return <>{body}</>
})

const ToolRow = memo(function ToolRow({ item }: { item: ChatToolItem }) {
  const { t } = useI18n()
  const statusLabel: Record<ToolStatus, string> = {
    denied: t('chat.toolDenied'),
    done: t('chat.toolDone'),
    error: t('chat.toolError'),
    running: t('chat.toolRunning'),
  }
  const hasDetails = Boolean(item.inputPreview?.trim())
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  const summary = (
    <>
      <span className={`status-row__chevron${hasDetails ? '' : ' status-row__chevron--hidden'}`} aria-hidden="true" />
      <span className="tool-row__dot" />
      <span className="tool-row__name">{item.name}</span>
      <span className="tool-row__status">{statusLabel[item.status]}</span>
      {item.detail ? <span className="tool-row__detail">{item.detail}</span> : null}
    </>
  )

  if (!hasDetails) {
    return (
      <div className={`tool-row tool-row--${item.status} tool-row--static`} data-transcript-item-id={item.id}>
        <div className="status-row__summary status-row__summary--static">{summary}</div>
      </div>
    )
  }

  return (
    <details
      className={`tool-row tool-row--${item.status}`}
      data-transcript-item-id={item.id}
      open={isOpen}
      onToggle={(event) => handleTranscriptLayoutToggle(event, () => setIsOpen(event.currentTarget.open))}
    >
      <summary className="status-row__summary">{summary}</summary>
      <div className="status-row__body">{item.inputPreview ? <code>{item.inputPreview}</code> : null}</div>
    </details>
  )
})

const ThinkingRow = memo(function ThinkingRow({ item }: { item: ChatThinkingItem }) {
  const { t } = useI18n()
  const hasDetails = Boolean(item.content.trim())
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  const summary = (
    <>
      <span className={`status-row__chevron${hasDetails ? '' : ' status-row__chevron--hidden'}`} aria-hidden="true" />
      <span className="thinking-row__dot" />
      <span className="thinking-row__title">{item.title}</span>
      <span className="thinking-row__status">{item.status === 'running' ? t('chat.thinkingRunning') : t('chat.thinkingDone')}</span>
    </>
  )

  if (!hasDetails) {
    return (
      <div className={`thinking-row thinking-row--${item.status} thinking-row--static`} data-transcript-item-id={item.id}>
        <div className="thinking-row__header thinking-row__header--static">{summary}</div>
      </div>
    )
  }

  return (
    <details
      className={`thinking-row thinking-row--${item.status}`}
      data-transcript-item-id={item.id}
      open={isOpen}
      onToggle={(event) => handleTranscriptLayoutToggle(event, () => setIsOpen(event.currentTarget.open))}
    >
      <summary className="thinking-row__header">{summary}</summary>
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
  const hasDetails = Boolean(item.preview?.trim())
  const [isOpen, setIsOpen] = useState(item.status === 'running')

  useEffect(() => {
    setIsOpen(item.status === 'running')
  }, [item.status])

  const summary = (
    <>
      <span className={`status-row__chevron${hasDetails ? '' : ' status-row__chevron--hidden'}`} aria-hidden="true" />
      <span className="activity-row__dot" />
      <span className="activity-row__title">{item.title}</span>
      <span className="activity-row__status">{statusLabel[item.status]}</span>
      {item.detail ? <span className="activity-row__detail">{item.detail}</span> : null}
    </>
  )

  if (!hasDetails) {
    return (
      <div className={`activity-row activity-row--${item.status} activity-row--static`} data-transcript-item-id={item.id}>
        <div className="activity-row__main activity-row__main--static">{summary}</div>
      </div>
    )
  }

  return (
    <details
      className={`activity-row activity-row--${item.status}`}
      data-transcript-item-id={item.id}
      open={isOpen}
      onToggle={(event) => handleTranscriptLayoutToggle(event, () => setIsOpen(event.currentTarget.open))}
    >
      <summary className="activity-row__main">{summary}</summary>
      {item.preview ? <pre>{item.preview}</pre> : null}
    </details>
  )
})

const FileDiffRow = memo(function FileDiffRow({
  item,
  onReviewFileChanges,
  onRewindFileChanges,
}: {
  item: ChatFileDiffItem
  onReviewFileChanges?: (changeSetId: string) => void
  onRewindFileChanges?: (item: ChatFileDiffItem) => void
}) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(item.status === 'captured')
  const additions = item.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = item.files.reduce((sum, file) => sum + file.deletions, 0)
  const canRewind = Boolean(item.checkpointId && item.status !== 'reverted')
  const canReview = item.status !== 'reviewed' && item.status !== 'reverted'

  useEffect(() => {
    if (item.status === 'captured') setIsOpen(true)
  }, [item.status])

  return (
    <section className={`file-diff-row file-diff-row--${item.status}`} data-transcript-item-id={item.id} aria-label={t('chat.fileDiffAria')}>
      <div className="file-diff-row__header">
        <span className="file-diff-row__icon" aria-hidden="true">
          <IconInline name="files" />
        </span>
        <div className="file-diff-row__copy">
          <strong>{t('chat.fileDiffTitle', { count: item.files.length })}</strong>
          <button
            type="button"
            className="file-diff-row__link"
            onClick={(event) => handleTranscriptLayoutToggle(event, () => setIsOpen((value) => !value))}
          >
            {isOpen ? t('chat.fileDiffHide') : t('chat.fileDiffView')}
          </button>
          {item.detail ? <span className="file-diff-row__detail">{item.detail}</span> : null}
        </div>
        <div className="file-diff-row__stats" aria-label={t('chat.fileDiffStats')}>
          <span className="file-diff-row__stat file-diff-row__stat--add">+{additions}</span>
          <span className="file-diff-row__stat file-diff-row__stat--delete">-{deletions}</span>
        </div>
        <div className="file-diff-row__actions">
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            disabled={!canRewind}
            title={canRewind ? t('chat.fileDiffRevert') : t('chat.fileDiffUnavailable')}
            onClick={() => onRewindFileChanges?.(item)}
          >
            <IconInline name="undo" />
            <span>{item.status === 'reverted' ? t('chat.fileDiffReverted') : t('chat.fileDiffRevert')}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary btn-compact"
            disabled={!canReview}
            onClick={() => onReviewFileChanges?.(item.changeSetId)}
          >
            <IconInline name="check" />
            <span>{item.status === 'reviewed' ? t('chat.fileDiffReviewed') : t('chat.fileDiffReview')}</span>
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="file-diff-row__body">
          {item.files.length > 0 ? (
            item.files.map((file, index) => (
              <details className="file-diff-file" key={`${file.path}-${index}`} open={index === 0}>
                <summary className="file-diff-file__summary">
                  <span>{file.relativePath || file.path}</span>
                  <span className="file-diff-file__stats">
                    <span className="file-diff-row__stat file-diff-row__stat--add">+{file.additions}</span>
                    <span className="file-diff-row__stat file-diff-row__stat--delete">-{file.deletions}</span>
                  </span>
                </summary>
                {file.hunks.length > 0 ? (
                  <div className="file-diff-file__hunks">
                    {file.hunks.map((hunk, hunkIndex) => (
                      <div className="file-diff-hunk" key={`${file.path}-hunk-${hunkIndex}`}>
                        <div className="file-diff-hunk__meta">
                          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                        </div>
                        {hunk.lines.map((line, lineIndex) => (
                          <div className={`file-diff-line file-diff-line--${line.kind}`} key={`${hunkIndex}-${lineIndex}`}>
                            <span className="file-diff-line__number">{line.oldLineNumber ?? ''}</span>
                            <span className="file-diff-line__number">{line.newLineNumber ?? ''}</span>
                            <code>
                              {line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}
                              {line.content}
                            </code>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="file-diff-file__empty">{t('chat.fileDiffEmpty')}</p>
                )}
              </details>
            ))
          ) : (
            <p className="file-diff-file__empty">{t('chat.fileDiffEmpty')}</p>
          )}
        </div>
      ) : null}
    </section>
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
