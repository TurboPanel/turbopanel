import { assertEquals } from '@std/assert'
import {
  checkShellFrame,
  controlFrameText,
  looksLikeShellFrame,
  isShellSid,
  PendingShellOpens,
  SHELL_DIR_TO_BROWSER,
  SHELL_EARLY_MAX_BYTES,
  SHELL_EARLY_MAX_FRAMES,
  SHELL_DIR_TO_DAEMON,
  SHELL_FRAME_OVERHEAD_BYTES,
  SHELL_HEADER_BYTES,
  ShellBudget,
  peekShellFrame,
  type PendingShellOpen,
} from './shell-relay.ts'

const test = Deno.test.bind(Deno)

const SID = '11111111-2222-4333-8444-555555555555'

function frame(opts: { sid?: string; dir?: number; size?: number; version?: number }): Uint8Array {
  const out = new Uint8Array(opts.size ?? SHELL_FRAME_OVERHEAD_BYTES + 4)
  out[0] = opts.version ?? 1
  const hex = (opts.sid ?? SID).replaceAll('-', '')
  for (let i = 0; i < 16; i++) out[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  out[17] = opts.dir ?? SHELL_DIR_TO_DAEMON
  return out
}

const expectToDaemon = { dir: SHELL_DIR_TO_DAEMON, sid: SID, maxFrameBytes: 1024 }

test('frame check: header, direction, sid and size', () => {
  assertEquals(checkShellFrame(frame({}), expectToDaemon), { ok: true })
  assertEquals(checkShellFrame(frame({ size: SHELL_HEADER_BYTES }), expectToDaemon), {
    ok: false,
    reason: 'malformed',
  })
  assertEquals(checkShellFrame(frame({ version: 2 }), expectToDaemon), {
    ok: false,
    reason: 'malformed',
  })
  assertEquals(checkShellFrame(frame({ dir: SHELL_DIR_TO_BROWSER }), expectToDaemon), {
    ok: false,
    reason: 'direction',
  })
  assertEquals(
    checkShellFrame(frame({ sid: '99999999-2222-4333-8444-555555555555' }), expectToDaemon),
    { ok: false, reason: 'foreign_sid' }
  )
  assertEquals(
    checkShellFrame(frame({ size: SHELL_FRAME_OVERHEAD_BYTES + 1025 }), expectToDaemon),
    { ok: false, reason: 'oversize' }
  )
  assertEquals(peekShellFrame(frame({}))?.sid, SID)
})

test('sid shape', () => {
  assertEquals(isShellSid(SID), true)
  assertEquals(isShellSid('AAAAAAAA-2222-4333-8444-555555555555'), false)
  assertEquals(isShellSid('x'), false)
  assertEquals(isShellSid(5), false)
})

test('budget: a window refills, an overrun refuses', () => {
  const budget = new ShellBudget({ windowMs: 1000, maxMessages: 2, maxBytes: 100 })
  assertEquals(budget.take(10, 5000), true)
  assertEquals(budget.take(10, 5100), true)
  assertEquals(budget.take(10, 5200), false)
  assertEquals(budget.take(10, 6100), true)
  assertEquals(budget.take(200, 6200), false)
})

test('pending opens: single use and a 30 second life', () => {
  const pending = new PendingShellOpens()
  const open = {
    sid: SID,
    expiresAtMs: 31_000,
  } as PendingShellOpen
  pending.add(open, 1000)
  assertEquals(pending.has(SID, 2000), true)
  assertEquals(pending.take(SID, 2000)?.sid, SID)
  assertEquals(pending.take(SID, 2000), null)
  pending.add(open, 1000)
  assertEquals(pending.take(SID, 31_000), null)
})

test('peek: too short, wrong version and unknown direction are not frames', () => {
  assertEquals(peekShellFrame(new Uint8Array(SHELL_HEADER_BYTES)), null)
  assertEquals(peekShellFrame(frame({ version: 2 })), null)
  assertEquals(peekShellFrame(frame({ dir: 7 })), null)
  assertEquals(peekShellFrame(frame({ dir: SHELL_DIR_TO_BROWSER }))?.dir, SHELL_DIR_TO_BROWSER)
})

test('looks like a shell frame: header length and version only', () => {
  assertEquals(looksLikeShellFrame(frame({})), true)
  assertEquals(looksLikeShellFrame(frame({ version: 2 })), false)
  assertEquals(looksLikeShellFrame(new Uint8Array(3)), false)
})

test('pending opens: get, list, delete and clear sweep expired ones', () => {
  const pending = new PendingShellOpens()
  const other = '99999999-2222-4333-8444-555555555555'
  pending.add({ sid: SID, expiresAtMs: 5000 } as PendingShellOpen, 0)
  pending.add({ sid: other, expiresAtMs: 50_000 } as PendingShellOpen, 0)
  assertEquals(pending.get(SID, 1000)?.sid, SID)
  assertEquals(pending.list(1000).length, 2)
  assertEquals(
    pending.list(6000).map((open) => open.sid),
    [other]
  )
  assertEquals(pending.get(SID, 6000), null)
  pending.delete(other)
  assertEquals(pending.has(other, 6000), false)
  pending.add({ sid: SID, expiresAtMs: 50_000 } as PendingShellOpen, 0)
  pending.clear()
  assertEquals(pending.list(0), [])
})

test('control frames are plain JSON text', () => {
  assertEquals(JSON.parse(controlFrameText({ type: 'error', sid: SID, code: 'no_shell' })), {
    type: 'error',
    sid: SID,
    code: 'no_shell',
  })
})

test('pending opens: early frames are held in order and bounded by count and bytes', () => {
  const pending = new PendingShellOpens()
  pending.add({ sid: SID, expiresAtMs: 50_000 } as PendingShellOpen, 0)
  assertEquals(pending.bufferEarly(SID, new ArrayBuffer(8), 10), 'buffered')
  assertEquals(pending.bufferEarly('nope', new ArrayBuffer(8), 10), 'unknown')
  for (let i = 1; i < SHELL_EARLY_MAX_FRAMES; i++) pending.bufferEarly(SID, new ArrayBuffer(1), 10)
  assertEquals(pending.bufferEarly(SID, new ArrayBuffer(1), 10), 'overflow')

  const big = new PendingShellOpens()
  big.add({ sid: SID, expiresAtMs: 50_000 } as PendingShellOpen, 0)
  assertEquals(big.bufferEarly(SID, new ArrayBuffer(SHELL_EARLY_MAX_BYTES), 10), 'buffered')
  assertEquals(big.bufferEarly(SID, new ArrayBuffer(1), 10), 'overflow')
})

test('pending opens: a ttl drop is reported to the owner', () => {
  const dropped: string[] = []
  const pending = new PendingShellOpens((open) => dropped.push(open.sid))
  pending.add({ sid: SID, expiresAtMs: 5000 } as PendingShellOpen, 0)
  pending.list(6000)
  assertEquals(dropped, [SID])
  pending.add({ sid: SID, expiresAtMs: 50_000 } as PendingShellOpen, 0)
  pending.take(SID, 10)
  pending.list(60_000)
  assertEquals(dropped, [SID])
})
