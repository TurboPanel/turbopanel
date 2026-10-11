import { assertEquals } from '@std/assert'
import {
  engineNeedsSwitchoverGtidProof,
  failoverRecoverPayloadWithSwitchoverCatchup,
  fenceStopCapturesSwitchoverGtid,
  promotePayloadWithSwitchoverCatchup,
  recordSwitchoverRequiredGtid,
  switchoverAbortReactivateLifecyclePayload,
  switchoverGtidFromFenceStopResult,
  parseSwitchoverPromoteFailureCode,
  switchoverPromoteFailureShouldReactivateOldPrimary,
  switchoverPromoteTimedOutCommandError,
  SWITCHOVER_GTID_WAIT_SECONDS,
} from './switchover-catchup.ts'

const test = Deno.test.bind(Deno)

test('mysql-family switchover requires a GTID proof on the fence stop and promote', () => {
  assertEquals(engineNeedsSwitchoverGtidProof('mariadb'), true)
  assertEquals(engineNeedsSwitchoverGtidProof('mysql'), true)
  assertEquals(engineNeedsSwitchoverGtidProof('postgres'), false)
  assertEquals(fenceStopCapturesSwitchoverGtid('switchover', 'mariadb'), true)
  assertEquals(fenceStopCapturesSwitchoverGtid('automatic-failover', 'mariadb'), false)
})

test('promote payload carries the captured GTID and wait timeout', () => {
  const base = {
    managedId: '00000000-0000-4000-8000-000000000001',
    memberId: '00000000-0000-4000-8000-000000000002',
    demoteMemberId: '00000000-0000-4000-8000-000000000003',
    engine: 'mariadb' as const,
  }
  assertEquals(promotePayloadWithSwitchoverCatchup(base, {}), base)
  const withGtid = promotePayloadWithSwitchoverCatchup(
    base,
    recordSwitchoverRequiredGtid({}, '0-1-5000')
  )
  assertEquals(withGtid.requiredExecutedGtidSet, '0-1-5000')
  assertEquals(withGtid.gtidWaitTimeoutSeconds, SWITCHOVER_GTID_WAIT_SECONDS)
})

test('regression: acknowledged writes are not promoted without the old primary GTID', () => {
  // U04-style loss: gate passed on stale fullyApplied while the old primary still
  // held transactions the replica had not applied. Promote must not run without
  // the fence-captured position.
  const metadata = recordSwitchoverRequiredGtid({}, '0-3-85263')
  const payload = promotePayloadWithSwitchoverCatchup(
    {
      managedId: 'm',
      memberId: 't',
      demoteMemberId: 's',
      engine: 'mariadb',
    },
    metadata
  )
  assertEquals(payload.requiredExecutedGtidSet, '0-3-85263')
})

test('switchoverGtidFromFenceStopResult rejects empty or oversized values', () => {
  const base = { status: 'ok' }
  assertEquals(switchoverGtidFromFenceStopResult(base), null)
  assertEquals(
    switchoverGtidFromFenceStopResult({ ...base, switchoverPrimaryExecutedGtidSet: '' }),
    null
  )
  assertEquals(
    switchoverGtidFromFenceStopResult({
      ...base,
      switchoverPrimaryExecutedGtidSet: 'x'.repeat(4097),
    }),
    null
  )
  assertEquals(
    switchoverGtidFromFenceStopResult({ ...base, switchoverPrimaryExecutedGtidSet: '0-1-9' }),
    '0-1-9'
  )
})

test('parseSwitchoverPromoteFailureCode reads daemon promote failure codes', () => {
  assertEquals(parseSwitchoverPromoteFailureCode(undefined), null)
  assertEquals(
    parseSwitchoverPromoteFailureCode('switchover_promote:promote_started: writable check'),
    'promote_started'
  )
  assertEquals(
    parseSwitchoverPromoteFailureCode(
      'switchover_promote:gtid_wait_timeout: the promotion target did not apply the old primary GTID position within 90s'
    ),
    'gtid_wait_timeout'
  )
})

test('switchoverPromoteFailureShouldReactivateOldPrimary covers pre-writable failures only', () => {
  assertEquals(switchoverPromoteFailureShouldReactivateOldPrimary('gtid_wait_timeout'), true)
  assertEquals(switchoverPromoteFailureShouldReactivateOldPrimary('gtid_wait_error'), true)
  assertEquals(switchoverPromoteFailureShouldReactivateOldPrimary('promote_started'), false)
  assertEquals(switchoverPromoteFailureShouldReactivateOldPrimary(null), false)
})

test('switchoverPromoteTimedOutCommandError prefixes stale-sweep timeouts for the promote path', () => {
  assertEquals(
    switchoverPromoteTimedOutCommandError('command timed out'),
    'switchover_promote:gtid_wait_timeout: command timed out'
  )
})

test('failover recover payload and abort lifecycle carry switchover GTID fields', () => {
  const metadata = recordSwitchoverRequiredGtid({}, '0-2-100')
  const recover = failoverRecoverPayloadWithSwitchoverCatchup(
    {
      requiredExecutedGtidSet: undefined,
      gtidWaitTimeoutSeconds: undefined,
    },
    metadata
  )
  assertEquals(recover.requiredExecutedGtidSet, '0-2-100')
  assertEquals(
    switchoverAbortReactivateLifecyclePayload({
      managedId: 'm',
      memberId: 's',
      engine: 'mariadb',
    }).reactivateAfterSwitchoverAbort,
    true
  )
})
