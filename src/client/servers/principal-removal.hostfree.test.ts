import { assertEquals } from '@std/assert'
import {
  parsePrincipalRemovalChoices,
  PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR,
  type PrincipalRemovalPlanEntry,
  principalIdsToDelete,
  resolvePrincipalRemovalRefusals,
} from './principal-removal.ts'
import { emptyPrincipalUsage } from '../../features/principals/placement-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function entry(
  principalId: string,
  overrides: Partial<PrincipalRemovalPlanEntry> = {}
): PrincipalRemovalPlanEntry {
  const usedBy = overrides.usedBy ?? emptyPrincipalUsage()
  return {
    placementId: `placement-${principalId}`,
    principalId,
    username: principalId,
    appliedUsername: principalId,
    projectId: null,
    state: 'present',
    uid: null,
    gid: null,
    home: `/srv/users/${principalId}`,
    source: 'manual',
    defaultAction: 'keep',
    canDeleteOutright: Object.values(usedBy).every((count) => count === 0),
    usedBy,
    ...overrides,
  }
}

test('parsePrincipalRemovalChoices: absent means keep everything', () => {
  assertEquals(parsePrincipalRemovalChoices({}), [])
  assertEquals(parsePrincipalRemovalChoices({ forgetResources: true }), [])
})

test('parsePrincipalRemovalChoices accepts keep and delete, once per principal', () => {
  assertEquals(
    parsePrincipalRemovalChoices({
      principals: [
        { principalId: 'a', action: 'keep' },
        { principalId: 'b', action: 'delete' },
      ],
    }),
    [
      { principalId: 'a', action: 'keep' },
      { principalId: 'b', action: 'delete' },
    ]
  )
})

test('parsePrincipalRemovalChoices refuses malformed lists', () => {
  const invalid = { error: PRINCIPAL_REMOVAL_CHOICES_INVALID_ERROR }
  assertEquals(parsePrincipalRemovalChoices({ principals: 'a' }), invalid)
  assertEquals(parsePrincipalRemovalChoices({ principals: [null] }), invalid)
  assertEquals(parsePrincipalRemovalChoices({ principals: [{ principalId: 'a' }] }), invalid)
  assertEquals(
    parsePrincipalRemovalChoices({ principals: [{ principalId: 'a', action: 'purge' }] }),
    invalid
  )
  assertEquals(
    parsePrincipalRemovalChoices({
      principals: [
        { principalId: 'a', action: 'keep' },
        { principalId: 'a', action: 'delete' },
      ],
    }),
    invalid
  )
})

test('resolvePrincipalRemovalRefusals allows keep, refuses delete while used', () => {
  const inUse = { ...emptyPrincipalUsage(), tenancies: 1 }
  const plan = [entry('free'), entry('busy', { usedBy: inUse })]
  assertEquals(
    resolvePrincipalRemovalRefusals(plan, [
      { principalId: 'free', action: 'delete' },
      { principalId: 'busy', action: 'keep' },
    ]),
    []
  )
  assertEquals(resolvePrincipalRemovalRefusals(plan, [{ principalId: 'busy', action: 'delete' }]), [
    { principalId: 'busy', reason: 'in_use', usedBy: inUse },
  ])
})

test('resolvePrincipalRemovalRefusals names principals that are not on the server', () => {
  assertEquals(
    resolvePrincipalRemovalRefusals([entry('free')], [{ principalId: 'ghost', action: 'keep' }]),
    [{ principalId: 'ghost', reason: 'not_on_server' }]
  )
})

test('another placement elsewhere blocks outright delete', () => {
  const plan = [entry('shared', { usedBy: { ...emptyPrincipalUsage(), otherPlacements: 1 } })]
  assertEquals(
    resolvePrincipalRemovalRefusals(plan, [{ principalId: 'shared', action: 'delete' }]).map(
      (refusal) => refusal.reason
    ),
    ['in_use']
  )
})

test('principalIdsToDelete keeps only delete choices', () => {
  assertEquals(
    principalIdsToDelete([
      { principalId: 'a', action: 'keep' },
      { principalId: 'b', action: 'delete' },
    ]),
    ['b']
  )
})
