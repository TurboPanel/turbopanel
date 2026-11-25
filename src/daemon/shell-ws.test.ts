/**
 * The self-hosted browser terminal socket on a real `Deno.serve` upgrade: the
 * Origin and ticket rules, single use, the wrong user, and the relay through
 * the hub in both directions. The daemon side is a recording link.
 */
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { DaemonMessage } from '../contracts/cell-protocol.ts'
import type { ShellOpenRequest } from '../contracts/cell.ts'
import {
  SHELL_DIR_TO_BROWSER,
  SHELL_DIR_TO_DAEMON,
  SHELL_FRAME_OVERHEAD_BYTES,
} from '../contracts/shell-relay.ts'
import { signShellTicket, SHELL_TICKET_PURPOSE } from '../features/terminal/ticket.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { ShellHub } from './shell-hub.ts'
import { registerShellWebSocket } from './shell-ws.ts'

const test = Deno.test.bind(Deno)

const SID = '11111111-2222-4333-8444-555555555555'
const SERVER = 'server-a'
const CONN = 'conn-1'
const keyring = await deriveSecretsConfig(parseTestSecretsConfig('deno'), SHELL_TICKET_PURPOSE)

function openRequest(): ShellOpenRequest {
  return {
    sid: SID,
    orgId: 'org-1',
    userId: 'user-1',
    authSessionId: 'auth-1',
    userLabel: 'user@example.net',
    kind: 'container',
    containerId: 'abc123',
    loginUser: '',
    cols: 80,
    rows: 24,
    keySealed: 'sealed',
    idleSec: 900,
    maxSec: 3600,
    windowBytes: 262144,
    maxFrameBytes: 16384,
  }
}

function frame(dir: number, tag: number): ArrayBuffer {
  const out = new Uint8Array(SHELL_FRAME_OVERHEAD_BYTES + 4)
  out[0] = 1
  const hex = SID.replaceAll('-', '')
  for (let i = 0; i < 16; i++) out[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  out[17] = dir
  out[out.length - 1] = tag
  return out.buffer
}

async function withServer(
  fn: (ctx: {
    hub: ShellHub
    base: string
    toDaemon: ArrayBuffer[]
    sent: DaemonMessage[]
  }) => Promise<void>,
  options: { secrets?: boolean } = {}
): Promise<void> {
  const hub = new ShellHub()
  const sent: DaemonMessage[] = []
  const toDaemon: ArrayBuffer[] = []
  hub.attachDaemon(SERVER, {
    connectionId: CONN,
    ready: () => true,
    send: (message) => {
      sent.push(message)
      return Promise.resolve()
    },
    sendBinary: (data) => void toDaemon.push(data),
  })
  const app = new Hono()
  registerShellWebSocket(app, {
    hub,
    ticketSecrets: options.secrets === false ? undefined : keyring,
    corsOrigins: 'https://ui.example.net',
  })
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => undefined },
    app.fetch
  )
  try {
    await fn({ hub, base: `127.0.0.1:${server.addr.port}`, toDaemon, sent })
  } finally {
    await server.shutdown()
  }
}

async function ticketFor(userId = 'user-1'): Promise<string> {
  const { ticket } = await signShellTicket(keyring, {
    sid: SID,
    userId,
    authSessionId: 'auth-1',
    serverId: SERVER,
    orgId: 'org-1',
  })
  return ticket
}

/** Connects and resolves with how it ended: the opened socket, or the refused upgrade. */
function connect(
  base: string,
  init: { origin?: string; ticket?: string | null; headers?: Record<string, string> }
): Promise<{ ws: WebSocket } | { refused: true }> {
  const WebSocketCtor = WebSocket as unknown as {
    new (url: string, init: { protocols: string[]; headers: Record<string, string> }): WebSocket
  }
  const protocols = ['tp-shell.v1', ...(init.ticket ? [`tp-ticket.${init.ticket}`] : [])]
  const headers = {
    ...(init.origin ? { Origin: init.origin } : {}),
    ...init.headers,
  }
  const ws = new WebSocketCtor(`ws://${base}/ws/client/v1/shell/${SID}`, { protocols, headers })
  ws.binaryType = 'arraybuffer'
  return new Promise((resolve) => {
    ws.addEventListener('open', () => resolve({ ws }), { once: true })
    ws.addEventListener('error', () => resolve({ refused: true }), { once: true })
  })
}

function nextMessage(ws: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (event) => resolve(event.data as string | ArrayBuffer), {
      once: true,
    })
  })
}

test('a refused upgrade: no origin, a foreign origin, no ticket, a bad ticket', async () => {
  await withServer(async ({ hub, base }) => {
    await hub.cellFor(SERVER).shellOpen?.(openRequest())
    const ticket = await ticketFor()
    for (const init of [
      { ticket },
      { origin: 'https://evil.example.org', ticket },
      { origin: `http://${base}`, ticket: null },
      { origin: `http://${base}`, ticket: 'tpshell.v1.bad.bad' },
    ]) {
      assertEquals(await connect(base, init), { refused: true })
    }
    // None of those spent the pending open.
    assertEquals(hub.claim(SID, 'user-1', 'auth-1').ok, true)
  })
})

test('without ticket secrets the route answers 503', async () => {
  await withServer(
    async ({ base }) => {
      assertEquals(await connect(base, { origin: `http://${base}`, ticket: 'x' }), {
        refused: true,
      })
    },
    { secrets: false }
  )
})

test('a ticket for another user is refused and ends the daemon session', async () => {
  await withServer(async ({ hub, base, sent }) => {
    await hub.cellFor(SERVER).shellOpen?.(openRequest())
    const result = await connect(base, {
      origin: `http://${base}`,
      ticket: await ticketFor('user-2'),
      // Cell-routing headers a client sends have no effect on the identity used.
      headers: { 'X-Turbopanel-Cell-Shell-User': 'user-1' },
    })
    assertEquals(result, { refused: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assertEquals(sent.at(-1), { type: 'shell-kill', sid: SID, reason: 'revoked' })
  })
})

test('the browser relays both ways, early output first, and a ticket works once', async () => {
  await withServer(async ({ hub, base, toDaemon }) => {
    await hub.cellFor(SERVER).shellOpen?.(openRequest())
    hub.onDaemonFrame(CONN, frame(SHELL_DIR_TO_BROWSER, 7))
    const ticket = await ticketFor()
    const result = await connect(base, { origin: `http://${base}`, ticket })
    if (!('ws' in result)) throw new Error('upgrade refused')
    const { ws } = result
    assertEquals(ws.protocol, 'tp-shell.v1')
    const early = await nextMessage(ws)
    assertEquals(new Uint8Array(early as ArrayBuffer).at(-1), 7)

    ws.send(frame(SHELL_DIR_TO_DAEMON, 9))
    const deadline = Date.now() + 5000
    while (toDaemon.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assertEquals(new Uint8Array(toDaemon[0]).at(-1), 9)

    // The same ticket again finds no pending open.
    assertEquals(await connect(base, { origin: `http://${base}`, ticket }), { refused: true })
    ws.close()
  })
})
