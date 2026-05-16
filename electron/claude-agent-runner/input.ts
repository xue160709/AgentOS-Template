/**
 * 将渲染进程提交的附件规范化为 SDK 用户消息。
 * Normalize renderer attachments into SDK user prompt payloads.
 */

import os from 'node:os'
import path from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeChatAttachment } from '../../src/claude-chat-types'
import { isRecord } from './value-formatters'

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
type SDKUserMessageContent = Exclude<SDKUserMessage['message']['content'], string>

/** 过滤并规范化 IPC 传来的附件数组 / Sanitize attachment array from IPC */
export function normalizeSubmitAttachments(value: unknown): ClaudeChatAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: ClaudeChatAttachment[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    const base = {
      id: item.id,
      name: item.name,
      path: typeof item.path === 'string' ? item.path : '',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
      preview: typeof item.preview === 'string' ? item.preview : undefined,
      dataUrl: typeof item.dataUrl === 'string' ? item.dataUrl : undefined,
    }

    if (item.kind === 'text' && typeof item.text === 'string') {
      attachments.push({
        ...base,
        kind: 'text',
        text: item.text,
      })
      continue
    }

    if (
      item.kind === 'image' &&
      typeof item.base64 === 'string' &&
      SUPPORTED_IMAGE_MIME_TYPES.has(base.mimeType)
    ) {
      attachments.push({
        ...base,
        kind: 'image',
        mimeType: base.mimeType as SupportedImageMimeType,
        base64: item.base64,
      })
    }
  }
  return attachments
}

/** 文本或多模态附件转成 SDK prompt（字符串或异步迭代）/ Build SDK prompt string or async user message stream */
export function buildSdkPromptInput(prompt: string, attachments: ClaudeChatAttachment[]): string | AsyncIterable<SDKUserMessage> {
  if (attachments.length === 0) return prompt
  const content = buildSdkUserContent(prompt, attachments)
  return singleUserMessage(content)
}

function buildSdkUserContent(prompt: string, attachments: ClaudeChatAttachment[]): SDKUserMessageContent {
  const content: SDKUserMessageContent = []
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt) {
    content.push({ type: 'text', text: trimmedPrompt })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'text' && attachment.text != null) {
      content.push({
        type: 'text',
        text: formatTextAttachmentForPrompt(attachment),
      })
      continue
    }

    if (attachment.kind === 'image' && attachment.base64 && isSupportedImageMimeType(attachment.mimeType)) {
      content.push({
        type: 'text',
        text: `Attached image: ${attachment.name}${attachment.path ? `\nPath: ${attachment.path}` : ''}`,
      })
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mimeType,
          data: attachment.base64,
        },
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '请阅读这些附件。' })
  }
  return content
}

async function* singleUserMessage(content: SDKUserMessageContent): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  }
}

function formatTextAttachmentForPrompt(attachment: ClaudeChatAttachment): string {
  const header = [
    'Attached text file:',
    `Name: ${attachment.name}`,
    attachment.path ? `Path: ${attachment.path}` : '',
    attachment.mimeType ? `MIME: ${attachment.mimeType}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\n${attachment.text ?? ''}`
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.has(value)
}

/** 解析工作目录：`~` 展开并回落默认路径 / Resolve cwd with `~` expansion and fallback */
export function resolveWorkspaceCwd(requested: string | undefined, fallback: string): string {
  const raw = requested?.trim() || fallback.trim()
  if (!raw) return path.resolve(fallback)
  if (raw.startsWith('~/')) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)))
  }
  return path.resolve(raw)
}
