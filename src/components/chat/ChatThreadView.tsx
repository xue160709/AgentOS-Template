/**
 * 活跃会话视图：滚动区域 + Transcript + 底部 Composer 槽。
 * Active conversation layout wiring transcript viewport and composer slot.
 */

import type { ReactNode, RefObject } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { ChatFileDiffItem, ThreadRunState, TranscriptItem } from '../types'
import { Transcript } from './Transcript'

type ChatThreadViewProps = {
  items: TranscriptItem[]
  isRunning: boolean
  activeRunState?: ThreadRunState
  composer: ReactNode
  scrollRegionRef: RefObject<HTMLDivElement | null>
  showScrollButton: boolean
  onScrollToBottom: (behavior: ScrollBehavior) => void
  onCopyMessage: (text: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  onUserMessageEditDismissed?: () => void
  onReviewFileChanges: (changeSetId: string) => void
  onRewindFileChanges: (item: ChatFileDiffItem) => void
}

/** 有消息时的会话区：可滚动 Transcript + 吸底按钮 + Composer 插槽 / Active thread: scrollable transcript, scroll-to-bottom control, composer slot */
export function ChatThreadView({
  items,
  isRunning,
  activeRunState,
  composer,
  scrollRegionRef,
  showScrollButton,
  onScrollToBottom,
  onCopyMessage,
  onEditUserMessage,
  onUserMessageEditDismissed,
  onReviewFileChanges,
  onRewindFileChanges,
}: ChatThreadViewProps) {
  const { t } = useI18n()

  return (
    <>
      {/* 主滚动区：ChatPage 据此计算吸底与 ResizeObserver / Main scroll viewport; ChatPage attaches stick-to-bottom logic here */}
      <div className="chat-scroll-region" id="chat-scroll-region" ref={scrollRegionRef}>
        <div className="chat-transcript" id="chat-transcript" aria-live="polite">
          <Transcript
            items={items}
            isRunning={isRunning}
            activeRunState={activeRunState}
            onCopyMessage={onCopyMessage}
            onEditUserMessage={onEditUserMessage}
            onUserMessageEditDismissed={onUserMessageEditDismissed}
            onReviewFileChanges={onReviewFileChanges}
            onRewindFileChanges={onRewindFileChanges}
          />
        </div>
      </div>
      {/* 远离底部时的快捷回底（可见性由 `showScrollButton` 控制）/ Floating control when user scrolled up */}
      <button
        type="button"
        className="btn btn-scroll-bottom"
        id="btn-scroll-bottom"
        title={t('chat.scrollBottomTitle')}
        aria-label={t('chat.scrollBottomAria')}
        aria-hidden={!showScrollButton}
        tabIndex={showScrollButton ? 0 : -1}
        data-visible={showScrollButton || undefined}
        onClick={() => onScrollToBottom('smooth')}
      >
        <IconInline name="arrowDown" />
      </button>
      {/* Composer 由父级 `ChatPage` 传入，保持布局插槽稳定 / Composer is slotted from `ChatPage` for stable layout */}
      {composer}
    </>
  )
}
