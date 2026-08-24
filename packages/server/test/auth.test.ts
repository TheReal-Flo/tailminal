import { describe, expect, it } from 'vitest'
import { isTailnetOrLoopbackAddress } from '../src/auth.js'

describe('isTailnetOrLoopbackAddress', () => {
  it.each([
    '127.0.0.1',
    '127.12.34.56',
    '::1',
    '100.64.0.1',
    '100.127.255.254',
    '::ffff:100.90.1.2',
    'fd7a:115c:a1e0::1',
    'fd7a:115c:a1e0:abcd::1234',
  ])('allows %s', (address) => {
    expect(isTailnetOrLoopbackAddress(address)).toBe(true)
  })

  it.each([
    undefined,
    '192.168.1.20',
    '10.0.0.2',
    '100.63.255.255',
    '100.128.0.1',
    '::ffff:192.168.1.20',
    'fd7a:115c:a1df::1',
    '2001:db8::1',
  ])('rejects %s', (address) => {
    expect(isTailnetOrLoopbackAddress(address)).toBe(false)
  })
})
