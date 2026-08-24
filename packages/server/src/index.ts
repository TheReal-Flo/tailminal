import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { parseTTL, type Config } from '@tailminal/shared'
import { loadConfig, loadOrCreateToken } from './config.js'
import { registerAuth } from './auth.js'
import { registerRoutes } from './routes.js'
import { SessionManager } from './sessions.js'

export interface ServerHandle {
  config: Config
  token?: string
  port: number
  close(): Promise<void>
}

function staticDir(): string {
  if (process.env.TAILMINAL_STATIC) return process.env.TAILMINAL_STATIC
  const here = path.dirname(fileURLToPath(import.meta.url))
  // dist/index.js -> package/static
  return path.resolve(here, '..', 'static')
}

export async function startServer(options?: {
  config?: Config
  logLevel?: 'error' | 'warn' | 'info' | 'silent'
}): Promise<ServerHandle> {
  const config = options?.config ?? loadConfig()
  const token = config.auth === 'token' ? loadOrCreateToken() : undefined

  const ttlMs = parseTTL(config.sessionTTL)
  const sessions = new SessionManager(ttlMs, config.shell)

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    ...(options?.logLevel ? {} : {}),
  })

  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } })
  registerAuth(app, token ? { mode: 'token', token } : { mode: 'tailnet' })

  try {
    await app.register(fastifyStatic, { root: staticDir() })
  } catch (err) {
    console.warn(`[tailminal] web UI not available: ${(err as Error).message}`)
  }

  registerRoutes(app, { config, sessions })

  await app.listen({ port: config.port, host: '0.0.0.0' })

  return {
    config,
    token,
    port: config.port,
    close: async () => {
      sessions.dispose()
      await app.close()
    },
  }
}

export function printStartupBanner(handle: ServerHandle): void {
  const hostname = os.hostname()
  console.log(`[tailminal] server listening`)
  console.log(`  host : ${hostname}`)
  console.log(`  url  : http://localhost:${handle.port}`)
  console.log(`  auth : ${handle.config.auth === 'tailnet' ? 'tailnet (no token required)' : 'bearer token'}`)
  console.log(`  peers: ${handle.config.peers.map((p) => p.name).join(', ') || '(none configured)'}`)
}
