import { assertEquals } from '@std/assert'
import {
  ALREADY_WRITABLE_PRIMARY_PROMOTE_ERROR_SAMPLE,
  buildSyntheticPromoteSuccessResult,
  isAlreadyWritablePrimaryPromoteError,
  isTargetAlreadyPrimaryInJournal,
  promoteResumeRequeueRefusal,
} from './promote-resume.ts'
import type { ManagedMemberRow } from './members.ts'
import type { RecoveryRecord } from './recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const REC_ID = '00000000-0000-4000-8000-000000000010'
const MEM_PRIMARY = '00000000-0000-4000-8000-000000000020'
const MEM_REPLICA = '00000000-0000-4000-8000-000000000021'
const MEM_OTHER = '00000000-0000-4000-8000-000000000022'

function recovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: REC_ID,
    managedId: MANAGED_ID,
    kind: 'switchover',
    sourcePrimaryMemberId: MEM_PRIMARY,
    targetMemberId: MEM_REPLICA,
    state: 'promoting',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function member(
  id: string,
  role: 'primary' | 'replica',
  overrides: Partial<ManagedMemberRow> = {}
): ManagedMemberRow {
  return {
    id,
    managedId: MANAGED_ID,
    serverId: '550e8400-e29b-41d4-a716-446655440000',
    role,
    replicaClass: role === 'replica' ? 'failover' : null,
    readEligible: true,
    ordinal: role === 'primary' ? 1 : 2,
    replicationTransport: 'local',
    privatePort: role === 'replica' ? 45001 : null,
    status: 'ready',
    metadata: {},
    options: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('isAlreadyWritablePrimaryPromoteError matches engine wording only', () => {
  assertEquals(
    isAlreadyWritablePrimaryPromoteError(ALREADY_WRITABLE_PRIMARY_PROMOTE_ERROR_SAMPLE),
    true
  )
  assertEquals(isAlreadyWritablePrimaryPromoteError('Command timed out'), false)
  assertEquals(isAlreadyWritablePrimaryPromoteError(undefined), false)
})

test('buildSyntheticPromoteSuccessResult mirrors a promote payload', () => {
  assertEquals(
    buildSyntheticPromoteSuccessResult({
      managedId: MANAGED_ID,
      memberId: MEM_REPLICA,
      demoteMemberId: MEM_PRIMARY,
      resume: true,
    }),
    {
      status: 'ready',
      role: 'primary',
      promotedMemberId: MEM_REPLICA,
      demotedMemberId: MEM_PRIMARY,
      demoted: true,
      summary: 'standby already promoted to primary',
    }
  )
})

test('promoteResumeRequeueRefusal blocks recovery or target drift and stray primaries', () => {
  const record = recovery()
  const members = [member(MEM_PRIMARY, 'primary'), member(MEM_REPLICA, 'replica')]
  assertEquals(promoteResumeRequeueRefusal(record, members, record), null)
  assertEquals(promoteResumeRequeueRefusal(record, members, null), 'recovery_mismatch')
  assertEquals(
    promoteResumeRequeueRefusal(record, members, recovery({ targetMemberId: MEM_OTHER })),
    'target_mismatch'
  )
  assertEquals(
    promoteResumeRequeueRefusal(
      record,
      [
        member(MEM_PRIMARY, 'primary'),
        member(MEM_REPLICA, 'replica'),
        member(MEM_OTHER, 'primary'),
      ],
      record
    ),
    'stray_primary'
  )
})

test('isTargetAlreadyPrimaryInJournal is true only for the recovery target', () => {
  const record = recovery()
  assertEquals(
    isTargetAlreadyPrimaryInJournal(record, [
      member(MEM_PRIMARY, 'primary'),
      member(MEM_REPLICA, 'primary'),
    ]),
    true
  )
  assertEquals(
    isTargetAlreadyPrimaryInJournal(record, [
      member(MEM_PRIMARY, 'primary'),
      member(MEM_REPLICA, 'replica'),
    ]),
    false
  )
})
