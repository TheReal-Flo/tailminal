#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { DEFAULT_PORT, ConfigSchema } from '@tailminal/shared'
import { normalizeBaseUrl, TailminalClient } from '@tailminal/client'

const HELP = `Tailminal — terminals across your tailnet

Usage:
  tailminal serve                          Start the node server (port ${DEFAULT_PORT})
  tailminal hosts                          List configured peers and their status
  tailminal exec <host> [opts] -- <cmd...> Run a command on <host>
      --cwd <dir>                          Working directory on the remote host
      --shell <auto|powershell|cmd|sh>     Shell preference (Windows: powershell/cmd)
      --timeout-ms <n>                     Kill the command after n milliseconds
  tailminal attach <host> [session-id]     Attach to an interactive PTY session
                                           (Ctrl+] detaches, keeps session alive)
  tailminal sessions <host>                List sessions on <host>
  tailminal token                          Print the token (only when auth is "token")

Environment:
  TAILMINAL_TOKEN    Token for nodes explicitly configured with auth: "token"
  TAILMINAL_HOME     Override config directory (default ~/.tailminal)
`

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(2)
}

function configPath(): string {
  const dir = process.env.TAILMINAL_HOME ?? path.join(os.homedir(), '.tailminal')
  return path.join(dir, 'config.json')
}

function loadLocalConfig(): {
  port: number
  auth: 'tailnet' | 'token'
  peers: Array<{ name: string; address: string; online?: boolean; available?: boolean }>
} {
  const file = configPath()
  let raw = {}
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // fall through with defaults
    }
  }
  const cfg = ConfigSchema.parse(raw)
  return { port: cfg.port, auth: cfg.auth, peers: cfg.peers }
}

function resolveToken(required = false): string | undefined {
  if (process.env.TAILMINAL_TOKEN) return process.env.TAILMINAL_TOKEN
  if (!required && loadLocalConfig().auth !== 'token') return undefined
  const dir = process.env.TAILMINAL_HOME ?? path.join(os.homedir(), '.tailminal')
  const file = path.join(dir, 'token')
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  if (required) fail(`no token found at ${file}. Set auth to "token" and run 'tailminal serve' first.`)
  return undefined
}

function clientFor(host: string): TailminalClient {
  const url = normalizeBaseUrl(host, DEFAULT_PORT)
  return new TailminalClient(url, resolveToken())
}

async function cmdHosts(): Promise<void> {
  const { port, peers: configuredPeers } = loadLocalConfig()
  let peers = configuredPeers
  try {
    const local = new TailminalClient(normalizeBaseUrl('127.0.0.1', port), resolveToken())
    peers = (await local.hosts(7000)).peers
  } catch {}
  const targets: Array<{ name: string; base: string; tailnetOnline?: boolean }> = [
    ...peers.map((p) => ({
      name: p.name,
      base: normalizeBaseUrl(p.address, port),
      tailnetOnline: p.online,
    })),
  ]
  const rows: string[] = []
  rows.push('NAME'.padEnd(20), 'URL'.padEnd(45), 'STATUS')
  for (const target of targets) {
    const client = new TailminalClient(target.base, resolveToken())
    const alive = await client.health(1500)
    let detail = alive ? 'online' : target.tailnetOnline ? 'tailnet-online (tailminal unavailable)' : 'offline'
    if (alive) {
      try {
        const info = await client.hosts()
        detail += ` (${info.self.platform}/${info.self.arch})`
      } catch {
        detail = 'access-denied'
      }
    }
    rows.push(target.name.padEnd(20), target.base.padEnd(45), detail)
  }
  console.log(rows.join('\n'))
}

interface ExecOpts {
  cwd?: string
  shell?: 'auto' | 'powershell' | 'cmd' | 'sh'
  timeoutMs?: number
}

