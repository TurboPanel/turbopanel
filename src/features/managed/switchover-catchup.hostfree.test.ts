import { assertEquals } from '@std/assert'
import {
  engineNeedsSwitchoverGtidProof,
  fenceStopCapturesSwitchoverGtid,
  promotePayloadWithSwitchoverCatchup,
  recordSwitchoverRequiredGtid,
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
