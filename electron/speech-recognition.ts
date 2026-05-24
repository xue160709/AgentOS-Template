/**
 * macOS Apple Speech helper process manager.
 * Spawns the Swift helper and translates its NDJSON protocol into Electron IPC events.
 */

import { app, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net, { type Server, type Socket } from 'node:net'
import path from 'node:path'
import type {
  SpeechRecognitionCommandResult,
  SpeechRecognitionEvent,
  SpeechRecognitionSnapshot,
  SpeechRecognitionStatus,
} from '../src/desktop-types'

export const SPEECH_RECOGNITION_EVENT_CHANNEL = 'desktop:speech-recognition-event'

type SpeechStartOptions = {
  locale?: string
  requiresOnDevice?: boolean
}

type HelperEvent = {
  type?: unknown
  status?: unknown
  text?: unknown
  code?: unknown
  message?: unknown
  locale?: unknown
  supportsOnDevice?: unknown
  requiresOnDevice?: unknown
}

const HELPER_APP_NAME = 'AgentOS Speech Helper.app'
const HELPER_DEV_APP_PATH = path.join('native', 'speech-cli', 'build', HELPER_APP_NAME)
const HELPER_PACKAGED_APP_PATH = path.join('speech', HELPER_APP_NAME)
const SPEECH_STATUSES = new Set<SpeechRecognitionStatus>([
  'unsupported',
  'idle',
  'starting',
  'requesting_permission',
  'listening',
  'transcribing',
  'error',
])

type HelperSession = {
  process: ChildProcess
  server: Server
  socket: Socket
  socketPath: string
  closed: boolean
}

export class MacSpeechRecognitionService {
  private helper: HelperSession | null = null
  private stdoutBuffer = ''
  private status: SpeechRecognitionStatus = process.platform === 'darwin' ? 'idle' : 'unsupported'

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  getSnapshot(): SpeechRecognitionSnapshot {
    return {
      supported: process.platform === 'darwin',
      status: this.status,
    }
  }

  async start(options: SpeechStartOptions = {}): Promise<SpeechRecognitionCommandResult> {
    if (process.platform !== 'darwin') {
      return { ok: false, status: 'unsupported', message: 'Apple Speech recognition is only available on macOS.' }
    }

    try {
      const helper = await this.ensureChild()
      this.emitStatus('starting')
      this.writeCommand(helper, {
        command: 'start',
        locale: typeof options.locale === 'string' ? options.locale : undefined,
        requiresOnDevice: options.requiresOnDevice !== false,
      })
      return { ok: true, status: this.status }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start Apple Speech recognition.'
      this.emitError('helper_start_failed', message)
      return { ok: false, status: this.status, message }
    }
  }

  async stop(): Promise<SpeechRecognitionCommandResult> {
    if (process.platform !== 'darwin') {
      return { ok: false, status: 'unsupported', message: 'Apple Speech recognition is only available on macOS.' }
    }
    if (!this.helper) {
      this.emitStatus('idle')
      return { ok: true, status: this.status }
    }

    this.emitStatus('transcribing')
    this.writeCommand(this.helper, { command: 'stop' })
    return { ok: true, status: this.status }
  }

  async cancel(): Promise<SpeechRecognitionCommandResult> {
    if (!this.helper) {
      this.emitStatus(process.platform === 'darwin' ? 'idle' : 'unsupported')
      return { ok: true, status: this.status }
    }
    this.writeCommand(this.helper, { command: 'cancel' })
    return { ok: true, status: this.status }
  }

  dispose() {
    if (!this.helper) return
    const helper = this.helper
    try {
      this.writeCommand(helper, { command: 'quit' })
    } catch {
      helper.process.kill()
    }
    helper.socket.destroy()
    helper.server.close()
    this.cleanupSocketPath(helper.socketPath)
    this.helper = null
    this.stdoutBuffer = ''
  }

  private async ensureChild(): Promise<HelperSession> {
    if (this.helper && !this.helper.socket.destroyed) return this.helper

    const helperAppPath = await resolveHelperAppPath()
    const helper = await launchHelperApp(helperAppPath)
    this.helper = helper
    this.stdoutBuffer = ''

    helper.socket.setEncoding('utf8')
    helper.socket.on('data', (chunk) => this.handleStdout(String(chunk)))
    helper.socket.on('error', (error) => {
      this.emitError('helper_socket_error', error.message)
    })

    helper.process.stderr?.setEncoding('utf8')
    helper.process.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message) console.warn(`[speech-cli] ${message}`)
    })

    const closeHelper = (reason?: string) => {
      if (helper.closed) return
      helper.closed = true
      const wasActive = this.status !== 'idle' && this.status !== 'unsupported'
      if (this.helper === helper) {
        this.helper = null
        this.stdoutBuffer = ''
      }
      helper.server.close()
      this.cleanupSocketPath(helper.socketPath)
      if (wasActive && reason) {
        this.emitError('helper_exited', `Apple Speech helper exited with ${reason}.`)
      }
      this.emitStatus(process.platform === 'darwin' ? 'idle' : 'unsupported')
    }

    helper.process.on('error', (error) => {
      this.emitError('helper_process_error', error.message)
    })
    helper.process.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      closeHelper(reason)
    })
    helper.socket.on('close', () => {
      closeHelper('closed IPC socket')
    })

    return helper
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.handleHelperLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleHelperLine(line: string) {
    let payload: HelperEvent
    try {
      payload = JSON.parse(line) as HelperEvent
    } catch {
      this.emitError('helper_bad_json', 'Apple Speech helper emitted an invalid event.')
      return
    }

    if (payload.type === 'ready') {
      if (this.status === 'idle' || this.status === 'unsupported' || this.status === 'error') {
        this.emitStatus('idle', payload)
      }
      return
    }

    if (payload.type === 'status') {
      const status = normalizeStatus(payload.status)
      if (!status) return
      this.emitStatus(status, payload)
      return
    }

    if (payload.type === 'partial' && typeof payload.text === 'string') {
      this.emit({ type: 'partial', text: payload.text })
      return
    }

    if (payload.type === 'final' && typeof payload.text === 'string') {
      this.emit({ type: 'final', text: payload.text })
      return
    }

    if (payload.type === 'error') {
      const code = typeof payload.code === 'string' ? payload.code : 'speech_error'
      const message = typeof payload.message === 'string' ? payload.message : 'Apple Speech recognition failed.'
      this.emitError(code, message)
    }

  }

  private writeCommand(helper: HelperSession, command: Record<string, unknown>) {
    if (!helper.socket.writable) {
      throw new Error('Apple Speech helper is not writable.')
    }
    helper.socket.write(`${JSON.stringify(command)}\n`)
  }

  private emitStatus(status: SpeechRecognitionStatus, raw?: HelperEvent) {
    this.status = status
    this.emit({
      type: 'status',
      status,
      locale: typeof raw?.locale === 'string' ? raw.locale : undefined,
      supportsOnDevice: typeof raw?.supportsOnDevice === 'boolean' ? raw.supportsOnDevice : undefined,
      requiresOnDevice: typeof raw?.requiresOnDevice === 'boolean' ? raw.requiresOnDevice : undefined,
    })
  }

  private emitError(code: string, message: string) {
    this.status = 'error'
    console.warn(`[speech-recognition] ${code}: ${message}`)
    this.emit({ type: 'error', code, message })
  }

  private emit(event: SpeechRecognitionEvent) {
    const target = this.getWindow()
    if (!target || target.isDestroyed()) return
    target.webContents.send(SPEECH_RECOGNITION_EVENT_CHANNEL, event)
  }

  private cleanupSocketPath(socketPath: string) {
    void fs.rm(socketPath, { force: true }).catch(() => {
      /* The socket file may already be gone. */
    })
  }
}

