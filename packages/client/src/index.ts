import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  DEFAULT_PORT,
  ExecEndFrameSchema,
  ExecChunkFrameSchema,
  ExecRequestSchema,
  HostsResponseSchema,
  SessionInfoSchema,
  WsClientFrameSchema,
  WsServerFrameSchema,
  type Config,
  type ExecEndFrame,
  type ExecRequest,
  type HostInfo,
  type Peer,
  type SessionInfo,
  type WsClientFrame,
} from '@tailminal/shared'

export function normalizeBaseUrl(hostOrUrl: string, port = DEFAULT_PORT): string {
  if (/^https?:\/\//.test(hostOrUrl)) return hostOrUrl.replace(/\/+$/, '')
  return `http://${hostOrUrl}:${port}`
}

interface HttpError extends Error {
  status?: number
  body?: unknown
}

async function readError(res: Response): Promise<HttpError> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
  }
  const err: HttpError = new Error(`HTTP ${res.status} ${res.statusText}`)
  err.status = res.status
  err.body = body
  return err
}

export interface ExecStreamHandlers {
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void
}

export class TailminalClient {
  constructor(
    public baseUrl: string,
    public token: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
  }

  private async fetchJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 10_000)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw await readError(res)
    return (await res.json()) as T
  }

  async health(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return false
      const json = (await res.json()) as { ok?: boolean }
      return json.ok === true
    } catch {
      return false
    }
  }

  async hosts(timeoutMs?: number): Promise<{ self: HostInfo; peers: Peer[] }> {
    return this.fetchJson('/api/hosts', { timeoutMs })
  }

  /** One-shot exec with optional live streaming of output chunks. */
  async exec(req: ExecRequest, handlers?: ExecStreamHandlers): Promise<ExecEndFrame> {
    const parsed = ExecRequestSchema.parse(req)
    const res = await fetch(`${this.baseUrl}/api/exec`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(parsed),
    })
    if (!res.ok || !res.body) throw await readError(res)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let end: ExecEndFrame | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const json = JSON.parse(line)
        const chunk = ExecChunkFrameSchema.safeParse(json)
        if (chunk.success) {
          handlers?.onChunk?.(chunk.data.stream, chunk.data.data)
          continue
        }
        const e = ExecEndFrameSchema.safeParse(json)
        if (e.success) end = e.data
      }
    }
    if (!end) throw new Error('Connection closed before exec result was received')
    return end
  }

  async listSessions(timeoutMs?: number): Promise<SessionInfo[]> {
    const json = await this.fetchJson<{ sessions: unknown[] }>('/api/sessions', { timeoutMs })
    return z.array(SessionInfoSchema).parse(json.sessions)
  }

  openSession(opts: { sessionId?: string; cols?: number; rows?: number }): SessionSocket {
    return new SessionSocket(this.baseUrl, this.token, opts)
  }
}

export interface SessionEvents {
  attached: (sessionId: string, scrollback: string) => void
  output: (data: string) => void
  exited: (exitCode: number | null) => void
  error: (message: string) => void
  close: () => void
}

/** Bidirectional PTY session over WebSocket. */
export class SessionSocket extends EventEmitter {
  private ws!: WebSocket
  sessionId: string | null = null
  private openPromise: Promise<void>

  constructor(
    baseUrl: string,
    token: string,
    opts: { sessionId?: string; cols?: number; rows?: number } = {},
  ) {
    super()
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/session?token=${encodeURIComponent(token)}`
    this.ws = new WebSocket(wsUrl)
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (raw) => {
      let frame: unknown
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      const parsed = WsServerFrameSchema.safeParse(frame)
      if (!parsed.success) return
      switch (parsed.data.type) {
        case 'attached':
          this.sessionId = parsed.data.sessionId
          this.emit('attached', parsed.data.sessionId, parsed.data.scrollback)
          break
        case 'output':
          this.emit('output', parsed.data.data)
          break
        case 'exited':
          this.emit('exited', parsed.data.exitCode)
          break
        case 'error':
          this.emit('error', parsed.data.message)
          break
      }
    })
    this.ws.on('close', () => this.emit('close'))
    // send attach once the socket is open
    this.openPromise.then(() => {
      this.send({
        type: 'attach',
        sessionId: opts.sessionId,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
      })
    })
  }

  async whenOpen(): Promise<void> {
    await this.openPromise
  }

  private send(frame: WsClientFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(WsClientFrameSchema.parse(frame)))
    }
  }

  write(data: string): void {
    this.send({ type: 'input', data })
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  detach(): void {
    this.send({ type: 'detach' })
  }

  kill(): void {
    this.send({ type: 'kill' })
  }

  close(): void {
    this.ws.close()
  }
}

/** Build clients for a node's configured peers plus itself. */
export function peerClients(config: Config, token: string): Map<string, TailminalClient> {
  const map = new Map<string, TailminalClient>()
  map.set('localhost', new TailminalClient(normalizeBaseUrl('127.0.0.1', config.port), token))
  for (const peer of config.peers) {
    map.set(peer.name, new TailminalClient(normalizeBaseUrl(peer.address, DEFAULT_PORT), token))
  }
  return map
}
