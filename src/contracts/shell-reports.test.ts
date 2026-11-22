import { assertEquals } from '@std/assert'
import { validateShellReportFields } from './cell-protocol.ts'

const test = Deno.test.bind(Deno)

const SID = '11111111-2222-4333-8444-555555555555'
const AT = '2026-11-21T10:00:00.000Z'

const closed = {
  type: 'shell-closed',
  sid: SID,
  reason: 'exit',
  exitCode: 0,
  durationMs: 10,
  bytesIn: 1,
  bytesOut: 2,
  at: AT,
}

test('shell reports: other types are not theirs to judge', () => {
  assertEquals(validateShellReportFields({ type: 'hello' }), undefined)
})

test('shell-opened: needs a shell and a user', () => {
  const opened = { type: 'shell-opened', sid: SID, shell: '/bin/sh', user: 'app', at: AT }
  assertEquals(validateShellReportFields(opened), null)
  assertEquals(validateShellReportFields({ ...opened, shell: 5 }), 'invalid shell')
  assertEquals(validateShellReportFields({ ...opened, user: 'x'.repeat(257) }), 'invalid user')
})

test('shell-closed: reason, exit code and counters are checked', () => {
  assertEquals(validateShellReportFields(closed), null)
  assertEquals(validateShellReportFields({ ...closed, exitCode: undefined }), null)
  assertEquals(validateShellReportFields({ ...closed, reason: 'bogus' }), 'invalid reason')
  assertEquals(validateShellReportFields({ ...closed, exitCode: 1.5 }), 'invalid exitCode')
  assertEquals(validateShellReportFields({ ...closed, durationMs: -1 }), 'invalid durationMs')
  assertEquals(validateShellReportFields({ ...closed, bytesIn: 'x' }), 'invalid bytesIn')
  assertEquals(validateShellReportFields({ ...closed, bytesOut: 1.5 }), 'invalid bytesOut')
})

test('shell-error: a known code only', () => {
  const error = { type: 'shell-error', sid: SID, code: 'no_shell', at: AT }
  assertEquals(validateShellReportFields(error), null)
  assertEquals(validateShellReportFields({ ...error, code: 'nope' }), 'invalid code')
})

test('every shell report needs a sid and a timestamp', () => {
  assertEquals(validateShellReportFields({ ...closed, sid: 'x' }), 'invalid sid')
  assertEquals(validateShellReportFields({ ...closed, at: 'yesterday' }), 'invalid at timestamp')
})
