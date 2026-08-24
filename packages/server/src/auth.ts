import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

export type AccessPolicy =
  | { mode: 'tailnet' }
  | { mode: 'token'; token: string }

function ipv6Hextets(address: string): number[] | null {
  const withoutZone = address.split('%')[0] ?? address
  const halves = withoutZone.toLowerCase().split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const parts = [...left, ...Array(missing).fill('0'), ...right]
  const values = parts.map((part) => Number.parseInt(part, 16))
  return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? values
    : null
}

export function isTailnetOrLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const address = remoteAddress.replace(/^\[|\]$/g, '')
  if (address === '::1') return true

  const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address)
  const ipv4 = mapped?.slice(1).map(Number) ?? address.split('.').map(Number)
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ipv4[0] === 127 || (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127)
  }

  const hextets = ipv6Hextets(address)
  return hextets?.[0] === 0xfd7a && hextets[1] === 0x115c && hextets[2] === 0xa1e0
}

function tokenMatches(expectedToken: string, providedToken: string | undefined): boolean {
  if (!providedToken) return false
  const expected = Buffer.from(expectedToken, 'utf8')
  const provided = Buffer.from(providedToken, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export function registerAuth(app: FastifyInstance, policy: AccessPolicy): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url
    if (!url.startsWith('/api') || url === '/api/health') return

    if (policy.mode === 'tailnet') {
      const trustedSource = isTailnetOrLoopbackAddress(request.ip)
      const trustedInterface = isTailnetOrLoopbackAddress(request.socket.localAddress)
      if (!trustedSource || !trustedInterface) {
        await reply.code(403).send({ error: 'access is limited to loopback and Tailscale connections' })
      }
      return
    }

    const header = request.headers.authorization
    let provided = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (url === '/api/session' && request.headers.upgrade?.toLowerCase() === 'websocket') {
      provided = new URL(request.url, 'http://localhost').searchParams.get('token') ?? undefined
    }
    if (!tokenMatches(policy.token, provided)) {
      await reply.code(401).send({ error: provided ? 'invalid token' : 'missing bearer token' })
    }
  })
}
