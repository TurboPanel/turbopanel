import { assertEquals } from '@std/assert'
import type { DaemonMessage } from '../contracts/cell-protocol.ts'
import type { ShellOpenRequest } from '../contracts/cell.ts'
import {
  SHELL_CLOSE,
  SHELL_DAEMON_BUDGET,
  SHELL_DIR_TO_BROWSER,
  SHELL_EARLY_MAX_FRAMES,
  SHELL_FRAME_OVERHEAD_BYTES,
  SHELL_LATE_CLOSE_BUDGET,
  SHELL_PENDING_TTL_MS,
} from '../contracts/shell-relay.ts'
import type { Db } from '../db/connection.ts'
import { type HubBrowserLink, type HubDaemonLink, ShellHub } from './shell-hub.ts'

const test = Deno.test.bind(Deno)

const SID = '11111111-2222-4333-8444-555555555555'
const SERVER = 'server-a'
const CONN = 'conn-1'

type Row = { action: string; targetId: string | null; context: Record<string, unknown> | null }

/** Records inserted audit rows; `existing` is what the late-close lookup finds. */
function fakeDb(existing: Row[] = []): { db: Db; rows: Row[] } {
  const rows: Row[] = []
  const db = {
    insert: () => ({
      values: (row: Row) => {
        rows.push(row)
        return Promise.resolve()
      },
    }),
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(
            Promise.resolve(
              existing.map((row) => ({
                action: row.action,
                organizationId: 'org-1',
                actorUserId: 'user-1',
                context: row.context,
              }))
            ),
            { limit: () => Promise.resolve([{ organizationId: 'org-1' }]) }
          ),
      }),
    }),
  }
  return { db: db as unknown as Db, rows }
}

function daemonLink(connectionId = CONN): HubDaemonLink & { sent: DaemonMessage[] } {
  const sent: DaemonMessage[] = []
  return {
    connectionId,
    sent,
    ready: () => true,
    send: (message) => {
      sent.push(message)
      return Promise.resolve()
    },
    sendBinary: () => undefined,
  }
}

function browserLink(): HubBrowserLink & {
  got: Array<string | ArrayBuffer>
  closes: Array<[number, string]>
} {
  const got: Array<string | ArrayBuffer> = []
  const closes: Array<[number, string]> = []
  return {
    got,
    closes,
    send: (data) => void got.push(data),
    close: (code, reason) => void closes.push([code, reason]),
  }
}