async function resolveHelperAppPath(): Promise<string> {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, HELPER_PACKAGED_APP_PATH)]
    : [
        path.join(process.env.APP_ROOT ?? app.getAppPath(), HELPER_DEV_APP_PATH),
        path.join(app.getAppPath(), HELPER_DEV_APP_PATH),
      ]

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* Try the next candidate. */
    }
  }

  throw new Error('Apple Speech helper app is missing. Run `npm run build:speech-cli` and try again.')
}

async function launchHelperApp(helperAppPath: string): Promise<HelperSession> {
  const socketPath = path.join('/private/tmp', `agentos-speech-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
  await fs.rm(socketPath, { force: true }).catch(() => {
    /* Ignore stale socket cleanup failures before listen. */
  })

  const server = net.createServer()
  server.maxConnections = 1

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })

  let connected = false
  let openExitedBeforeConnect = false
  const openProcess = spawn('/usr/bin/open', ['-n', '-W', helperAppPath, '--args', '--socket', socketPath], {
    cwd: path.dirname(helperAppPath),
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const socket = await new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Apple Speech helper to connect.'))
    }, 10_000)

    const cleanup = () => {
      clearTimeout(timeout)
      server.off('connection', onConnection)
      server.off('error', onServerError)
      openProcess.off('error', onProcessError)
      openProcess.off('exit', onProcessExit)
    }

    const onConnection = (client: Socket) => {
      connected = true
      cleanup()
      resolve(client)
    }
    const onServerError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onProcessError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onProcessExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (connected) return
      openExitedBeforeConnect = true
      cleanup()
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      reject(new Error(`Apple Speech helper launcher exited before connecting with ${reason}.`))
    }

    server.once('connection', onConnection)
    server.once('error', onServerError)
    openProcess.once('error', onProcessError)
    openProcess.once('exit', onProcessExit)
  }).catch((error) => {
    server.close()
    if (!openExitedBeforeConnect) openProcess.kill()
    void fs.rm(socketPath, { force: true })
    throw error
  })

  return {
    process: openProcess,
    server,
    socket,
    socketPath,
    closed: false,
  }
}

function normalizeStatus(value: unknown): SpeechRecognitionStatus | null {
  return typeof value === 'string' && SPEECH_STATUSES.has(value as SpeechRecognitionStatus)
    ? (value as SpeechRecognitionStatus)
    : null
}
