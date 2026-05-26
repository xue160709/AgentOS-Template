/**
 * Agent AskUserQuestion 与权限弹窗覆层。
 * Modal/backdrop stack for AskUserQuestion prompts and tool permission flows.
 */

import { useEffect, useState } from 'react'
import type { ClaudeAskUserQuestion, ClaudeChatEvent } from '../../claude-chat-types'
import { useI18n } from '../../i18n/i18n'
import { renderMarkdown } from './markdown'

/** 排队中的用户问答或权限提示载荷 / Pending user prompt payloads streamed from main */
export type PendingUserInputPrompt =
  | Extract<ClaudeChatEvent, { type: 'ask_user_question' }>
  | Extract<ClaudeChatEvent, { type: 'permission_request' }>

/** 用户对 Agent 提问模态的决定 / User modal resolution payload */
export type UserInputDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message?: string
    }

/** Agent 权限或问卷对话框主体 / Modal shell rendering markdown-backed prompts */
export function AgentInputPromptModal({
  prompt,
  onResolve,
}: {
  prompt: PendingUserInputPrompt
  onResolve: (decision: UserInputDecision) => void
}) {
  const { t } = useI18n()

  if (prompt.type === 'permission_request') {
    return (
      <div className="agent-input-backdrop" role="presentation">
        <section className="agent-input-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-permission-title">
          <div className="agent-input-dialog__header">
            <span>{prompt.displayName || prompt.toolName}</span>
            <h2 id="agent-permission-title">{prompt.title || t('chat.permissionRequestTitle')}</h2>
            {prompt.description ? <p>{prompt.description}</p> : null}
          </div>
          {prompt.inputPreview ? <pre className="agent-input-preview">{prompt.inputPreview}</pre> : null}
          <div className="agent-input-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onResolve({ behavior: 'deny', message: t('chat.permissionDeniedByUser') })}
            >
              {t('chat.permissionDeny')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onResolve({ behavior: 'allow' })}>
              {t('chat.permissionAllow')}
            </button>
          </div>
        </section>
      </div>
    )
  }

  return <AskUserQuestionModal prompt={prompt} onResolve={onResolve} />
}

function AskUserQuestionModal({
  prompt,
  onResolve,
}: {
  prompt: Extract<PendingUserInputPrompt, { type: 'ask_user_question' }>
  onResolve: (decision: UserInputDecision) => void
}) {
  const { t } = useI18n()
  const [singleAnswers, setSingleAnswers] = useState<Record<string, string>>({})
  const [multiAnswers, setMultiAnswers] = useState<Record<string, string[]>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})

  useEffect(() => {
    setSingleAnswers({})
    setMultiAnswers({})
    setCustomAnswers({})
  }, [prompt.permissionRequestId])

  const canSubmit = prompt.questions.every((question) => {
    const custom = customAnswers[question.question]?.trim()
    if (custom) return true
    if (question.multiSelect) return (multiAnswers[question.question] ?? []).length > 0
    return Boolean(singleAnswers[question.question])
  })

  const submitAnswers = () => {
    const answers: Record<string, string | string[]> = {}
    for (const question of prompt.questions) {
      const custom = customAnswers[question.question]?.trim()
      if (question.multiSelect) {
        const selected = multiAnswers[question.question] ?? []
        answers[question.question] = custom ? [...selected, custom] : selected
        continue
      }
      answers[question.question] = custom || singleAnswers[question.question] || question.options[0]?.label || ''
    }

    onResolve({
      behavior: 'allow',
      updatedInput: {
        questions: prompt.questions,
        answers,
      },
    })
  }

  return (
    <div className="agent-input-backdrop" role="presentation">
      <section className="agent-input-dialog agent-input-dialog--question" role="dialog" aria-modal="true" aria-labelledby="agent-question-title">
        <div className="agent-input-dialog__header">
          <span>{t('chat.askQuestionEyebrow')}</span>
          <h2 id="agent-question-title">{t('chat.askQuestionTitle')}</h2>
        </div>
        <div className="agent-question-list">
          {prompt.questions.map((question, questionIndex) => (
            <AskUserQuestionBlock
              key={`${question.question}-${questionIndex}`}
              question={question}
              customValue={customAnswers[question.question] ?? ''}
              multiValue={multiAnswers[question.question] ?? []}
              singleValue={singleAnswers[question.question] ?? ''}
              onCustomChange={(value) =>
                setCustomAnswers((prev) => ({
                  ...prev,
                  [question.question]: value,
                }))
              }
              onMultiChange={(label, checked) =>
                setMultiAnswers((prev) => {
                  const current = prev[question.question] ?? []
                  const next = checked ? [...new Set([...current, label])] : current.filter((item) => item !== label)
                  return { ...prev, [question.question]: next }
                })
              }
              onSingleChange={(label) =>
                setSingleAnswers((prev) => ({
                  ...prev,
                  [question.question]: label,
                }))
              }
              canSubmit={canSubmit}
              onSubmit={submitAnswers}
            />
          ))}
        </div>
        <div className="agent-input-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onResolve({ behavior: 'deny', message: t('chat.askQuestionCancelled') })}
          >
            {t('chat.askQuestionCancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submitAnswers}>
            {t('chat.askQuestionSubmit')}
          </button>
        </div>
      </section>
    </div>
  )
}

function AskUserQuestionBlock({
  question,
  singleValue,
  multiValue,
  customValue,
  onSingleChange,
  onMultiChange,
  onCustomChange,
  canSubmit,
  onSubmit,
}: {
  question: ClaudeAskUserQuestion
  singleValue: string
  multiValue: string[]
  customValue: string
  onSingleChange: (label: string) => void
  onMultiChange: (label: string, checked: boolean) => void
  onCustomChange: (value: string) => void
  canSubmit: boolean
  onSubmit: () => void
}) {
  const { t } = useI18n()
  const inputName = `ask-${stableDomId(question.question)}`

  return (
    <fieldset className="agent-question-block">
      <legend>
        <span>{question.header}</span>
        {question.question}
      </legend>
      <div className="agent-question-options">
        {question.options.map((option) => {
          const checked = question.multiSelect ? multiValue.includes(option.label) : singleValue === option.label
          return (
            <label key={option.label} className={`agent-question-option${checked ? ' is-selected' : ''}`}>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={inputName}
                checked={checked}
                onChange={(event) => {
                  if (question.multiSelect) {
                    onMultiChange(option.label, event.currentTarget.checked)
                    return
                  }
                  onSingleChange(option.label)
                }}
              />
              <span className="agent-question-option__copy">
                <span>{option.label}</span>
                <span>{option.description}</span>
              </span>
              {option.preview ? (
                <div
                  className="agent-question-option__preview markdown-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(option.preview) }}
                />
              ) : null}
            </label>
          )
        })}
      </div>
      <label className="agent-question-custom">
        <span>{t('chat.askQuestionCustom')}</span>
        <input
          type="text"
          value={customValue}
          placeholder={t('chat.askQuestionCustomPlaceholder')}
          onChange={(event) => onCustomChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (canSubmit) onSubmit()
          }}
        />
      </label>
    </fieldset>
  )
}

function stableDomId(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}