function request(): ShellOpenRequest {
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

function daemonFrame(tag = 0): ArrayBuffer {
  const out = new Uint8Array(SHELL_FRAME_OVERHEAD_BYTES + 4)
  out[0] = 1
  const hex = SID.replaceAll('-', '')
  for (let i = 0; i < 16; i++) out[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  out[17] = SHELL_DIR_TO_BROWSER
  out[out.length - 1] = tag
  return out.buffer
}

function setup(existing: Row[] = []) {
  let now = 1_000_000
  const { db, rows } = fakeDb(existing)
  const hub = new ShellHub({ db, nowMs: () => now })
  const daemon = daemonLink()
  hub.attachDaemon(SERVER, daemon)
  return {
    hub,
    daemon,
    rows,
    advance: (ms: number) => void (now += ms),
    cell: hub.cellFor(SERVER),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('refuses an open when this process does not hold the daemon', async () => {
  const hub = new ShellHub()
  assertEquals(await hub.cellFor(SERVER).shellOpen?.(request()), {
    ok: false,
    code: 'daemon_elsewhere',
  })
})

test('output sent before the browser connects is flushed in order after the outcome', async () => {
  const { hub, cell } = setup()
  assertEquals((await cell.shellOpen?.(request()))?.ok, true)
  hub.onDaemonFrame(CONN, daemonFrame(1))
  hub.onDaemonFrame(CONN, daemonFrame(2))
  await hub.onDaemonReport(
    SERVER,
    CONN,
    { type: 'shell-opened', sid: SID, shell: '/bin/sh', user: 'root', at: 'x' },
    'verified'
  )
  const claim = hub.claim(SID, 'user-1', 'auth-1')
  if (!claim.ok) throw new Error('claim refused')
  const browser = browserLink()
  hub.activate(claim.pending, browser)
  assertEquals(browser.got.length, 3)
  assertEquals(typeof browser.got[0], 'string')
  assertEquals(new Uint8Array(browser.got[1] as ArrayBuffer).at(-1), 1)
  assertEquals(new Uint8Array(browser.got[2] as ArrayBuffer).at(-1), 2)
})

test('too much early output kills the session with a shell-kill and a close row', async () => {
  const { hub, cell, daemon, rows } = setup()
  await cell.shellOpen?.(request())
  for (let i = 0; i <= SHELL_EARLY_MAX_FRAMES; i++) hub.onDaemonFrame(CONN, daemonFrame(i))
  await tick()
  assertEquals(daemon.sent.at(-1), { type: 'shell-kill', sid: SID, reason: 'revoked' })
  assertEquals(rows.length, 1)
  assertEquals(rows[0].action, 'server.terminal.close')
  assertEquals(hub.claim(SID, 'user-1', 'auth-1'), { ok: false, status: 410 })
})

test('an open nobody claims expires: shell-kill and a close row', async () => {
  const { hub, cell, daemon, rows, advance } = setup()
  await cell.shellOpen?.(request())
  advance(SHELL_PENDING_TTL_MS + 1)
  hub.reap()
  await tick()
  assertEquals(daemon.sent.at(-1), { type: 'shell-kill', sid: SID, reason: 'expired' })
  assertEquals(
    rows.map((row) => row.action),
    ['server.terminal.close']
  )
  assertEquals(rows[0].context?.reason, 'expired')
})

test('the wrong user is refused 403 and the daemon session is killed with a row', async () => {
  const { hub, cell, daemon, rows } = setup()
  await cell.shellOpen?.(request())
  assertEquals(hub.claim(SID, 'user-2', 'auth-1'), { ok: false, status: 403 })
  await tick()
  assertEquals(daemon.sent.at(-1), { type: 'shell-kill', sid: SID, reason: 'revoked' })
  assertEquals(rows.length, 1)
  assertEquals(rows[0].context?.reason, 'client')
  assertEquals(hub.claim(SID, 'user-1', 'auth-1'), { ok: false, status: 410 })
})

test('a ticket is single use', async () => {
  const { hub, cell } = setup()
  await cell.shellOpen?.(request())
  assertEquals(hub.claim(SID, 'user-1', 'auth-1').ok, true)
  assertEquals(hub.claim(SID, 'user-1', 'auth-1'), { ok: false, status: 410 })
})

test('a late shell-closed for an unknown sid closes the open audit row once', async () => {
  const open: Row = {
    action: 'server.terminal.open',
    targetId: SERVER,
    context: { sid: SID, kind: 'container', containerId: 'abc123', loginUser: '' },
  }
  const { hub, rows } = setup([open])
  const closed: DaemonMessage = {
    type: 'shell-closed',
    sid: SID,
    reason: 'exit',
    durationMs: 5,
    bytesIn: 1,
    bytesOut: 2,
    at: 'x',
  }
  await hub.onDaemonReport(SERVER, CONN, closed, 'verified')
  assertEquals(
    rows.map((row) => row.action),
    ['server.terminal.close']
  )
  // Unsigned reports are ignored.
  await hub.onDaemonReport(SERVER, CONN, closed, 'unsigned')
  assertEquals(rows.length, 1)
})

test('unknown-sid close lookups are capped per daemon connection', async () => {
  const { hub, rows } = setup([
    {
      action: 'server.terminal.open',
      targetId: SERVER,
      context: { sid: SID, kind: 'container', containerId: 'abc123', loginUser: '' },
    },
  ])
  const closed = (sid: string): DaemonMessage => ({
    type: 'shell-closed',
    sid,
    reason: 'exit',
    durationMs: 5,
    bytesIn: 1,
    bytesOut: 2,
    at: 'x',
  })
  const other = (n: number) => `22222222-2222-4333-8444-${n.toString().padStart(12, '0')}`
  // The allowance is spent first; a late close past it is dropped, not looked up.
  for (let n = 0; n < SHELL_LATE_CLOSE_BUDGET.maxMessages; n++) {
    await hub.onDaemonReport(SERVER, CONN, closed(other(n)), 'verified')
  }
  const spent = rows.length
  const warn = console.warn
  const warned: string[] = []
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    await hub.onDaemonReport(SERVER, CONN, closed(SID), 'verified')
  } finally {
    console.warn = warn
  }
  assertEquals(rows.length, spent)
  assertEquals(warned.length, 1)
  // A new connection has its own allowance.
  await hub.onDaemonReport(SERVER, 'conn-2', closed(SID), 'verified')
  assertEquals(rows.length, spent + 1)
})

test('replacing the daemon connection leaves a session on the old one ended, not the new one', async () => {
  const { hub, cell, rows } = setup()
  await cell.shellOpen?.(request())
  const claim = hub.claim(SID, 'user-1', 'auth-1')
  if (!claim.ok) throw new Error('claim refused')
  const browser = browserLink()
  hub.activate(claim.pending, browser)
  await hub.detachDaemon(SERVER, 'other-conn')
  assertEquals(browser.closes, [])
  await hub.detachDaemon(SERVER, CONN)
  assertEquals(browser.closes.at(-1)?.[0], SHELL_CLOSE.daemonLost)
  assertEquals(rows[0].context?.confirmed, false)
})

test('daemon output past the per-session budget closes only that browser socket', async () => {
  const { hub, cell, daemon } = setup()
  await cell.shellOpen?.(request())
  const claim = hub.claim(SID, 'user-1', 'auth-1')
  if (!claim.ok) throw new Error('claim refused')
  const browser = browserLink()
  hub.activate(claim.pending, browser)
  for (let i = 0; i <= SHELL_DAEMON_BUDGET.maxMessages; i++) hub.onDaemonFrame(CONN, daemonFrame(i))
  assertEquals(browser.closes, [[SHELL_CLOSE.budget, 'shell_budget']])
  assertEquals(
    daemon.sent.some((m) => m.type === 'shell-kill'),
    false
  )
})

test('an unconfirmed close is audited when the browser leaves and the daemon is gone', async () => {
  const { hub, cell, rows } = setup()
  await cell.shellOpen?.(request())
  const claim = hub.claim(SID, 'user-1', 'auth-1')
  if (!claim.ok) throw new Error('claim refused')
  hub.activate(claim.pending, browserLink())
  await hub.detachDaemon(SERVER, CONN)
  await hub.onBrowserClosed(SID)
  assertEquals(rows.length, 1)
  assertEquals(rows[0].context?.confirmed, false)
})

test('a revoked sign-in ends a live session: browser closed, daemon told, close row now', async () => {
  const { hub, cell, rows, daemon } = setup()
  await cell.shellOpen?.(request())
  const claim = hub.claim(SID, 'user-1', 'auth-1')
  if (!claim.ok) throw new Error('claim refused')
  const browser = browserLink()
  hub.activate(claim.pending, browser)

  // Nothing revoked: nothing happens.
  assertEquals(await hub.endRevoked(() => Promise.resolve(null)), 0)
  assertEquals(rows.length, 0)

  assertEquals(
    await hub.endRevoked((meta) => Promise.resolve(meta.sid === SID ? 'session-ended' : null)),
    1
  )
  assertEquals(browser.closes.length, 1)
  assertEquals(browser.closes[0]?.[0], SHELL_CLOSE.killed)
  const kill = daemon.sent.find((message) => message.type === 'shell-kill')
  assertEquals(kill && 'sid' in kill ? kill.sid : null, SID)
  assertEquals(kill && 'reason' in kill ? kill.reason : null, 'revoked')
  assertEquals(rows.length, 1)
  assertEquals(rows[0].action, 'server.terminal.close')
  assertEquals(rows[0].context?.reason, 'revoked:session-ended')
  assertEquals(rows[0].context?.confirmed, true)

  // The daemon's own report for it afterwards writes no second row.
  await hub.onDaemonReport(
    SERVER,
    CONN,
    {
      type: 'shell-closed',
      sid: SID,
      reason: 'kill',
      durationMs: 5,
      bytesIn: 0,
      bytesOut: 0,
    } as DaemonMessage,
    'verified'
  )
  assertEquals(rows.length, 1)
})

test('a revoked sign-in also ends an open still waiting for its browser', async () => {
  const { hub, cell, rows } = setup()
  await cell.shellOpen?.(request())
  assertEquals(await hub.endRevoked(() => Promise.resolve('user-disabled')), 1)
  assertEquals(rows.length, 1)
  assertEquals(rows[0].context?.reason, 'revoked:user-disabled')
  assertEquals(hub.claim(SID, 'user-1', 'auth-1').ok, false)
})
