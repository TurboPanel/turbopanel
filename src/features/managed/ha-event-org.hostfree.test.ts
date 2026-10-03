/**
 * The reporter/cluster organization check against an in-memory DB that
 * evaluates the real join predicates (managed → environment → project), with
 * two organizations whose rows would be confused by a join that ignored them.
 */

import { assertEquals } from '@std/assert'
import { environment, ip, managed, project, recovery, replica, server } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { handleManagedHaEvent } from './ha-event.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'
const MANAGED_ID = '00000000-0000-4000-8000-0000000000c1'
const SERVER_A = '00000000-0000-4000-8000-0000000000a1'
const SERVER_B = '00000000-0000-4000-8000-0000000000b1'

function seed(primaryServerId: string) {
  return createMemoryDb([
    // Org B's environment/project come FIRST: a join that ignored its
    // predicate would resolve the cluster to org B.
    [
      environment,
      [
        { id: 'env-b', projectId: 'proj-b' },
        { id: 'env-a', projectId: 'proj-a' },
      ],
    ],
    [
      project,
      [
        { id: 'proj-b', organizationId: ORG_B },
        { id: 'proj-a', organizationId: ORG_A },
      ],
    ],
    [managed, [{ id: MANAGED_ID, environmentId: 'env-a', engine: 'mysql' }]],
    [
      server,
      [
        { id: SERVER_A, organizationId: ORG_A },
        { id: SERVER_B, organizationId: ORG_B },
      ],
    ],
    [
      replica,
      [
        {
          id: 'mem-primary',
          managedId: MANAGED_ID,
          serverId: primaryServerId,
          role: 'primary',
          replicaClass: null,
          isReadEligible: true,
          ordinal: 1,
        },
      ],
    ],
    [recovery, []],
    [ip, []],
  ])
}

test('an org-B server hosting a member of an org-A cluster is rejected on the join itself', async () => {
  const db = seed(SERVER_B)
  const result = await handleManagedHaEvent(
    db,
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_B }
  )
  assertEquals(result, null)
  assertEquals(db.rows(recovery).length, 0)
})

test('the same event from an org-A member server passes the gate (control)', async () => {
  const db = seed(SERVER_A)
  await handleManagedHaEvent(
    db,
    { managedId: MANAGED_ID },
    {
      reporterServerId: SERVER_A,
      binding: { reporterBindsInstance: async () => false, primaryDial: async () => null },
    }
  )
  // Past the gate the failover path runs: with a lone primary and no queue it
  // records a terminal blocked row.
  assertEquals(db.rows(recovery).length, 1)
  assertEquals(db.rows(recovery)[0]?.state, 'blocked')
})
