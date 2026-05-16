/**
 * Claude Agent SDK 环境变量拼装与日志脱敏工具。
 * Build SDK env vars from resolved config and redact secrets for logs.
 */

import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'

/** 生成用于失效会话的配置指纹 / Fingerprint config for session invalidation */
export function getConfigSignature(config: ClaudeAgentResolvedConfig): string {
  return JSON.stringify([
    config.configSource,
    config.apiKey,
    config.authToken,
    config.baseUrl,
    config.model,
    config.supportsImages,
    config.defaultHaikuModel,
    config.defaultOpusModel,
    config.defaultSonnetModel,
  ])
}

/** 合并进程环境与 Anthropic 相关变量供子进程使用 / Merge process.env with Anthropic vars for child SDK */
export function buildSdkEnv(config: ClaudeAgentResolvedConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'codex-ui-template/0.0.0',
  }

  if (config.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = config.authToken
    env.ANTHROPIC_API_KEY = undefined
  } else if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey
    env.ANTHROPIC_AUTH_TOKEN = undefined
  }
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl
  if (config.model) env.ANTHROPIC_MODEL = config.model
  if (config.defaultHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.defaultHaikuModel
  if (config.defaultOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.defaultOpusModel
  if (config.defaultSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.defaultSonnetModel

  return env
}

/** 结构化输出解析后的配置（脱敏）/ Structured resolved config for logging */
export function summarizeConfigForLog(config: ClaudeAgentResolvedConfig): Record<string, unknown> {
  return {
    configSource: config.configSource,
    hasApiKey: Boolean(config.apiKey),
    apiKey: redactSecret(config.apiKey),
    hasAuthToken: Boolean(config.authToken),
    authToken: redactSecret(config.authToken),
    baseUrl: config.baseUrl,
    model: config.model,
    supportsImages: config.supportsImages,
    defaultHaikuModel: config.defaultHaikuModel,
    defaultSonnetModel: config.defaultSonnetModel,
    defaultOpusModel: config.defaultOpusModel,
  }
}

/** SDK 子进程环境快照（脱敏）/ Redacted snapshot of env passed to SDK */
export function summarizeSdkEnvForLog(env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY),
    ANTHROPIC_API_KEY: redactSecret(env.ANTHROPIC_API_KEY ?? ''),
    hasAnthropicAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
    ANTHROPIC_AUTH_TOKEN: redactSecret(env.ANTHROPIC_AUTH_TOKEN ?? ''),
  }
}

/** 任意异常的可日志化结构 / Serialize unknown errors for logs */
export function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const maybeCause = (error as Error & { cause?: unknown }).cause
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: maybeCause instanceof Error ? { name: maybeCause.name, message: maybeCause.message } : maybeCause,
    }
  }
  return { value: String(error) }
}

function redactSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return `***(${trimmed.length})`
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}(${trimmed.length})`
}
