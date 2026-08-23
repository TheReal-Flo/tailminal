import { describe, expect, it } from 'vitest'
import { ConfigSchema, ExecRequestSchema, parseTTL, WsClientFrameSchema } from '../src/index.js'

describe('parseTTL', () => {
  it('returns null for persistent', () => {
    expect(parseTTL('persistent')).toBeNull()
  })
  it('parses durations', () => {
    expect(parseTTL('30s')).toBe(30_000)
    expect(parseTTL('10m')).toBe(600_000)
    expect(parseTTL('24h')).toBe(86_400_000)
    expect(parseTTL('7d')).toBe(7 * 86_400_000)
  })
  it('rejects garbage', () => {
    expect(() => parseTTL('forever')).toThrow()
    expect(() => parseTTL('10x')).toThrow()
  })
})

describe('ConfigSchema', () => {
  it('applies defaults', () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.port).toBe(7601)
    expect(cfg.sessionTTL).toBe('persistent')
    expect(cfg.peers).toEqual([])
  })
})

describe('ExecRequestSchema', () => {
  it('defaults shell to auto', () => {
    const req = ExecRequestSchema.parse({ cmd: 'ls' })
    expect(req.shell).toBe('auto')
  })
})

describe('WsClientFrameSchema', () => {
  it('defaults terminal size on attach', () => {
    const f = WsClientFrameSchema.parse({ type: 'attach' })
    expect(f).toMatchObject({ cols: 80, rows: 24 })
  })
})
