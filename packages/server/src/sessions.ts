import { randomBytes } from 'node:crypto'
import * as pty from 'node-pty'
import type { SessionInfo } from '@tailminal/shared'
import { pickPtyShell, type ShellCommand } from './shell.js'

const SCROLLBACK_MAX_CHARS = 131_072

export class PtySession {
  readonly id: string
  readonly shell: ShellCommand
  readonly createdAt = new Date()
  lastActivityAt = new Date()
  exited = false
  exitCode: number | null = null
  cols: number
  rows: number

  private readonly term: pty.IPty
  private readonly listeners = new Set<(data: string) => void>()
  private scrollback = ''
  private exitWaiters: Array<(code: number | null) => void> = []

  constructor(cols: number, rows: number, override?: string) {
    this.id = randomBytes(8).toString('hex')
    this.cols = cols
    this.rows = rows
    this.shell = pickPtyShell(override)
    this.term = pty.spawn(this.shell.file, this.shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME ?? process.env.USERPROFILE ?? '.',
      env: process.env as Record<string, string>,
    })
    this.term.onData((data) => {
      this.touch()
      this.scrollback += data
      if (this.scrollback.length > SCROLLBACK_MAX_CHARS) {
        this.scrollback = this.scrollback.slice(this.scrollback.length - SCROLLBACK_MAX_CHARS)
      }
      for (const listener of this.listeners) listener(data)
    })
    this.term.onExit(({ exitCode }) => {
      this.exited = true
      this.exitCode = exitCode
      for (const listener of [...this.listeners]) listener('')
      this.listeners.clear()
      const waiters = this.exitWaiters.splice(0)
      for (const waiter of waiters) waiter(exitCode)
    })
  }

  private touch(): void {
    this.lastActivityAt = new Date()
  }

  get attached(): boolean {
    return this.listeners.size > 0
  }

  write(data: string): void {
    if (this.exited) return
    this.touch()
    this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited || (cols === this.cols && rows === this.rows)) return
    this.cols = cols
    this.rows = rows
    try {
      this.term.resize(cols, rows)
    } catch {
      /* some shells reject transient sizes */
    }
  }

  kill(): void {
    if (this.exited) return
    try {
      this.term.kill()
    } catch {
      /* already gone */
    }
  }

  /** Subscribes to output; returns a detach function. */
  attach(listener: (data: string) => void): () => void {
    if (this.exited) throw new Error('session already exited')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  waitForExit(): Promise<number | null> {
    if (this.exited) return Promise.resolve(this.exitCode)
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve)
    })
  }

  scrollbackText(): string {
    return this.scrollback
  }

  info(): SessionInfo {
    return {
      id: this.id,
      shell: `${this.shell.file} ${this.shell.args.join(' ')}`.trim(),
      cols: this.cols,
      rows: this.rows,
      attached: this.attached,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
    }
  }
}

export class SessionManager {
  readonly sessions = new Map<string, PtySession>()
  private reaper: NodeJS.Timeout | null = null

  constructor(
    public ttlMs: number | null,
    private readonly shellOverride?: string,
  ) {
    if (ttlMs != null) {
      this.reaper = setInterval(() => this.reap(), 30_000)
      this.reaper.unref()
    }
  }

  create(cols = 80, rows = 24): PtySession {
    const session = new PtySession(cols, rows, this.shellOverride)
    session.waitForExit().then(() => {
      // keep dead sessions listed briefly so clients can observe the exit
      setTimeout(() => {
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
      }, 5_000)
    })
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info())
  }

  /** Kills detached sessions older than TTL. */
  reap(): void {
    if (this.ttlMs == null) return
    const now = Date.now()
    for (const session of this.sessions.values()) {
      const idleFor = now - session.lastActivityAt.getTime()
      if (!session.attached && !session.exited && idleFor > this.ttlMs) {
        session.kill()
      }
    }
  }

  dispose(): void {
    if (this.reaper) clearInterval(this.reaper)
    for (const session of this.sessions.values()) session.kill()
  }
}
