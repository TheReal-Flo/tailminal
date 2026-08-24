import { execFile } from 'node:child_process'
import type { Peer } from '@tailminal/shared'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseTailscalePeers(value: unknown): Peer[] {
  if (!isObject(value) || !isObject(value.Peer)) return []
  const peers: Peer[] = []
  const seen = new Set<string>()
  for (const candidate of Object.values(value.Peer)) {
    if (!isObject(candidate) || candidate.Online !== true) continue
    const dnsName = typeof candidate.DNSName === 'string' ? candidate.DNSName.replace(/\.$/, '') : ''
    const ips = Array.isArray(candidate.TailscaleIPs)
      ? candidate.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
      : []
    const address = dnsName || ips.find((ip) => ip.includes('.')) || ips[0]
    if (!address || seen.has(address)) continue
    const hostName = typeof candidate.HostName === 'string' ? candidate.HostName.trim() : ''
    const dnsLabel = dnsName.split('.')[0] || ''
    const name = hostName && hostName.toLowerCase() !== 'localhost' ? hostName : dnsLabel || address
    peers.push({ name, address })
    seen.add(address)
  }
  return peers
}

function tailscaleStatus(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: 5000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}

function urlHost(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
}

export async function isTailminalPeer(address: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${urlHost(address)}:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: unknown }
    return body.ok === true
  } catch {
    return false
  }
}

export async function discoverTailscalePeers(port: number): Promise<Peer[]> {
  try {
    const peers = parseTailscalePeers(await tailscaleStatus())
    const statuses = await Promise.all(peers.map((peer) => isTailminalPeer(peer.address, port)))
    return peers.map((peer, index) => ({ ...peer, online: true, available: statuses[index] }))
  } catch {
    return []
  }
}
