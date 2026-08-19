import { assertEquals } from '@std/assert'
import {
  isRecoveryKind,
  isRecoveryState,
  isTerminalRecoveryState,
  parseRecoveryMetadata,
  serializeRecovery,
  type RecoveryRecord,
} from './recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('recovery kind and state guards', () => {
  assertEquals(isRecoveryKind('automatic-failover'), true)
  assertEquals(isRecoveryKind('switchover'), true)
  assertEquals(isRecoveryKind('disaster-recovery'), true)
  assertEquals(isRecoveryKind('promote'), false)
  assertEquals(isRecoveryState('fencing'), true)
  assertEquals(isRecoveryState('blocked'), true)
  assertEquals(isRecoveryState('running'), false)
  assertEquals(isTerminalRecoveryState('completed'), true)
  assertEquals(isTerminalRecoveryState('failed'), true)
  assertEquals(isTerminalRecoveryState('blocked'), true)
  assertEquals(isTerminalRecoveryState('promoting'), false)
})

test('parseRecoveryMetadata keeps fencing epoch and blocked reason', () => {
  assertEquals(parseRecoveryMetadata(null), {})
  assertEquals(parseRecoveryMetadata(['not-an-object']), {})
  assertEquals(
    parseRecoveryMetadata({
      fencingEpoch: 'epoch-1',
      fenced: true,
      blockedReason: 'unfenced',
      fenceCommandIds: ['c1', 2],
      lagBytes: 12,
    }),
    {
      fencingEpoch: 'epoch-1',
      fenced: true,
      blockedReason: 'unfenced',
      fenceCommandIds: ['c1'],
      lagBytes: 12,
    },
  )
})

test('parseRecoveryMetadata copies command ids, flags, and nullable fields', () => {
  assertEquals(
    parseRecoveryMetadata({
      promoteCommandId: 'p1',
      failoverCommandId: 'f1',
      ingressCommandIds: ['i1', 9],
      haPresent: false,
      drainApplied: true,
      stopApplied: false,
      lagBytes: null,
      sourceDatacenterId: null,
      targetDatacenterId: 'dc-2',
      sourceServerId: 's1',
      targetServerId: 's2',
      fenceCommandIds: 'not-a-list',
      fenced: 'yes',
    }),
    {
      promoteCommandId: 'p1',
      failoverCommandId: 'f1',
      ingressCommandIds: ['i1'],
      haPresent: false,
      drainApplied: true,
      stopApplied: false,
      lagBytes: null,
      sourceDatacenterId: null,
      targetDatacenterId: 'dc-2',
      sourceServerId: 's1',
      targetServerId: 's2',
    },
  )
})

test('serializeRecovery surfaces blocked copy for the UI', () => {
  const row: RecoveryRecord = {
    id: 'r1',
    managedId: 'm1',
    kind: 'automatic-failover',
    sourcePrimaryMemberId: 'p1',
    targetMemberId: null,
    state: 'blocked',
    startedAt: '2020-01-01T00:00:00.000Z',
    completedAt: '2020-01-01T00:01:00.000Z',
    metadata: { blockedReason: 'unable to fence' },
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:01:00.000Z',
  }
  assertEquals(serializeRecovery(row).blockedReason, 'unable to fence')
  assertEquals(serializeRecovery(row).state, 'blocked')
})
