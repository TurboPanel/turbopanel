import { assertEquals } from '@std/assert'
import {
  checkShellFrame,
  isShellSid,
  PendingShellOpens,
  SHELL_DIR_TO_BROWSER,
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
