/**
 * 应用与作者元数据（package.json、关于面板、设置页、README 等共用来源）。
 * Shared app and author metadata for package.json, about panel, settings, and docs.
 */

export const APP_METADATA = {
  productName: 'AgentOS',
  authorName: 'xuezhirong',
  authorEmail: 'xue160709@gmail.com',
  authorWeChat: 'xuezhirong233',
  githubOwner: 'xue160709',
  githubRepo: 'AgentOS',
  homepage: 'https://github.com/xue160709/AgentOS',
  issuesUrl: 'https://github.com/xue160709/AgentOS/issues',
  license: 'MIT',
  copyrightYear: 2026,
} as const

export function appCopyrightLine(): string {
  return `Copyright © ${APP_METADATA.copyrightYear} ${APP_METADATA.authorName}`
}

export function appAuthorPackageField(): string {
  return `${APP_METADATA.authorName} <${APP_METADATA.authorEmail}> (https://github.com/${APP_METADATA.githubOwner})`
}
