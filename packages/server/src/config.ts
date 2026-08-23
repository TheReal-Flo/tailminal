import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { ConfigSchema, type Config } from '@tailminal/shared'

export function configDir(): string {
  return process.env.TAILMINAL_HOME ?? path.join(os.homedir(), '.tailminal')
}

function ensureConfigDir(): string {
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Loads the node token, generating one on first run. */
export function loadOrCreateToken(): string {
  const dir = ensureConfigDir()
  const file = path.join(dir, 'token')
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  }
  const token = randomBytes(24).toString('hex')
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* windows may not fully support; best effort */
  }
  return token
}

/** Loads ~/.tailminal/config.json (creating defaults when missing). */
export function loadConfig(): Config {
  const dir = ensureConfigDir()
  const file = path.join(dir, 'config.json')
  let raw: unknown = {}
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`)
    }
  }
  const config = ConfigSchema.parse(raw)
  if (!fs.existsSync(file)) {
    writeExampleConfig(file, config)
  }
  return config
}

function writeExampleConfig(file: string, config: Config): void {
  const example = `{
  "port": ${config.port},
  "sessionTTL": "${config.sessionTTL}",
  "peers": [
    { "name": "laptop", "address": "laptop.tailnet-name.ts.net" }
  ]
}
`
  fs.writeFileSync(file, example)
}
