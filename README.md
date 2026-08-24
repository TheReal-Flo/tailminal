# ⚡ Tailminal

[![npm version](https://img.shields.io/npm/v/tailminal.svg)](https://www.npmjs.com/package/tailminal)
[![npm downloads](https://img.shields.io/npm/dm/tailminal.svg)](https://www.npmjs.com/package/tailminal)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use the terminal of any device in your Tailscale tailnet from any other device —
manually via a web UI, interactively via CLI, or programmatically from agents
(plain stdin/stdout subprocess).

```
┌─────────────┐   HTTP + WebSocket    ┌─────────────┐
│  PC (client)│◄─────────────────────►│ Laptop      │
│  tailminal  │    over tailnet       │ (server)    │
└─────────────┘                       └─────────────┘
Every node runs the same single binary: server + CLI + web UI.
No central hub. Discovery via MagicDNS.
```

## Features

- **One-shot exec** — run a command on any node, stream stdout/stderr, get the exit code
- **Persistent PTY sessions** — interactive shells that survive disconnects; reattach with scrollback replay
- **Agent-friendly CLI** — `tailminal exec` / `tailminal attach` are plain stdin/stdout subprocesses any agent framework can spawn
- **Web UI on every node** — host list, live xterm.js terminal, one-shot command form
- **Cross-platform** — Windows (PowerShell/CMD), macOS (zsh), Linux (bash/sh)
- **Zero-setup tailnet access** — Tailscale and loopback clients connect without another credential

## Install

```bash
npm install -g tailminal
```

Or from source:

```bash
git clone https://github.com/TheReal-Flo/tailminal
cd tailminal && pnpm install && pnpm build
```

Start the node server (generates `~/.tailminal/config.json` on first run):

```bash
tailminal serve        # listens on 0.0.0.0:7601
```

## Configuration — `~/.tailminal/config.json`

```json
{
  "port": 7601,
  "auth": "tailnet",
  "sessionTTL": "persistent",
  "peers": [
    { "name": "laptop", "address": "laptop.your-tailnet.ts.net" }
  ]
}
```

| Key          | Default       | Meaning                                                        |
| ------------ | ------------- | -------------------------------------------------------------- |
| `port`       | `7601`        | Fixed listen port for all nodes                                |
| `auth`       | `tailnet`     | Passwordless access from loopback/Tailscale addresses; use `token` for legacy bearer auth |
| `sessionTTL` | `persistent`  | Sessions live until reboot; or auto-reap detached ones (`30m`, `12h`, `7d`, …) |
| `shell`      | platform default | Override the PTY login shell executable                     |
| `peers`      | `[]`          | MagicDNS hostnames shown in the host list                      |

With the default `"auth": "tailnet"`, no token setup is needed. Requests from
LAN and public addresses are rejected even though the server listens on all
interfaces. To opt into the old credential flow, set `"auth": "token"`; the
server then creates `~/.tailminal/token`, and clients can use that file or
`TAILMINAL_TOKEN`.

## CLI

```
tailminal serve                          Start the node server
tailminal hosts                          List configured peers + status
tailminal exec <host> [opts] -- <cmd...> One-shot command (streams output, propagates exit code)
    --cwd <dir>                          Remote working directory
    --shell <auto|powershell|cmd|sh>     Shell preference (Windows: powershell/cmd)
    --timeout-ms <n>                     Kill after n ms
tailminal attach <host> [session-id]     Interactive PTY over stdio (Ctrl+] detaches, session stays alive)
tailminal sessions <host>                List remote sessions
tailminal token                          Print the token when using auth: "token"
```

Hosts can be MagicDNS names (`laptop`), full URLs (`http://laptop:7601`), or
peer names from your config.

### Agent usage

Agents need zero integration — just spawn a subprocess:

```bash
tailminal exec laptop -- adb devices          # exit code propagates
tailminal attach laptop                        # raw bidirectional shell on stdin/stdout
```

### Web UI

Open `http://<node>:7601` over Tailscale, pick a host, and get a live terminal.
No credential prompt appears in the default tailnet mode.

## Autostart

**Windows** (Task Scheduler, run at logon):

```powershell
schtasks /create /tn Tailminal /tr "node C:\path\to\apps\cli\dist\index.js serve" /sc onlogon
```

**Linux** (systemd user service, `~/.config/systemd/user/tailminal.service`):

```ini
[Unit]
Description=Tailminal node server

[Service]
ExecStart=/usr/bin/node /opt/tailminal/apps/cli/dist/index.js serve
Restart=on-failure

[Install]
WantedBy=default.target
```

**macOS** (launchd, `~/Library/LaunchAgents/dev.tailminal.plist`): use
`RunAtLoad` with the same node command.

## Monorepo layout

| Package               | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `packages/shared`     | Zod protocol types shared by all packages        |
| `packages/server`     | Fastify server, PTY manager, auth, static web UI |
| `packages/client`     | HTTP + WebSocket client library                  |
| `packages/web` (ui-src in server) | xterm.js UI bundled to `static/`     |
| `apps/cli`           | `tailminal` binary                               |
| `website/`           | Static marketing site + `/llms.txt` agent docs   |

## Development

```bash
pnpm build        # build all packages (topological)
pnpm typecheck    # strict tsc across the workspace
pnpm test         # vitest unit tests
```

## Website

`website/` is a dependency-free static site. The human-facing page is
`index.html`; agents are pointed at `/llms.txt` (via an HTML comment,
`<link rel="llms-txt">`, and a footer note) which contains machine-readable
setup and API documentation. Serve the folder with any static file server, or
point the node server at it:

```bash
TAILMINAL_STATIC=./website tailminal serve
```