async function cmdExec(host: string, opts: ExecOpts, cmdParts: string[]): Promise<never | void> {
  if (cmdParts.length === 0) fail('no command given after --')
  const client = clientFor(host)
  const end = await client.exec(
    {
      cmd: cmdParts.join(' '),
      cwd: opts.cwd,
      shell: opts.shell ?? 'auto',
      timeoutMs: opts.timeoutMs,
    },
    {
      onChunk(stream, data) {
        const target = stream === 'stdout' ? process.stdout : process.stderr
        target.write(data)
      },
    },
  )
  process.exit(end.exitCode ?? 1)
}

async function cmdSessions(host: string): Promise<void> {
  const client = clientFor(host)
  const sessions = await client.listSessions()
  if (sessions.length === 0) {
    console.log('(no sessions)')
    return
  }
  for (const s of sessions) {
    const state = s.attached ? 'attached' : 'detached'
    console.log(
      `${s.id}  ${state.padEnd(9)} ${String(s.cols).padStart(4)}x${String(s.rows).padEnd(4)} created=${s.createdAt} shell=${s.shell}`,
    )
  }
}

async function cmdAttach(host: string, sessionId?: string): Promise<void> {
  const client = clientFor(host)
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  const sock = client.openSession({ sessionId, cols, rows })

  sock.on('attached', (_id, scrollback) => {
    if (scrollback) process.stdout.write(scrollback)
  })
  sock.on('output', (data) => process.stdout.write(data))
  sock.on('exited', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })
  sock.on('error', (message) => {
    cleanup()
    console.error(`remote error: ${message}`)
    process.exit(1)
  })
  sock.on('close', () => {
    cleanup()
    process.exit(0)
  })

  await sock.whenOpen()

  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.resume()
  stdin.on('data', (buf: Buffer) => {
    // Ctrl+] detaches locally while keeping the session alive remotely
    if (buf.length === 1 && buf[0] === 0x1d) {
      sock.detach()
      sock.close()
      cleanup()
      console.log('\n[tailminal] detached (session kept alive)')
      process.exit(0)
    }
    sock.write(buf.toString())
  })

  const onResize = (): void => {
    sock.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  }
  process.stdout.on('resize', onResize)

  function cleanup(): void {
    if (stdin.isTTY) stdin.setRawMode(false)
    process.stdout.removeListener('resize', onResize)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      console.log(HELP)
      return
    }
    case 'serve': {
      const { startServer, printStartupBanner } = await import('@tailminal/server')
      const handle = await startServer()
      printStartupBanner(handle)
      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return
    }
    case 'hosts': {
      await cmdHosts()
      return
    }
    case 'token': {
      console.log(resolveToken(true))
      return
    }
    case 'sessions': {
      const host = rest[0]
      if (!host) fail('usage: tailminal sessions <host>')
      await cmdSessions(host)
      return
    }
    case 'attach': {
      const host = rest[0]
      if (!host) fail('usage: tailminal attach <host> [session-id]')
      await cmdAttach(host, rest[1])
      return
    }
    case 'exec': {
      const dd = rest.indexOf('--')
      if (dd === -1) fail("usage: tailminal exec <host> [opts] -- <cmd...>")
      const host = rest[0]
      if (!host) fail('missing <host>')
      const flagArgs = rest.slice(1, dd)
      const opts: ExecOpts = {}
      for (let i = 0; i < flagArgs.length; i++) {
        const flag = flagArgs[i]
        switch (flag) {
          case '--cwd':
            opts.cwd = flagArgs[++i]
            break
          case '--shell':
            opts.shell = flagArgs[++i] as ExecOpts['shell']
            break
          case '--timeout-ms':
            opts.timeoutMs = Number(flagArgs[++i])
            break
          default:
            fail(`unknown flag '${flag}'`)
        }
      }
      await cmdExec(host, opts, rest.slice(dd + 1))
      return
    }
    default:
      fail(`unknown command '${command}'. Try 'tailminal help'.`)
  }
}

void main().catch((err: unknown) => {
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
})
