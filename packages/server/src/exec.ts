import { spawn } from 'node:child_process'
import type { ExecRequest } from '@tailminal/shared'
import { buildExecCmd } from './shell.js'

export interface ExecOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface ExecStreamCallbacks {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      /* fall through */
    }
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Runs a one-shot command, streaming output chunks while capturing the full result. */
export function runExec(req: ExecRequest, cb: ExecStreamCallbacks = {}): Promise<ExecOutcome> {
  const { file, args } = buildExecCmd(req.shell, req.cmd)
  const started = Date.now()

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: req.cwd,
        env: req.env ? { ...process.env, ...req.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = req.timeoutMs
      ? setTimeout(() => {
          if (child.pid != null) killTree(child.pid)
        }, req.timeoutMs)
      : null

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started })
    }

    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => {
      stdout += d
      cb.onStdout?.(d)
    })
    child.stderr!.on('data', (d: string) => {
      stderr += d
      cb.onStderr?.(d)
    })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
