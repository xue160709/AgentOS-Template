/**
 * 顶栏 Agent 状态入口与轻量状态浮层。
 * Toolbar Agent status entry and lightweight status popover.
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import type { ClaudeAgentStatusHealth, ClaudeAgentStatusSnapshot } from '../claude-chat-types'
import { IconInline } from '../icon-inline'
import { useI18n } from '../i18n/i18n'
import { formatDuration } from './chat/format'

type AppAgentStatusPopoverProps = {
  open: boolean
  loading: boolean
  running: boolean
  snapshot: ClaudeAgentStatusSnapshot | null
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
}

const CONTEXT_COLORS = ['#7c8cff', '#4fb286', '#d99a48', '#a477d4', '#de6d75', '#6ca6c1']

/** TODO 浮层风格的 Agent 状态面板 / Agent status popover matching the TODO floating-panel language */
export function AppAgentStatusPopover({
  open,
  loading,
  running,
  snapshot,
  onOpenChange,
  onRefresh,
}: AppAgentStatusPopoverProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const health = running ? 'running' : snapshot?.health ?? 'idle'
  const usage = snapshot?.lastUsage
  const context = snapshot?.contextUsage
  const categories = useMemo(
    () => (context?.categories ?? []).filter((category) => category.tokens > 0).sort((a, b) => b.tokens - a.tokens),
    [context?.categories],
  )
  const capabilitySummary = summarizeCapabilities(snapshot, t)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      onOpenChange(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onOpenChange, open])

  return (
    <div className="agent-status-menu" ref={rootRef}>
      <button
        type="button"
        className={`agent-status-trigger agent-status-trigger--${health}${open ? ' is-open' : ''}`}
        title={`${t('statusPanel.openTitle')} · ${t(`statusPanel.health.${health}`)}`}
        aria-label={t('statusPanel.openAria')}
        aria-controls="agent-status-panel"
        aria-expanded={open}
        onClick={() => {
          const nextOpen = !open
          onOpenChange(nextOpen)
          if (nextOpen) onRefresh()
        }}
      >
        <IconInline name="server" />
        <span className="agent-status-trigger__dot" aria-hidden="true" />
      </button>
      {open ? (
        <section id="agent-status-panel" className="agent-status-panel" aria-label={t('statusPanel.heading')}>
          <header className="agent-status-panel__header">
            <div className="agent-status-panel__title">
              <IconInline name="server" />
              <span>{t('statusPanel.heading')}</span>
            </div>
            <button
              type="button"
              className="btn btn-toolbar"
              title={t('statusPanel.refreshTitle')}
              aria-label={t('statusPanel.refreshAria')}
              disabled={loading}
              onClick={onRefresh}
            >
              <IconInline name="refresh" />
            </button>
          </header>
          {loading && !snapshot ? <p className="agent-status-panel__empty">{t('statusPanel.loading')}</p> : null}
          {snapshot ? (
            <div className="agent-status-panel__body">
              <section className="agent-status-panel__overview">
                <div className="agent-status-panel__overview-copy">
                  <strong>{snapshot.configuredModel || t('statusPanel.unknown')}</strong>
                  <span>{routeSummary(snapshot, t)}</span>
                </div>
                <span className={`agent-status-panel__health agent-status-panel__health--${health}`}>
                  <span className="agent-status-panel__health-dot" aria-hidden="true" />
                  {t(`statusPanel.health.${health}`)}
                </span>
              </section>
              {health === 'error' || health === 'partial' || health === 'unconfigured' ? (
                <p className={`agent-status-panel__notice agent-status-panel__notice--${health}`}>{t(`statusPanel.healthHint.${health}`)}</p>
              ) : null}
              <StatusSection title={t('statusPanel.contextSection')} accessory={context ? `${Math.round(context.percentage)}%` : undefined}>
                {context ? (
                  <ContextUsageView context={context} categories={categories} />
                ) : (
                  <p className="agent-status-panel__section-empty">{t('statusPanel.contextUnavailable')}</p>
                )}
              </StatusSection>
              <StatusDetails title={t('statusPanel.capabilitySection')} summary={capabilitySummary}>
                <StatusRow label={t('statusPanel.tools')} value={knownCount(snapshot.tools, t)} />
                <StatusRow label={t('statusPanel.skills')} value={knownCount(snapshot.skills, t)} />
                <StatusRow label={t('statusPanel.commands')} value={knownCount(snapshot.slashCommands, t)} />
                <StatusRow label={t('statusPanel.plugins')} value={knownCount(snapshot.plugins, t)} />
                <CapabilityList label={t('statusPanel.skills')} items={snapshot.skills} />
                <CapabilityList label={t('statusPanel.commands')} items={snapshot.slashCommands} />
                <CapabilityList label={t('statusPanel.tools')} items={snapshot.tools} />
                <McpList servers={snapshot.mcpServers} />
              </StatusDetails>
              <StatusDetails title={t('statusPanel.diagnosticSection')}>
                <StatusRow label={t('statusPanel.route')} value={t(`statusPanel.routeValue.${snapshot.route}`)} />
                {snapshot.route === 'custom-gateway' ? (
                  <StatusRow label={t('statusPanel.endpoint')} value={snapshot.endpointHost || snapshot.baseUrl || t('statusPanel.unknown')} mono />
                ) : null}
                <StatusRow label={t('statusPanel.authentication')} value={t(`statusPanel.authValue.${snapshot.authentication}`)} />
                <StatusRow label={t('statusPanel.sessionId')} value={snapshot.sessionId || t('statusPanel.notEstablished')} mono />
                <StatusRow label={t('statusPanel.cwd')} value={snapshot.cwd || t('statusPanel.unknown')} mono />
                <StatusRow label={t('statusPanel.permissionMode')} value={snapshot.permissionMode || t('statusPanel.notReported')} />
                <StatusRow label={t('statusPanel.claudeCodeVersion')} value={snapshot.claudeCodeVersion || t('statusPanel.notReported')} />
              </StatusDetails>
              {usage ? (
                <div className="agent-status-panel__usage">
                  <span>{t('statusPanel.latestTurn')}</span>
                  <span>{summarizeTokens(snapshot)}</span>
                  <span>${usage.costUsd.toFixed(4)}</span>
                  <span>{formatDuration(usage.durationMs) || '-'}</span>
                </div>
              ) : null}
              {snapshot.lastError ? (
                <div className="agent-status-panel__error" role="status">
                  <strong>{t('statusPanel.lastError')}</strong>
                  <p>{snapshot.lastError}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function ContextUsageView({
  context,
  categories,
}: {
  context: NonNullable<ClaudeAgentStatusSnapshot['contextUsage']>
  categories: NonNullable<ClaudeAgentStatusSnapshot['contextUsage']>['categories']
}) {
  const { t } = useI18n()
  return (
    <div className="agent-status-panel__context">
      <div className="agent-status-panel__context-total">
        <strong>{formatTokenCount(context.totalTokens)} / {formatTokenCount(context.maxTokens)}</strong>
        <span>{t('statusPanel.contextTokens')}</span>
      </div>
      <div className="agent-status-panel__context-bar" aria-label={t('statusPanel.contextProgress', { percent: Math.round(context.percentage) })}>
        {categories.map((category, index) => (
          <span
            key={`${category.name}-${index}`}
            style={{
              '--context-color': contextCategoryColor(category, index),
              width: `${Math.max(0.75, (category.tokens / Math.max(1, context.maxTokens)) * 100)}%`,
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="agent-status-panel__context-legend">
        {categories.slice(0, 5).map((category, index) => (
          <div key={`${category.name}-${index}`}>
            <span className="agent-status-panel__context-dot" style={{ '--context-color': contextCategoryColor(category, index) } as CSSProperties} />
            <span title={category.name}>{contextCategoryLabel(category.name, t)}</span>
            <strong>{formatTokenCount(category.tokens)}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusSection({ title, accessory, children }: { title: string; accessory?: string; children: ReactNode }) {
  return (
    <section className="agent-status-panel__section">
      <div className="agent-status-panel__section-heading">
        <h3>{title}</h3>
        {accessory ? <span>{accessory}</span> : null}
      </div>
      {children}
    </section>
  )
}

function StatusDetails({ title, summary, children }: { title: string; summary?: string; children: ReactNode }) {
  return (
    <details className="agent-status-panel__details">
      <summary>
        <span>{title}</span>
        {summary ? <strong>{summary}</strong> : null}
      </summary>
      <div className="agent-status-panel__details-body">{children}</div>
    </details>
  )
}

function StatusRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="agent-status-panel__row">
      <span>{label}</span>
      <span className={mono ? 'is-mono' : undefined} title={value}>{value}</span>
    </div>
  )
}

function CapabilityList({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null
  const visible = items.slice(0, 8)
  return (
    <div className="agent-status-panel__capability-list">
      <span>{label}</span>
      <div>
        {visible.map((item) => <span key={item} title={item}>{item}</span>)}
        {items.length > visible.length ? <span>+{items.length - visible.length}</span> : null}
      </div>
    </div>
  )
}

function McpList({ servers }: { servers: ClaudeAgentStatusSnapshot['mcpServers'] }) {
  const { t } = useI18n()
  if (!servers) return <p className="agent-status-panel__section-empty">{t('statusPanel.capabilityUnavailable')}</p>
  if (servers.length === 0) return <p className="agent-status-panel__section-empty">{t('statusPanel.noMcp')}</p>
  return (
    <div className="agent-status-panel__mcp-list">
      {servers.map((server) => (
        <div className="agent-status-panel__mcp-row" key={server.name}>
          <span className={`agent-status-panel__mcp-dot agent-status-panel__mcp-dot--${mcpTone(server.status)}`} aria-hidden="true" />
          <span>{server.name}</span>
          <span>{server.status}</span>
        </div>
      ))}
    </div>
  )
}

function routeSummary(snapshot: ClaudeAgentStatusSnapshot, t: (path: string) => string): string {
  if (snapshot.route === 'custom-gateway') return snapshot.endpointHost || t('statusPanel.routeValue.custom-gateway')
  return t('statusPanel.routeValue.anthropic-default')
}

function summarizeCapabilities(snapshot: ClaudeAgentStatusSnapshot | null, t: (path: string) => string): string {
  if (!snapshot) return t('statusPanel.notLoaded')
  return [
    `${t('statusPanel.tools')} ${knownCount(snapshot.tools, t)}`,
    `${t('statusPanel.skills')} ${knownCount(snapshot.skills, t)}`,
    `MCP ${knownCount(snapshot.mcpServers, t)}`,
  ].join(' · ')
}

function knownCount(items: unknown[] | undefined, t: (path: string) => string): string {
  return items ? String(items.length) : t('statusPanel.notLoaded')
}

function summarizeTokens(snapshot: ClaudeAgentStatusSnapshot | null): string {
  const models = snapshot?.lastUsage?.models ?? []
  const input = models.reduce((sum, model) => sum + model.inputTokens, 0)
  const output = models.reduce((sum, model) => sum + model.outputTokens, 0)
  return `${formatTokenCount(input)} / ${formatTokenCount(output)}`
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

function contextCategoryColor(category: { name: string; color: string }, index: number): string {
  const name = category.name.trim().toLowerCase()
  if (name.includes('free')) return '#3f4146'
  if (name.includes('compact') || name.includes('buffer')) return '#6f6887'
  if (name.includes('message')) return '#d99a48'
  if (name.includes('skill')) return '#a477d4'
  if (name.includes('tool') || name.includes('mcp')) return '#6ca6c1'
  if (name.includes('memory')) return '#de6d75'
  if (name.includes('system') || name.includes('prompt')) return '#7c8cff'
  if (name.includes('agent')) return '#4fb286'
  const value = category.color.trim()
  if (/^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))$/i.test(value)) return value
  return CONTEXT_COLORS[index % CONTEXT_COLORS.length]
}

function contextCategoryLabel(name: string, t: (path: string) => string): string {
  if (name.trim().toLowerCase() === 'skills') return t('statusPanel.contextCategory.commandMetadata')
  return name
}

function mcpTone(status: string): ClaudeAgentStatusHealth {
  if (status === 'connected') return 'ready'
  if (status === 'failed') return 'error'
  return 'partial'
}
