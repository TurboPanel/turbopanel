import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { ENTITY_TYPES } from './catalog.ts'
import {
  organizationExists,
  resolveEntityById,
  resolveEntityByKindAndItemId,
} from './entity-resolver.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const organizationId = '33333333-3333-4333-8333-333333333333'
const entityId = '44444444-4444-4444-8444-444444444444'
const teamId = '55555555-5555-4555-8555-555555555555'

function createOrganizationLookupDb(exists: boolean): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(exists ? [{ id: organizationId }] : []),
        }),
      }),
    }),
  } as unknown as Db
}

function createResolveByIdDb(targetType: string, targetOrganizationId: string): Db {
  const targetIndex = ENTITY_TYPES.indexOf(targetType as (typeof ENTITY_TYPES)[number])
  if (targetIndex < 0) {
    throw new TypeError(`unsupported entity type fixture: ${targetType}`)
  }

  let selectCalls = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCalls++
            if (selectCalls === targetIndex + 1) {
              return Promise.resolve([{ id: entityId }])
            }
            if (selectCalls === targetIndex + 2) {
              return Promise.resolve([{ organizationId: targetOrganizationId }])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
  } as unknown as Db
}

test('resolveEntityByKindAndItemId returns null for unsupported kinds', async () => {
  const resolved = await resolveEntityByKindAndItemId(
    createOrganizationLookupDb(true),
    'workspace',
    organizationId,
  )
  assertEquals(resolved, null)
})

test('resolveEntityByKindAndItemId resolves organization entities', async () => {
  const resolved = await resolveEntityByKindAndItemId(
    createOrganizationLookupDb(true),
    'organization',
    organizationId,
  )

  assertEquals(resolved, {
    entityType: 'organization',
    entityId: organizationId,
    organizationId,
  })
})

test('resolveEntityByKindAndItemId resolves team entities via organization lookup', async () => {
  const resolved = await resolveEntityByKindAndItemId(
    {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ organizationId }]),
          }),
        }),
      }),
    } as unknown as Db,
    'team',
    teamId,
  )

  assertEquals(resolved, {
    entityType: 'team',
    entityId: teamId,
    organizationId,
  })
})

test('resolveEntityByKindAndItemId returns null when organization lookup fails', async () => {
  const resolved = await resolveEntityByKindAndItemId(
    {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as unknown as Db,
    'team',
    teamId,
  )

  assertEquals(resolved, null)
})

test('resolveEntityById returns null when no entity rows match', async () => {
  const resolved = await resolveEntityById(createOrganizationLookupDb(false), entityId)
  assertEquals(resolved, null)
})

test('resolveEntityById resolves the first matching entity type', async () => {
  const resolved = await resolveEntityById(createResolveByIdDb('network', organizationId), entityId)

  assertEquals(resolved, {
    entityType: 'network',
    entityId,
    organizationId,
  })
})

test('organizationExists returns true when the organization row exists', async () => {
  const exists = await organizationExists(createOrganizationLookupDb(true), organizationId)
  assertEquals(exists, true)
})

test('organizationExists returns false when the organization row is missing', async () => {
  const exists = await organizationExists(createOrganizationLookupDb(false), organizationId)
  assertEquals(exists, false)
})
