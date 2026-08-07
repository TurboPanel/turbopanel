import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { mapGrantRows, revokeAccessGrant } from './access-grants.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mapGrantRows maps allow rows onto AccessRecord shape', () => {
  const mapped = mapGrantRows([
    {
      id: 'g1',
      entityType: 'organization',
      entityId: 'org-1',
      actorType: 'user',
      actorId: 'user-1',
      permission: 'organization:manage',
      allow: true,
    },
  ])

  assertEquals(mapped, [
    {
      id: 'g1',
      subjectKind: 'user',
      subjectId: 'user-1',
      resourceId: 'org-1',
      effect: 'allow',
      permissionKey: 'organization:manage',
    },
  ])
})

test('mapGrantRows excludes deny / non-allow rows', () => {
  const mapped = mapGrantRows([
    {
      id: 'allow-1',
      entityType: 'organization',
      entityId: 'org-1',
      actorType: 'team',
      actorId: 'team-1',
      permission: 'team:manage',
      allow: true,
    },
    {
      id: 'deny-1',
      entityType: 'organization',
      entityId: 'org-1',
      actorType: 'user',
      actorId: 'user-2',
      permission: 'organization:own',
      allow: false,
    },
  ])

  assertEquals(mapped.length, 1)
  assertEquals(mapped[0]?.id, 'allow-1')
  assertEquals(mapped[0]?.effect, 'allow')
})

test('mapGrantRows returns an empty list for empty input', () => {
  assertEquals(mapGrantRows([]), [])
})

test('mapGrantRows preserves subject kinds used by the access API', () => {
  const mapped = mapGrantRows([
    {
      id: 'g-org',
      entityType: 'organization',
      entityId: 'org-1',
      actorType: 'organization',
      actorId: 'org-1',
      permission: 'organization:own',
      allow: true,
    },
  ])

  if (mapped[0]?.subjectKind !== 'organization') {
    throw new TypeError('expected organization subjectKind')
  }
  assertEquals(mapped[0].subjectId, 'org-1')
  assertEquals(mapped[0].resourceId, 'org-1')
})

test('revokeAccessGrant returns true when a row is deleted', async () => {
  const deleted = await revokeAccessGrant(
    {
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: 'grant-1' }]),
        }),
      }),
    } as unknown as Db,
    'grant-1',
  )

  assertEquals(deleted, true)
})

test('revokeAccessGrant returns false when no row matches', async () => {
  const deleted = await revokeAccessGrant(
    {
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    } as unknown as Db,
    'missing-grant',
  )

  assertEquals(deleted, false)
})
