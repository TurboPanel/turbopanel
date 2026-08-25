import { assertEquals } from '@std/assert'
import {
  blockedCopy,
  nextStateAfterFence,
  nextStateAfterIngressReconcile,
  nextStateAfterPromoteSuccess,
  nextStateAfterVerify,
  verifyFenced,
} from './ha-recovery-pure.ts'
import { AUTOMATIC_FAILOVER_BLOCKED_MESSAGE } from '../../lib/managed/recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('verifyFenced requires drain plus stop', () => {
  assertEquals(verifyFenced({ oldPrimaryReachable: true, drainApplied: true, stopApplied: true }), true)
  assertEquals(verifyFenced({ oldPrimaryReachable: true, drainApplied: true, stopApplied: false }), false)
  assertEquals(verifyFenced({ oldPrimaryReachable: false, drainApplied: false, stopApplied: false }), false)
})

test('fence success advances automatic failover to promoting', () => {
  const next = nextStateAfterFence({
    kind: 'automatic-failover',
    outcome: { oldPrimaryReachable: true, drainApplied: true, stopApplied: true },
    metadata: {},
  })
  assertEquals(next.state, 'promoting')
  if (next.state !== 'blocked') {
    assertEquals(next.metadata.fenced, true)
  }
})

test('unproven fence blocks automatic failover', () => {
  const next = nextStateAfterFence({
    kind: 'automatic-failover',
    outcome: { oldPrimaryReachable: false, drainApplied: false, stopApplied: false },
    metadata: {},
  })
  assertEquals(next.state, 'blocked')
  if (next.state === 'blocked') {
    assertEquals(next.reason, AUTOMATIC_FAILOVER_BLOCKED_MESSAGE)
  }
})

test('operator switchover continues when the old primary is gone', () => {
  const next = nextStateAfterFence({
    kind: 'switchover',
    outcome: { oldPrimaryReachable: false, drainApplied: false, stopApplied: false },
    metadata: {},
  })
  assertEquals(next.state, 'promoting')
  if (next.state !== 'blocked') {
    assertEquals(next.metadata.fenced, false)
  }
})

test('operator disaster recovery continues when the old site is gone', () => {
  const next = nextStateAfterFence({
    kind: 'disaster-recovery',
    outcome: { oldPrimaryReachable: false, drainApplied: true, stopApplied: false },
    metadata: {},
  })
  assertEquals(next.state, 'promoting')
})

test('promote then ingress then exactly-one-writer completes', () => {
  assertEquals(nextStateAfterPromoteSuccess({}).state, 'repointing')
  assertEquals(nextStateAfterIngressReconcile({}).state, 'verifying')
  assertEquals(nextStateAfterVerify({ writerCount: 1, metadata: {} }).state, 'completed')
  assertEquals(nextStateAfterVerify({ writerCount: 2, metadata: {} }).state, 'failed')
})

test('blockedCopy is the automatic-failover operator sentence', () => {
  assertEquals(blockedCopy(), AUTOMATIC_FAILOVER_BLOCKED_MESSAGE)
})
