import type { FastifyInstance } from 'fastify'
import {
  ExecChunkFrameSchema,
  ExecRequestSchema,
  TAILMINAL_VERSION,
  WsClientFrameSchema,
  type HostInfo,
  type Peer,
} from '@tailminal/shared'
import os from 'node:os'
import type { SessionManager } from './sessions.js'
import { runExec } from './exec.js'
import type { Config } from '@tailminal/shared'
import { discoverTailscalePeers, isTailminalPeer } from './tailscale.js'

export interface RouteContext {
  config: Config
  sessions: SessionManager
}

function hostSelfInfo(): HostInfo {
  return {
    version: TAILMINAL_VERSION,
    hostname: os.hostname(),
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    arch: os.arch(),
    uptimeSec: Math.round(os.uptime()),
  }
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/health', async () => ({
    ok: true,
    version: TAILMINAL_VERSION,
    auth: ctx.config.auth,
  }))

  app.get('/api/hosts', async () => {
    const configured = await Promise.all(
      ctx.config.peers.map(async (peer) => {
        const available = await isTailminalPeer(peer.address, ctx.config.port)
        return { ...peer, online: available, available }
      }),
    )
    const discovered = ctx.config.discoverPeers ? await discoverTailscalePeers(ctx.config.port) : []
    const peers: Peer[] = [...configured]
    for (const peer of discovered) {
      if (!peers.some((existing) => existing.name === peer.name || existing.address === peer.address)) {
        peers.push(peer)
      }
    }
    return { self: hostSelfInfo(), peers }
  })

  app.post('/api/exec', async (request, reply) => {
    const parsed = ExecRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid exec request', details: parsed.error.flatten() })
      return
    }
    const req = parsed.data
    // Stream NDJSON chunks, then the end frame
    void reply.header('content-type', 'application/x-ndjson')
    void reply.header('cache-control', 'no-store')
    const writeLine = (obj: unknown): void => {
      reply.raw.write(`${JSON.stringify(obj)}\n`)
    }
    let headersFlushed = false
    const flushHeaders = (): void => {
      if (!headersFlushed) {
        reply.raw.statusCode = 200
        reply.raw.flushHeaders?.()
        headersFlushed = true
      }
    }

    const outcome = await runExec(req, {
      onStdout: (data) => {
        flushHeaders()
        writeLine(ExecChunkFrameSchema.parse({ stream: 'stdout', data }))
      },
      onStderr: (data) => {
        flushHeaders()
        writeLine(ExecChunkFrameSchema.parse({ stream: 'stderr', data }))
      },
    })
    flushHeaders()
    writeLine({ exitCode: outcome.exitCode, durationMs: outcome.durationMs })
    void reply.hijack()
    reply.raw.end()
  })

  app.get('/api/sessions', async () => ({
    sessions: ctx.sessions.list(),
  }))

  // Bidirectional PTY session over WebSocket.
  app.get('/api/session', { websocket: true }, (socket, request) => {
    let detach: (() => void) | null = null
    let session = null as ReturnType<SessionManager['create']> | null
    const send = (frame: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
    }

    socket.on('message', (raw: Buffer) => {
      let json: unknown
      try {
        json = JSON.parse(raw.toString())
      } catch {
        return
      }
      const frame = WsClientFrameSchema.safeParse(json)
      if (!frame.success) {
        send({ type: 'error', message: 'malformed frame' })
        return
      }
      switch (frame.data.type) {
        case 'attach': {
          if (detach) {
            send({ type: 'error', message: 'already attached' })
            return
          }
          if (frame.data.sessionId) {
            session = ctx.sessions.get(frame.data.sessionId) ?? null
            if (!session || session.exited) {
              send({
                type: 'error',
                message: frame.data.sessionId
                  ? `session ${frame.data.sessionId} not found`
                  : 'session not found',
              })
              return
            }
          } else {
            session = ctx.sessions.create(frame.data.cols, frame.data.rows)
          }
          send({ type: 'attached', sessionId: session.id, scrollback: session.scrollbackText() })
          detach = session.attach((data) => send({ type: 'output', data }))
          session.waitForExit().then((exitCode) => {
            send({ type: 'exited', exitCode })
            try {
              socket.close()
            } catch {
              /* already closed */
            }
          })
          break
        }
        case 'input':
          session?.write(frame.data.data)
          break
        case 'resize':
          session?.resize(frame.data.cols, frame.data.rows)
          break
        case 'detach':
          detach?.()
          detach = null
          break
        case 'kill':
          session?.kill()
          break
      }
    })

    socket.on('close', () => {
      detach?.()
      detach = null
    })
  })
}
