/**
 * 活跃会话视图：滚动区域 + Transcript + 底部 Composer 槽。
 * Active conversation layout wiring transcript viewport and composer slot.
 */

import type { ReactNode, RefObject } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { TranscriptItem } from '../types'
import { Transcript } from './Transcript'

type ChatThreadViewProps = {
  items: TranscriptItem[]
  composer: ReactNode
  scrollRegionRef: RefObject<HTMLDivElement | null>
  showScrollButton: boolean
  onScrollToBottom: (behavior: ScrollBehavior) => void
}

/** Thread timeline chrome wrapping scroll hints / Timeline chrome around transcript scroll controls */
export function ChatThreadView({
  items,
  composer,
  scrollRegionRef,
  showScrollButton,
  onScrollToBottom,
}: ChatThreadViewProps) {
  const { t } = useI18n()

  return (
    <>
      <div className="chat-scroll-region" id="chat-scroll-region" ref={scrollRegionRef}>
        <div className="chat-transcript" id="chat-transcript" aria-live="polite">
          <Transcript items={items} />
        </div>
      </div>
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
      {composer}
    </>
  )
}
