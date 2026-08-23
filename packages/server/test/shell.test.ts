import { describe, expect, it } from 'vitest'
import { buildExecCmd, pickPtyShell } from '../src/shell.js'
import os from 'node:os'

describe('buildExecCmd', () => {
  it('uses powershell on windows by default', () => {
    if (os.platform() !== 'win32') return
    const cmd = buildExecCmd('auto', 'Get-Process')
    expect(cmd.file).toBe('powershell.exe')
    expect(cmd.args.at(-1)).toBe('Get-Process')
  })

  it('uses cmd.exe when requested on windows', () => {
    if (os.platform() !== 'win32') return
    const cmd = buildExecCmd('cmd', 'dir')
    expect(cmd.file).toBe('cmd.exe')
  })

  it('uses /bin/sh elsewhere', () => {
    if (os.platform() === 'win32') return
    const cmd = buildExecCmd('auto', 'ls -la')
    expect(cmd.file).toBe('/bin/sh')
    expect(cmd.args).toEqual(['-c', 'ls -la'])
  })

  it('rejects cross-platform shell prefs', () => {
    if (os.platform() === 'win32') {
      expect(() => buildExecCmd('sh', 'x')).toThrow()
    } else {
      expect(() => buildExecCmd('cmd', 'x')).toThrow()
      expect(() => buildExecCmd('powershell', 'x')).toThrow()
    }
  })
})

describe('pickPtyShell', () => {
  it('honors override', () => {
    expect(pickPtyShell('/usr/bin/fish').file).toBe('/usr/bin/fish')
  })
})
