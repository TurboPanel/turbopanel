import { assertEquals, assertThrows } from '@std/assert'
import {
  type FirewallConfirmState,
  type FirewallPendingConfirmation,
  parseCommandPayload,
  parseCommandResult,
} from './schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)

test('server.firewall.confirm takes exactly a lower-case sha256 digest', () => {
  assertEquals(parseCommandPayload('server.firewall.confirm', { digest: DIGEST }), {
    digest: DIGEST,
  })
  for (const bad of [
    undefined,
    '',
    'A'.repeat(64),
    'a'.repeat(63),
    `${'a'.repeat(63)}g`,
    `${DIGEST}\n`,
    42,
  ]) {
    assertThrows(() => parseCommandPayload('server.firewall.confirm', { digest: bad }))
  }
  assertThrows(() => parseCommandPayload('server.firewall.confirm', null))
  assertThrows(() => parseCommandPayload('server.firewall.confirm', []))
})

test('server.firewall.confirm result keeps its state, digest and pending digest', () => {
  const result = {
    state: 'digest_mismatch',
    digest: DIGEST,
    pendingDigest: OTHER_DIGEST,
    summary: 'a different ruleset is pending',
  }
  assertEquals(parseCommandResult('server.firewall.confirm', result), result)
  const states: FirewallConfirmState[] = ['confirmed', 'nothing_pending', 'expired', 'rolled_back']
  for (const state of states) {
    const parsed = parseCommandResult('server.firewall.confirm', {
      state,
      digest: DIGEST,
      summary: 'ok',
    })
    assertEquals(parsed, { state, digest: DIGEST, summary: 'ok' })
  }
})

test('server.firewall.confirm result refuses an unknown state or a malformed digest', () => {
  const base = { state: 'confirmed', digest: DIGEST, summary: 'ok' }
  assertThrows(() => parseCommandResult('server.firewall.confirm', { ...base, state: 'maybe' }))
  assertThrows(() => parseCommandResult('server.firewall.confirm', { ...base, digest: 'x' }))
  assertThrows(() => parseCommandResult('server.firewall.confirm', { ...base, summary: 1 }))
  assertThrows(() =>
    parseCommandResult('server.firewall.confirm', { ...base, pendingDigest: 'nope' })
  )
})

const reconcileResult = {
  generation: 4,
  mode: 'managed',
  applied: true,
  digest: DIGEST,
  ruleCount: 3,
  ipv6Applied: true,
  forwardApplied: false,
  sshPorts: [22],
  warnings: [],
  summary: 'applied',
}

test('server.firewall.reconcile result carries an optional pending confirmation', () => {
  assertEquals(parseCommandResult('server.firewall.reconcile', reconcileResult), reconcileResult)
  const confirmation: FirewallPendingConfirmation = {
    state: 'pending',
    deadlineAt: '2026-10-01T12:02:00.000Z',
    windowSeconds: 120,
  }
  assertEquals(
    parseCommandResult('server.firewall.reconcile', { ...reconcileResult, confirmation }),
    { ...reconcileResult, confirmation }
  )
})

test('server.firewall.reconcile result refuses a malformed confirmation', () => {
  const good = { state: 'pending', deadlineAt: '2026-10-01T12:02:00.000Z', windowSeconds: 120 }
  for (const confirmation of [
    { ...good, state: 'confirmed' },
    { ...good, deadlineAt: 'soon' },
    { ...good, windowSeconds: 0 },
    { ...good, windowSeconds: 7200 },
    { ...good, windowSeconds: 1.5 },
    'pending',
  ]) {
    assertThrows(() =>
      parseCommandResult('server.firewall.reconcile', { ...reconcileResult, confirmation })
    )
  }
})
