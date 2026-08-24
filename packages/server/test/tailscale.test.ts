import { describe, expect, it } from 'vitest'
import { parseTailscalePeers } from '../src/tailscale.js'

describe('parseTailscalePeers', () => {
  it('returns online peers with stable MagicDNS addresses', () => {
    expect(
      parseTailscalePeers({
        Peer: {
          a: {
            HostName: 'Laptop',
            DNSName: 'laptop.example.ts.net.',
            TailscaleIPs: ['100.80.1.2'],
            Online: true,
          },
          b: {
            HostName: 'Offline',
            DNSName: 'offline.example.ts.net.',
            TailscaleIPs: ['100.80.1.3'],
            Online: false,
          },
          c: {
            HostName: 'localhost',
            DNSName: 'phone.example.ts.net.',
            TailscaleIPs: ['100.80.1.4'],
            Online: true,
          },
        },
      }),
    ).toEqual([
      { name: 'Laptop', address: 'laptop.example.ts.net' },
      { name: 'phone', address: 'phone.example.ts.net' },
    ])
  })

  it('falls back to a Tailscale IP and tolerates unavailable status', () => {
    expect(
      parseTailscalePeers({ Peer: { a: { TailscaleIPs: ['100.90.1.2'], Online: true } } }),
    ).toEqual([{ name: '100.90.1.2', address: '100.90.1.2' }])
    expect(parseTailscalePeers({})).toEqual([])
  })
})
