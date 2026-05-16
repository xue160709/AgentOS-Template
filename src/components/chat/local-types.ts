import type {
  AgentContextAgentItem,
  AgentContextSlashItem,
  ClaudePermissionMode,
  ProjectFileSearchItem,
} from '../../claude-chat-types'

export type ChatModelMenuRow = {
  pickKey: string
  providerId: string
  anthropicModelId: string
  useOverlayPick: boolean
  supportsImages: boolean
  headline: string
  metaLine: string
}

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

export type BuiltInSlashCommand = {
  kind: 'built-in'
  command: string
  title: string
  description: string
  argumentHint: string
}

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

export type PermissionModeRow = {
  mode: ClaudePermissionMode
  label: string
  description: string
}
