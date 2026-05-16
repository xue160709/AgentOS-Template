/**
 * 合并短时间窗口内的流式 delta，降低 IPC 频率。
 * Coalesce high-frequency stream deltas before forwarding over IPC.
 */

import type { ClaudeChatEvent } from '../../src/claude-chat-types'

const STREAM_COALESCE_MS = 50

type CoalescedEvent =
  | Extract<ClaudeChatEvent, { type: 'assistant_delta' }>
  | Extract<ClaudeChatEvent, { type: 'thinking_delta' }>
  | Extract<ClaudeChatEvent, { type: 'tool_update' }>

type PendingEvent = {
  event: CoalescedEvent
  timer: ReturnType<typeof setTimeout>
}

/** 缓冲 assistant/thinking/tool_update 片段的发射器 / Buffers coalescable chat events */
export class ClaudeChatEventCoalescer {
  private readonly pendingEvents = new Map<string, PendingEvent>()

  constructor(private readonly sendNow: (event: ClaudeChatEvent) => void) {}

  emit(event: ClaudeChatEvent): void {
    if (!isCoalescable(event)) {
      this.flushRequest(event.requestId)
      this.sendNow(event)
      return
    }

    const key = coalescingKey(event)
    const pending = this.pendingEvents.get(key)
    if (pending) {
      pending.event = mergeEvent(pending.event, event)
      return
    }

    const timer = setTimeout(() => this.flushKey(key), STREAM_COALESCE_MS)
    this.pendingEvents.set(key, { event, timer })
  }

  flushRequest(requestId: string): void {
    for (const [key, pending] of this.pendingEvents) {
      if (pending.event.requestId !== requestId) continue
      clearTimeout(pending.timer)
      this.pendingEvents.delete(key)
      this.sendNow(pending.event)
    }
  }

  flushAll(): void {
    for (const key of [...this.pendingEvents.keys()]) {
      this.flushKey(key)
    }
  }

  private flushKey(key: string): void {
    const pending = this.pendingEvents.get(key)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingEvents.delete(key)
    this.sendNow(pending.event)
  }
}

function isCoalescable(event: ClaudeChatEvent): event is CoalescedEvent {
  return event.type === 'assistant_delta' || event.type === 'thinking_delta' || event.type === 'tool_update'
}

function coalescingKey(event: CoalescedEvent): string {
  if (event.type === 'assistant_delta') return `${event.requestId}:assistant:${event.messageId}`
  if (event.type === 'thinking_delta') return `${event.requestId}:thinking:${event.thinkingId}`
  return `${event.requestId}:tool:${event.toolUseId}`
}

function mergeEvent(previous: CoalescedEvent, next: CoalescedEvent): CoalescedEvent {
  if (previous.type === 'assistant_delta' && next.type === 'assistant_delta') {
    return { ...next, text: previous.text + next.text }
  }

  if (previous.type === 'thinking_delta' && next.type === 'thinking_delta') {
    return { ...next, text: previous.text + next.text }
  }

  if (previous.type === 'tool_update' && next.type === 'tool_update') {
    return {
      ...next,
      inputPreview: next.inputPreview ?? previous.inputPreview,
      detail: next.detail ?? previous.detail,
    }
  }

  return next
}
