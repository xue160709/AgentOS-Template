/**
 * 对话输入框壳：附件、模型与权限弹出层（portal）。
 * Composer chrome managing textarea attachments plus portal pickers.
 */

import { createPortal } from 'react-dom'
import type {
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  RefObject,
  SetStateAction,
} from 'react'
import type {
  ClaudeChatAttachment,
  ClaudePermissionMode,
} from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { AttachmentThumb } from './AttachmentThumb'
import { formatBytes } from './format'
import type { ChatModelMenuRow, ComposerSuggestion, ComposerTrigger, PermissionModeRow } from './local-types'

type PopoverBox = {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

type ComposerProps = {
  inputValue: string
  isRunning: boolean
  activeModelSupportsImages: boolean
  pendingAttachments: ClaudeChatAttachment[]
  permissionMode: ClaudePermissionMode
  permissionModeLabel: string
  permissionModeRows: PermissionModeRow[]
  permissionModeOpen: boolean
  permissionModePopoverBox: PopoverBox | null
  modelPickerOpen: boolean
  modelMenuRows: ChatModelMenuRow[]
  modelMenuSelectionKey: string
  modelPopoverBox: PopoverBox | null
  displayModelName: string
  composerAutocompleteOpen: boolean
  composerAutocompleteBox: PopoverBox | null
  activeComposerTrigger: ComposerTrigger | null
  composerSuggestions: ComposerSuggestion[]
  composerSuggestionIndex: number
  chatInputRef: RefObject<HTMLTextAreaElement | null>
  composerAutocompleteSurfaceRef: RefObject<HTMLDivElement | null>
  permissionModePickerRef: RefObject<HTMLDivElement | null>
  permissionModePopoverAnchorRef: RefObject<HTMLButtonElement | null>
  permissionModePopoverSurfaceRef: RefObject<HTMLDivElement | null>
  modelPickerRef: RefObject<HTMLDivElement | null>
  modelPopoverAnchorRef: RefObject<HTMLButtonElement | null>
  modelPopoverSurfaceRef: RefObject<HTMLDivElement | null>
  setPermissionMode: Dispatch<SetStateAction<ClaudePermissionMode>>
  setPermissionModeOpen: Dispatch<SetStateAction<boolean>>
  setModelPickerOpen: Dispatch<SetStateAction<boolean>>
  setComposerSuggestionIndex: Dispatch<SetStateAction<number>>
  onInputChange: (value: string, selectionStart: number, selectionEnd: number) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onSyncComposerSelection: () => void
  onFormSubmit: (event: FormEvent<HTMLFormElement>) => void
  onSendClick: (event: MouseEvent<HTMLButtonElement>) => void
  onAddComposerAttachments: () => void
  onRemoveComposerAttachment: (attachmentId: string) => void
  onInsertComposerSuggestion: (suggestion: ComposerSuggestion) => void
  onPickChatMenuRow: (row: ChatModelMenuRow) => void
}

/** 主composer表单容器 / Primary composer form rendering portals */
export function Composer({
  inputValue,
  isRunning,
  activeModelSupportsImages,
  pendingAttachments,
  permissionMode,
  permissionModeLabel,
  permissionModeRows,
  permissionModeOpen,
  permissionModePopoverBox,
  modelPickerOpen,
  modelMenuRows,
  modelMenuSelectionKey,
  modelPopoverBox,
  displayModelName,
  composerAutocompleteOpen,
  composerAutocompleteBox,
  activeComposerTrigger,
  composerSuggestions,
  composerSuggestionIndex,
  chatInputRef,
  composerAutocompleteSurfaceRef,
  permissionModePickerRef,
  permissionModePopoverAnchorRef,
  permissionModePopoverSurfaceRef,
  modelPickerRef,
  modelPopoverAnchorRef,
  modelPopoverSurfaceRef,
  setPermissionMode,
  setPermissionModeOpen,
  setModelPickerOpen,
  setComposerSuggestionIndex,
  onInputChange,
  onCompositionStart,
  onCompositionEnd,
  onInputKeyDown,
  onSyncComposerSelection,
  onFormSubmit,
  onSendClick,
  onAddComposerAttachments,
  onRemoveComposerAttachment,
  onInsertComposerSuggestion,
  onPickChatMenuRow,
}: ComposerProps) {
  const { t } = useI18n()
  const hasSendText = inputValue.trim().length > 0
  const hasComposerAttachments = pendingAttachments.length > 0
  const hasUnsupportedImageAttachment =
    !activeModelSupportsImages && pendingAttachments.some((attachment) => attachment.kind === 'image')

  return (
    <div className="chat-composer-wrap no-drag">
      <form className="chat-composer" id="chat-form" onSubmit={onFormSubmit}>
        {pendingAttachments.length > 0 ? (
          <div className="composer-attachments" aria-label={t('chat.attachmentsAria')}>
            {pendingAttachments.map((attachment) => (
              <ComposerAttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onRemoveComposerAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}
        <textarea
          ref={chatInputRef}
          className="chat-input"
          id="chat-input"
          rows={1}
          placeholder={t('chat.composerPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value, event.target.selectionStart, event.target.selectionEnd)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={onInputKeyDown}
          onKeyUp={onSyncComposerSelection}
          onClick={onSyncComposerSelection}
          onSelect={onSyncComposerSelection}
        />
        {composerAutocompleteOpen && composerAutocompleteBox
          ? createPortal(
              <div
                ref={composerAutocompleteSurfaceRef}
                className="composer-autocomplete-popover"
                role="listbox"
                aria-label={activeComposerTrigger?.kind === 'slash' ? t('chat.autocompleteSlashAria') : t('chat.autocompleteMentionAria')}
                style={{
                  position: 'fixed',
                  left: composerAutocompleteBox.left,
                  bottom: composerAutocompleteBox.bottom,
                  width: composerAutocompleteBox.width,
                  maxHeight: composerAutocompleteBox.maxHeight,
                }}
              >
                {composerSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    role="option"
                    aria-selected={index === composerSuggestionIndex}
                    className={`composer-autocomplete-option${index === composerSuggestionIndex ? ' is-selected' : ''}`}
                    onMouseEnter={() => setComposerSuggestionIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onInsertComposerSuggestion(suggestion)}
                  >
                    <IconInline
                      name={
                        suggestion.kind === 'file'
                          ? suggestion.item.type === 'directory'
                            ? 'folder'
                            : 'file'
                          : suggestion.kind === 'agent'
                            ? 'branch'
                            : 'chip'
                      }
                    />
                    <span className="composer-autocomplete-option__copy">
                      <span>{suggestion.title}</span>
                      <span>{suggestion.subtitle}</span>
                    </span>
                  </button>
                ))}
              </div>,
              document.body,
            )
          : null}
        <div className="composer-footer">
          <div className="composer-actions">
            <button
              type="button"
              className="composer-icon-button"
              title={activeModelSupportsImages ? t('chat.addAttachmentTitle') : t('chat.addTextAttachmentTitle')}
              aria-label={activeModelSupportsImages ? t('chat.addAttachmentAria') : t('chat.addTextAttachmentAria')}
              disabled={isRunning}
              onClick={() => onAddComposerAttachments()}
            >
              <IconInline name="paperclip" />
            </button>
            <div className="composer-mode-picker" ref={permissionModePickerRef}>
              <button
                ref={permissionModePopoverAnchorRef}
                type="button"
                className={`composer-mode-button${permissionModeOpen ? ' is-open' : ''}`}
                title={t('chat.permissionModeTitle')}
                aria-label={t('chat.permissionModeAria')}
                aria-expanded={permissionModeOpen}
                aria-haspopup="menu"
                disabled={isRunning}
                onClick={() => {
                  if (isRunning) return
                  setPermissionModeOpen((open) => !open)
                }}
              >
                <IconInline name="shield" />
                <span>{permissionModeLabel}</span>
                <IconInline name="chevron" />
              </button>
              {permissionModeOpen && permissionModePopoverBox
                ? createPortal(
                    <div
                      ref={permissionModePopoverSurfaceRef}
                      className="composer-mode-popover"
                      role="menu"
                      aria-label={t('chat.permissionModeMenuAria')}
                      style={{
                        position: 'fixed',
                        left: permissionModePopoverBox.left,
                        bottom: permissionModePopoverBox.bottom,
                        width: permissionModePopoverBox.width,
                        maxHeight: permissionModePopoverBox.maxHeight,
                      }}
                    >
                      {permissionModeRows.map((row) => {
                        const checked = row.mode === permissionMode
                        return (
                          <button
                            key={row.mode}
                            type="button"
                            role="menuitemradio"
                            className={`composer-mode-option${checked ? ' is-selected' : ''}`}
                            aria-checked={checked}
                            onClick={() => {
                              setPermissionMode(row.mode)
                              setPermissionModeOpen(false)
                            }}
                          >
                            <span className="composer-mode-option__label">{row.label}</span>
                            <span className="composer-mode-option__meta">{row.description}</span>
                          </button>
                        )
                      })}
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          </div>
          <div className="composer-actions composer-actions--end">
            <div className="composer-model-picker" ref={modelPickerRef}>
              <button
                ref={modelPopoverAnchorRef}
                type="button"
                className={`composer-model-button${modelPickerOpen ? ' is-open' : ''}`}
                id="composer-model-trigger"
                title={t('chat.modelPickerTitle')}
                aria-label={t('chat.modelPickerAria')}
                aria-expanded={modelPickerOpen}
                aria-haspopup="menu"
                disabled={isRunning || modelMenuRows.length === 0}
                onClick={() => {
                  if (isRunning || modelMenuRows.length === 0) return
                  setModelPickerOpen((open) => !open)
                }}
              >
                <span id="composer-model">{displayModelName}</span>
                <IconInline name="chevron" />
              </button>
              {modelPickerOpen && modelMenuRows.length > 0 && modelPopoverBox
                ? createPortal(
                    <div
                      ref={modelPopoverSurfaceRef}
                      className="composer-model-popover"
                      role="menu"
                      aria-label={t('chat.modelMenuAria')}
                      style={{
                        position: 'fixed',
                        left: modelPopoverBox.left,
                        bottom: modelPopoverBox.bottom,
                        width: modelPopoverBox.width,
                        maxHeight: modelPopoverBox.maxHeight,
                      }}
                    >
                      {modelMenuRows.map((row) => {
                        const checked = row.pickKey === modelMenuSelectionKey
                        return (
                          <button
                            key={row.pickKey}
                            type="button"
                            role="menuitemradio"
                            className={`composer-model-option${checked ? ' is-selected' : ''}`}
                            aria-checked={checked}
                            title={row.metaLine || undefined}
                            onClick={() => onPickChatMenuRow(row)}
                          >
                            <span className="composer-model-option__label">
                              <span>{row.headline}</span>
                              {row.supportsImages ? (
                                <span
                                  className="composer-model-option__capability"
                                  title={t('chat.modelSupportsImages')}
                                  aria-label={t('chat.modelSupportsImages')}
                                >
                                  <IconInline name="image" />
                                </span>
                              ) : null}
                            </span>
                            <span className="composer-model-option__meta">{row.metaLine}</span>
                          </button>
                        )
                      })}
                    </div>,
                    document.body,
                  )
                : null}
            </div>
            <button
              type="submit"
              className="composer-send-button"
              id="btn-send"
              title={isRunning ? t('chat.stop') : hasUnsupportedImageAttachment ? t('chat.imageInputDisabledTitle') : t('chat.send')}
              aria-label={isRunning ? t('chat.stop') : t('chat.send')}
              disabled={!isRunning && ((!hasSendText && !hasComposerAttachments) || hasUnsupportedImageAttachment)}
              onClick={onSendClick}
            >
              <IconInline name={isRunning ? 'stop' : 'send'} />
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function ComposerAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ClaudeChatAttachment
  onRemove: () => void
}) {
  const { t } = useI18n()
  const label = attachment.kind === 'image' ? t('chat.attachmentImage') : t('chat.attachmentText')

  return (
    <div className={`composer-attachment composer-attachment--${attachment.kind}`}>
      <AttachmentThumb attachment={attachment} />
      <span className="composer-attachment__copy">
        <span>{attachment.name}</span>
        <span>{[label, attachment.preview || formatBytes(attachment.size)].filter(Boolean).join(' · ')}</span>
      </span>
      <button
        type="button"
        className="composer-attachment__remove"
        title={t('chat.removeAttachment')}
        aria-label={t('chat.removeAttachment')}
        onClick={onRemove}
      >
        <IconInline name="x" />
      </button>
    </div>
  )
}
