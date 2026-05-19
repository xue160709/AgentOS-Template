/**
 * Best-effort main-process logging that never crashes the app on broken stdout/stderr.
 */

type ConsoleMethod = 'info' | 'warn' | 'error'

let safeStdStreamHandlersInstalled = false

export function installSafeStdStreamHandlers(): void {
  if (safeStdStreamHandlersInstalled) return
  safeStdStreamHandlersInstalled = true

  for (const stream of [process.stdout, process.stderr]) {
    stream?.on('error', () => {
      // GUI launches may not have a live terminal; ignore broken-pipe stream errors.
    })
  }
}

export function safeConsoleInfo(...args: unknown[]): void {
  safeConsole('info', args)
}

export function safeConsoleWarn(...args: unknown[]): void {
  safeConsole('warn', args)
}

export function safeConsoleError(...args: unknown[]): void {
  safeConsole('error', args)
}

function safeConsole(method: ConsoleMethod, args: unknown[]): void {
  try {
    const logger = console[method]
    if (typeof logger === 'function') {
      logger.apply(console, args)
    }
  } catch {
    // Logging is best-effort only; ignore broken pipe and similar stream failures.
  }
}
