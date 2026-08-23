import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

/** Bearer-token auth for /api routes (health endpoint stays open). */
export function registerAuth(app: FastifyInstance, token: string): void {
  const expected = Buffer.from(token, 'utf8')
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url
    if (!url.startsWith('/api') || url === '/api/health') return
    if (url === '/api/session' && request.headers.upgrade?.toLowerCase() === 'websocket') {
      // WebSocket auth happens via token query param in the handshake handler
      return
    }
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      await reply.code(401).send({ error: 'missing bearer token' })
      return
    }
    const provided = Buffer.from(header.slice(7), 'utf8')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      await reply.code(401).send({ error: 'invalid token' })
    }
  })
}
