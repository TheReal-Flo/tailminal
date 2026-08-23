import fs from 'node:fs'
import os from 'node:os'
import type { ShellPref } from '@tailminal/shared'

export interface ShellCommand {
  file: string
  args: string[]
}

/**
 * Builds a shell invocation for one-shot command execution.
 * Windows: PowerShell by default, CMD via pref 'cmd'.
 * macOS/Linux: /bin/sh via pref 'auto'/'sh'.
 */
export function buildExecCmd(pref: ShellPref, cmd: string): ShellCommand {
  switch (os.platform()) {
    case 'win32':
      switch (pref) {
        case 'cmd':
          return { file: 'cmd.exe', args: ['/d', '/s', '/c', cmd] }
        case 'powershell':
        case 'auto':
          return {
            file: 'powershell.exe',
            args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd],
          }
        case 'sh':
          throw new Error("shell 'sh' is not available on Windows")
      }
      break
    case 'darwin':
    case 'linux':
    default:
      switch (pref) {
        case 'powershell':
        case 'cmd':
          throw new Error(`shell '${pref}' is not available on ${os.platform()}`)
        case 'sh':
        case 'auto':
          return { file: '/bin/sh', args: ['-c', cmd] }
      }
  }
}

/** Picks an interactive login shell for PTY sessions. */
export function pickPtyShell(override?: string): ShellCommand {
  if (override) return { file: override, args: [] }
  switch (os.platform()) {
    case 'win32':
      return { file: 'powershell.exe', args: ['-NoLogo'] }
    case 'darwin':
      return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
    default: {
      const candidates = [process.env.SHELL, '/bin/bash', '/bin/sh']
      for (const candidate of candidates) {
        if (candidate && isExecutable(candidate)) {
          return { file: candidate, args: [] }
        }
      }
      return { file: '/bin/sh', args: [] }
    }
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
