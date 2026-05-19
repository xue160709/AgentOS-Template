/**
 * 将 Claude Code Edit/Write 工具输出归一化为 UI 可渲染的文件 diff。
 * Normalize Claude Code Edit/Write tool output into renderer-friendly file diffs.
 */

import path from 'node:path'
import type {
  ClaudeFileDiffFile,
  ClaudeFileDiffFileStatus,
  ClaudeFileDiffHunk,
  ClaudeFileDiffLine,
} from '../../src/claude-chat-types'

const MAX_DIFF_LINES_PER_FILE = 800

/** 从 PostToolUse hook 输入中提取单文件 diff / Extract a single-file diff from PostToolUse hook input */
export function fileDiffFromPostToolUse(input: unknown, cwd: string): ClaudeFileDiffFile | undefined {
  if (!isRecord(input)) return undefined
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'NotebookEdit') return undefined

  const toolInput = isRecord(input.tool_input) ? input.tool_input : {}
  const response = isRecord(input.tool_response) ? input.tool_response : {}
  const filePath = pickString(response.filePath, response.file_path, toolInput.file_path, toolInput.notebook_path)
  if (!filePath) return undefined

  const isCreate = pickString(response.type) === 'create' || response.originalFile === null
  let hunks = normalizeStructuredPatch(response.structuredPatch)
  if (hunks.length === 0 && toolName === 'Write' && isCreate && typeof response.content === 'string') {
    hunks = hunksFromCreatedContent(response.content)
  }
  if (hunks.length === 0) return undefined

  const gitDiff = isRecord(response.gitDiff) ? response.gitDiff : undefined
  const counted = countDiffLines(hunks)
  const status = normalizeFileStatus(pickString(gitDiff?.status), pickString(response.type), toolName)

  return {
    path: filePath,
    relativePath: relativeToCwd(filePath, cwd),
    status,
    additions: toFiniteNumber(gitDiff?.additions, counted.additions),
    deletions: toFiniteNumber(gitDiff?.deletions, counted.deletions),
    hunks,
    truncated: counted.truncated || undefined,
  }
}

function hunksFromCreatedContent(content: string): ClaudeFileDiffHunk[] {
  const rawLines = content.replace(/\r\n/g, '\n').split('\n')
  if (rawLines[rawLines.length - 1] === '') rawLines.pop()
  if (rawLines.length === 0) return []

  let truncated = false
  const visibleLines = rawLines.slice(0, MAX_DIFF_LINES_PER_FILE)
  if (visibleLines.length < rawLines.length) truncated = true

  const lines: ClaudeFileDiffLine[] = visibleLines.map((line, index) => ({
    kind: 'add',
    content: line,
    newLineNumber: index + 1,
  }))
  if (truncated) lines.push({ kind: 'context', content: '... diff truncated ...' })

  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: rawLines.length,
      lines,
    },
  ]
}

function normalizeStructuredPatch(value: unknown): ClaudeFileDiffHunk[] {
  if (!Array.isArray(value)) return []
  const hunks: ClaudeFileDiffHunk[] = []
  let totalLines = 0
  let truncated = false

  for (const rawHunk of value) {
    if (!isRecord(rawHunk)) continue
    const rawLines = Array.isArray(rawHunk.lines) ? rawHunk.lines.filter((line): line is string => typeof line === 'string') : []
    if (rawLines.length === 0) continue

    const oldStart = toFiniteNumber(rawHunk.oldStart, 0)
    const oldLines = toFiniteNumber(rawHunk.oldLines, 0)
    const newStart = toFiniteNumber(rawHunk.newStart, 0)
    const newLines = toFiniteNumber(rawHunk.newLines, 0)
    let oldLine = oldStart
    let newLine = newStart
    const lines: ClaudeFileDiffLine[] = []

    for (const rawLine of rawLines) {
      if (totalLines >= MAX_DIFF_LINES_PER_FILE) {
        truncated = true
        break
      }
      totalLines += 1

      if (rawLine.startsWith('+')) {
        lines.push({ kind: 'add', content: rawLine.slice(1), newLineNumber: newLine })
        newLine += 1
        continue
      }

      if (rawLine.startsWith('-')) {
        lines.push({ kind: 'delete', content: rawLine.slice(1), oldLineNumber: oldLine })
        oldLine += 1
        continue
      }

      const content = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
      lines.push({ kind: 'context', content, oldLineNumber: oldLine, newLineNumber: newLine })
      oldLine += 1
      newLine += 1
    }

    if (lines.length > 0) {
      if (truncated) lines.push({ kind: 'context', content: '... diff truncated ...' })
      hunks.push({ oldStart, oldLines, newStart, newLines, lines })
    }
    if (truncated) break
  }

  return hunks
}

function countDiffLines(hunks: ClaudeFileDiffHunk[]): { additions: number; deletions: number; truncated: boolean } {
  let additions = 0
  let deletions = 0
  let truncated = false
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1
      if (line.kind === 'delete') deletions += 1
      if (line.content === '... diff truncated ...') truncated = true
    }
  }
  return { additions, deletions, truncated }
}

function normalizeFileStatus(rawStatus: string, rawWriteType: string, toolName: string): ClaudeFileDiffFileStatus {
  if (rawStatus === 'added' || rawWriteType === 'create') return 'added'
  if (rawStatus === 'deleted') return 'deleted'
  if (rawStatus === 'modified' || rawWriteType === 'update' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'modified'
  return 'unknown'
}

function relativeToCwd(filePath: string, cwd: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const relative = path.relative(cwd, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath
  return normalizePathSeparators(relative)
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/')
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
