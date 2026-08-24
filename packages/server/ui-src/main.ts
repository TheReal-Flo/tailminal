import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface HostsResponse {
  self: { hostname: string; platform: string; arch: string; version: string }
  peers: Array<{ name: string; address: string }>
}

interface HealthResponse {
  ok: boolean
  auth?: 'tailnet' | 'token'
}

const tokenRow = document.getElementById('token-row') as HTMLDivElement
const tokenInput = document.getElementById('token-input') as HTMLInputElement
const hostList = document.getElementById('host-list') as HTMLUListElement
const execForm = document.getElementById('exec-form') as HTMLFormElement
const execInput = document.getElementById('exec-input') as HTMLInputElement
const execOutput = document.getElementById('exec-output') as HTMLPreElement
const activeLabel = document.getElementById('active-host-label') as HTMLSpanElement
const detachBtn = document.getElementById('detach-btn') as HTMLButtonElement
const killBtn = document.getElementById('kill-btn') as HTMLButtonElement
const container = document.getElementById('terminal-container') as HTMLDivElement
let usesTokenAuth = false

tokenInput.value = localStorage.getItem('tailminal-token') ?? ''
tokenInput.addEventListener('change', () => {
  localStorage.setItem('tailminal-token', tokenInput.value)
  void refreshHostList()
})

function token(): string {
  return usesTokenAuth ? tokenInput.value.trim() : ''
}

function authHeaders(): Record<string, string> {
  return token() ? { authorization: `Bearer ${token()}` } : {}
}

async function detectAuthMode(): Promise<void> {
  try {
    const res = await fetch('/api/health')
    const health = (await res.json()) as HealthResponse
    usesTokenAuth = health.auth === 'token'
    tokenRow.hidden = !usesTokenAuth
  } catch {
    usesTokenAuth = false
    tokenRow.hidden = true
  }
}

// ---------- Terminal ----------

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let sock: WebSocket | null = null
let currentSessionId: string | null = null

function destroyTerminal(): void {
  sock?.close()
  sock = null
  term?.dispose()
  term = null
  detachBtn.hidden = true
  killBtn.hidden = true
}

function openTerminal(hostUrl: string, hostName: string, sessionId?: string): void {
  destroyTerminal()
  activeLabel.textContent = `${hostName}${sessionId ? ` (session ${sessionId.slice(0, 8)}…)` : ''}`
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: 14,
    theme: {
      background: '#0f1117',
    },
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  container.innerHTML = ''
  const el = document.createElement('div')
  el.style.height = '100%'
  container.appendChild(el)
  term.open(el)
  fitAddon.fit()

  const tokenQuery = token() ? `?token=${encodeURIComponent(token())}` : ''
  const wsUrl = `${hostUrl.replace(/^http/, 'ws')}/api/session${tokenQuery}`
  sock = new WebSocket(wsUrl)

  const send = (frame: object): void => {
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame))
  }

  sock.onopen = () => {
    send({ type: 'attach', sessionId, cols: term!.cols, rows: term!.rows })
  }
  sock.onmessage = (event) => {
    const frame = JSON.parse(event.data as string)
    switch (frame.type) {
      case 'attached':
        currentSessionId = frame.sessionId
        if (frame.scrollback) term!.write(frame.scrollback)
        detachBtn.hidden = false
        killBtn.hidden = false
        break
      case 'output':
        term!.write(frame.data)
        break
      case 'exited':
        term!.writeln(`\r\n[session exited, code ${frame.exitCode ?? '?'}]`)
        destroyTerminal()
        break
      case 'error':
        term!.writeln(`\r\n[error] ${frame.message}`)
        break
    }
  }

  term.onData((data) => send({ type: 'input', data }))
  window.addEventListener('resize', onResize)
  onResize()

  function onResize(): void {
    if (!fitAddon || !term) return
    fitAddon.fit()
    send({ type: 'resize', cols: term.cols, rows: term.rows })
  }
}

detachBtn.addEventListener('click', () => {
  if (sock) sock.send(JSON.stringify({ type: 'detach' }))
  destroyTerminal()
  activeLabel.textContent = 'no host selected'
})

killBtn.addEventListener('click', () => {
  if (sock) sock.send(JSON.stringify({ type: 'kill' }))
  destroyTerminal()
  activeLabel.textContent = 'no host selected'
})

// ---------- Host list ----------

async function refreshHostList(): Promise<void> {
  hostList.innerHTML = ''
  let data: HostsResponse
  try {
    const res = await fetch('/api/hosts', { headers: authHeaders() })
    if (res.status === 401) {
      usesTokenAuth = true
      tokenRow.hidden = false
      addHint('enter the token configured for this node')
      return
    }
    if (res.status === 403) {
      addHint('open Tailminal over Tailscale or on this device')
      return
    }
    data = await res.json()
  } catch {
    addHint('failed to load hosts')
    return
  }
  const selfItem = addItem(data.self.hostname + ' (this node)', '', true)
  void markStatus(selfItem, location.origin)
  for (const peer of data.peers) {
    const baseUrl = `http://${peer.address}:7601`
    const item = addItem(peer.name, baseUrl, false)
    void markStatus(item, baseUrl)
  }

  function addItem(name: string, baseUrl: string, local: boolean): HTMLLIElement {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = 'dot'
    li.appendChild(dot)
    li.appendChild(document.createTextNode(name))
    li.addEventListener('click', () => {
      for (const el of Array.from(hostList.children)) el.classList.remove('active')
      li.classList.add('active')
      openTerminal(baseUrl || location.origin, name)
    })
    hostList.appendChild(li)
    return li
  }

  async function markStatus(li: HTMLLIElement, baseUrl: string): Promise<void> {
    const dot = li.querySelector('.dot') as HTMLElement
    const healthUrl = `${baseUrl}/api/health`
    const ok = await fetch(healthUrl).then((r) => r.ok).catch(() => false)
    dot.classList.add(ok ? 'online' : 'offline')
  }

  function addHint(text: string): void {
    const li = document.createElement('li')
    li.style.cursor = 'default'
    li.style.color = 'var(--muted)'
    li.textContent = text
    hostList.appendChild(li)
  }
}

// ---------- One-shot exec ----------

execForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const cmd = execInput.value.trim()
  if (!cmd) return
  execOutput.hidden = false
  execOutput.textContent += `$ ${cmd}\n`
  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ cmd, shell: 'auto' }),
    })
    if (!res.ok || !res.body) {
      execOutput.textContent += `[HTTP ${res.status}]\n`
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const frame = JSON.parse(line)
        if (frame.stream) execOutput.textContent += frame.data
        else execOutput.textContent += `\n[exit ${frame.exitCode ?? '?'} in ${frame.durationMs}ms]\n`
      }
    }
    execOutput.scrollTop = execOutput.scrollHeight
  } catch (err) {
    execOutput.textContent += `[error] ${(err as Error).message}\n`
  }
})

void detectAuthMode().then(refreshHostList)
