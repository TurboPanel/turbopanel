/**
 * `hello.commandState` frame shape (`validateDaemonInboundFrame`), feature
 * `command-recovery-v2`. Resending lost commands is covered in
 * src/features/commands/command-recovery.hostfree.test.ts.
 */

import { assertEquals } from '@std/assert'
import { validateDaemonInboundFrame } from './cell-protocol.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

const START_ID = '3f2b8a52-0c1e-4c58-9d7e-5b2f6a1d9e10'

function hello(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'hello',
    at: '2026-11-12T14:10:20.000Z',
    daemonBuild: { commit: 'abc', buildId: 'b1' },
    ...extra,
  })
}

function state(patch: Record<string, unknown> = {}) {
  return { processStartId: START_ID, known: ['a', 'b'], complete: true, ...patch }
}

test('a hello may carry a well-formed commandState, or none', () => {
  assertEquals(validateDaemonInboundFrame(hello({})).ok, true)
  assertEquals(validateDaemonInboundFrame(hello({ commandState: state() })).ok, true)
  assertEquals(
    validateDaemonInboundFrame(hello({ commandState: state({ known: [], complete: false }) })).ok,
    true
  )
})

test('a hello with a malformed commandState is rejected', () => {
  const bad = [
    'nope',
    state({ processStartId: 'not-a-uuid' }),
    state({ complete: 'yes' }),
    state({ known: 'a' }),
    state({ known: [1] }),
    state({ known: [''] }),
    state({ known: ['x'.repeat(65)] }),
    state({ known: Array.from({ length: 257 }, (_, i) => `id${i}`) }),
  ]
  for (const commandState of bad) {
    assertEquals(validateDaemonInboundFrame(hello({ commandState })).ok, false)
  }
  assertEquals(
    validateDaemonInboundFrame(
      hello({ commandState: state({ known: Array.from({ length: 256 }, (_, i) => `id${i}`) }) })
    ).ok,
    true
  )
})
