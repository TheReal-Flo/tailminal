import { z } from 'zod'

export const TAILMINAL_VERSION = '0.2.0'
export const DEFAULT_PORT = 7601

// ---------- Config ----------

export const PeerSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
})
export type Peer = z.infer<typeof PeerSchema>

export const ConfigSchema = z.object({
  port: z.number().int().positive().default(DEFAULT_PORT),
  /** Tailnet clients are trusted by source address by default; token mode is available as an opt-in. */
  auth: z.enum(['tailnet', 'token']).default('tailnet'),
  /** 'persistent' (default) keeps sessions until process exit; otherwise e.g. '30m', '24h' */
  sessionTTL: z.string().default('persistent'),
  /** Override the PTY login shell executable on this node */
  shell: z.string().optional(),
  peers: z.array(PeerSchema).default([]),
})
export type Config = z.infer<typeof ConfigSchema>

/** Parses a TTL string like 'persistent', '30m', '12h', '7d'. Returns null for persistent. */
export function parseTTL(ttl: string): number | null {
  if (ttl === 'persistent') return null
  const m = /^(\d+)([smhd])$/.exec(ttl)
  if (!m) throw new Error(`Invalid sessionTTL "${ttl}". Use 'persistent' or '<n><s|m|h|d>'.`)
  const n = Number(m[1])
  switch (m[2]) {
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    default:
      return n * 86_400_000
  }
}

// ---------- Host info ----------

export const HostInfoSchema = z.object({
  version: z.string(),
  hostname: z.string(),
  platform: z.string(),
  osType: z.string(),
  osRelease: z.string(),
  arch: z.string(),
  uptimeSec: z.number(),
})
export type HostInfo = z.infer<typeof HostInfoSchema>

export const HostsResponseSchema = z.object({
  self: HostInfoSchema,
  peers: z.array(PeerSchema),
})

// ---------- One-shot exec ----------

export const ShellPrefSchema = z.enum(['auto', 'powershell', 'cmd', 'sh'])
export type ShellPref = z.infer<typeof ShellPrefSchema>

export const ExecRequestSchema = z.object({
  cmd: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  shell: ShellPrefSchema.default('auto'),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
})
export type ExecRequest = z.infer<typeof ExecRequestSchema>

export const ExecChunkFrameSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
})
export type ExecChunkFrame = z.infer<typeof ExecChunkFrameSchema>

export const ExecEndFrameSchema = z.object({
  exitCode: z.number().nullable(),
  durationMs: z.number(),
})
export type ExecEndFrame = z.infer<typeof ExecEndFrameSchema>

// ---------- PTY sessions ----------

export const SessionInfoSchema = z.object({
  id: z.string(),
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  attached: z.boolean(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

// WebSocket protocol frames (client -> server)
export const WsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    sessionId: z.string().optional(),
    cols: z.number().int().positive().default(80),
    rows: z.number().int().positive().default(24),
  }),
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ type: z.literal('detach') }),
  z.object({ type: z.literal('kill') }),
])
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>

// WebSocket protocol frames (server -> client)
export const WsServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attached'), sessionId: z.string(), scrollback: z.string() }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exited'), exitCode: z.number().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>
