/**
 * 聊天页 Composer、模型菜单与建议列表的局部类型。
 * Local types for chat composer, model menu, and suggestion popovers.
 */

import type {
  AgentContextAgentItem,
  AgentContextSlashItem,
  ClaudePermissionMode,
  ProjectFileSearchItem,
} from '../../claude-chat-types'

/** 模型下拉菜单一行展示数据 / One row in the model picker menu */
export type ChatModelMenuRow = {
  pickKey: string
  providerId: string
  anthropicModelId: string
  useOverlayPick: boolean
  supportsImages: boolean
  headline: string
  metaLine: string
}

/** Composer 内触发自动完成的光标区间 / Composer autocomplete trigger span */
export type ComposerTrigger =
  | {
      kind: 'slash'
      query: string
      start: number
      end: number
    }
  | {
      kind: 'mention'
      query: string
      start: number
      end: number
    }

/** 内置 slash 命令元数据 / Built-in slash command metadata */
export type BuiltInSlashCommand = {
  kind: 'built-in'
  command: string
  title: string
  description: string
  argumentHint: string
}

/** Composer 自动完成候选项联合 / Composer suggestion union */
export type ComposerSuggestion =
  | {
      id: string
      kind: 'slash'
      title: string
      subtitle: string
      insertText: string
      item: AgentContextSlashItem | BuiltInSlashCommand
    }
  | {
      id: string
      kind: 'file'
      title: string
      subtitle: string
      insertText: string
      item: ProjectFileSearchItem
    }
  | {
      id: string
      kind: 'agent'
      title: string
      subtitle: string
      insertText: string
      item: AgentContextAgentItem
    }

/** 权限模式下拉一行 / Permission mode picker row */
export type PermissionModeRow = {
  mode: ClaudePermissionMode
  label: string
  description: string
}
