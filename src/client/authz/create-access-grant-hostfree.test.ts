import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  createAccessGrant,
  resolveEntityOrganizationId,
  validateGrantEntityTarget,
  validatePermissionEntityCompatibility,
  verifyEntityExists,
} from './create-access-grant.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const neverCalledDb = new Proxy({} as Db, {
  get() {
    throw new TypeError('host-free validation tests must not touch the database')
  },
})

const validUuid = '11111111-1111-4111-8111-111111111111'
const otherUuid = '22222222-2222-4222-8222-222222222222'

function createExistsDb(exists: boolean): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(exists ? [{ id: validUuid }] : []),
        }),
      }),
    }),
  } as unknown as Db
}

function createOrganizationGrantDb(options: {
  insertReturnsId?: string | null
  existingGrantId?: string | null
}): Db {
  let selectCalls = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCalls++
            if (selectCalls === 1) {
              return Promise.resolve([{ id: validUuid }])
            }
            if (selectCalls === 2) {
              return Promise.resolve([{ id: otherUuid }])
            }
            if (options.existingGrantId) {
              return Promise.resolve([{ id: options.existingGrantId }])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve(options.insertReturnsId ? [{ id: options.insertReturnsId }] : []),
        }),
      }),
    }),
  } as unknown as Db
}

test('validatePermissionEntityCompatibility accepts compatible team grants', () => {
  const teamOwn = validatePermissionEntityCompatibility('team:own', 'team')
  if (!teamOwn.ok) {
    throw new TypeError('team:own on team should be allowed')
  }

  const teamManage = validatePermissionEntityCompatibility('team:manage', 'team')
  if (!teamManage.ok) {
    throw new TypeError('team:manage on team should be allowed')
  }
})

test('validateGrantEntityTarget rejects missing workspace rows', async () => {
  const missingWorkspaceDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db

  const result = await validateGrantEntityTarget(missingWorkspaceDb, 'workspace', validUuid)
  if (result.ok || result.status !== 404) {
    throw new TypeError('missing workspace should return 404')
  }
  assertEquals(result.error, 'Entity not found')
})

test('validateGrantEntityTarget rejects malformed ids without querying', async () => {
  const result = await validateGrantEntityTarget(neverCalledDb, 'organization', 'not-a-uuid')
  if (result.ok || result.status !== 404) {
    throw new TypeError('invalid uuid should return 404')
  }
  assertEquals(result.error, 'Entity not found')
})

test('createAccessGrant rejects non organization/team targets before database access', async () => {
  const result = await createAccessGrant(neverCalledDb, {
    entityType: 'workspace',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'organization:manage',
  })

  if (result.ok || result.status !== 400) {
    throw new TypeError('workspace entity type should return 400')
  }
  assertEquals(
    result.error,
    'Access grants may only target organization or team entities',
  )
})

test('createAccessGrant rejects invalid actor and entity ids before database access', async () => {
  const invalidEntity = await createAccessGrant(neverCalledDb, {
    entityType: 'organization',
    entityId: 'bad-id',
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'organization:manage',
  })
  if (invalidEntity.ok || invalidEntity.status !== 400) {
    throw new TypeError('invalid entity uuid should return 400')
  }
  assertEquals(invalidEntity.error, 'Invalid request')

  const invalidActor = await createAccessGrant(neverCalledDb, {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: 'bad-id',
    permissionKey: 'organization:manage',
  })
  if (invalidActor.ok || invalidActor.status !== 400) {
    throw new TypeError('invalid actor uuid should return 400')
  }
  assertEquals(invalidActor.error, 'Invalid request')
})

test('createAccessGrant rejects unknown permission keys before database access', async () => {
  const result = await createAccessGrant(neverCalledDb, {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'organization:read',
  })

  if (result.ok || result.status !== 400) {
    throw new TypeError('unknown permission key should return 400')
  }
  assertEquals(result.error, 'Invalid permission key')
})

test('verifyEntityExists returns false for unknown entity kinds', async () => {
  const exists = await verifyEntityExists(neverCalledDb, 'not-an-entity', validUuid)
  assertEquals(exists, false)
})

test('verifyEntityExists checks organization rows via select', async () => {
  assertEquals(await verifyEntityExists(createExistsDb(true), 'organization', validUuid), true)
  assertEquals(await verifyEntityExists(createExistsDb(false), 'organization', validUuid), false)
})

test('resolveEntityOrganizationId returns the organization id directly', async () => {
  const resolved = await resolveEntityOrganizationId(neverCalledDb, 'organization', validUuid)
  assertEquals(resolved, validUuid)
})

test('resolveEntityOrganizationId reads team organization_id from the database', async () => {
  const resolved = await resolveEntityOrganizationId(
    {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ organizationId: validUuid }]),
          }),
        }),
      }),
    } as unknown as Db,
    'team',
    otherUuid,
  )

  assertEquals(resolved, validUuid)
})

test('validateGrantEntityTarget accepts existing organization entities', async () => {
  const result = await validateGrantEntityTarget(createExistsDb(true), 'organization', validUuid)
  if (!result.ok) {
    throw new TypeError('organization entity should validate')
  }
  assertEquals(result.organizationId, validUuid)
})

test('createAccessGrant rejects incompatible permission and entity pairs', async () => {
  const result = await createAccessGrant(neverCalledDb, {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'team:own',
  })

  if (result.ok || result.status !== 400) {
    throw new TypeError('team permission on organization should return 400')
  }
})

test('createAccessGrant creates a new organization grant row', async () => {
  const result = await createAccessGrant(createOrganizationGrantDb({ insertReturnsId: 'grant-1' }), {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'organization:manage',
  })

  if (!result.ok || !result.created) {
    throw new TypeError('expected created organization grant')
  }
  assertEquals(result.ids, ['grant-1'])
})

test('createAccessGrant returns existing id on duplicate insert', async () => {
  const result = await createAccessGrant(
    createOrganizationGrantDb({ insertReturnsId: null, existingGrantId: 'grant-existing' }),
    {
      entityType: 'organization',
      entityId: validUuid,
      actorType: 'user',
      actorId: otherUuid,
      permissionKey: 'organization:own',
    },
  )

  if (!result.ok || result.created) {
    throw new TypeError('duplicate grant should reuse existing id')
  }
  assertEquals(result.ids, ['grant-existing'])
})

test('createAccessGrant returns conflict when duplicate insert finds no row', async () => {
  const result = await createAccessGrant(
    createOrganizationGrantDb({ insertReturnsId: null, existingGrantId: null }),
    {
      entityType: 'organization',
      entityId: validUuid,
      actorType: 'user',
      actorId: otherUuid,
      permissionKey: 'organization:manage',
    },
  )

  if (result.ok || result.status !== 409) {
    throw new TypeError('missing duplicate row should return 409 conflict')
  }
  assertEquals(result.error, 'Access grant conflict')
})

test('createAccessGrant rejects empty permission keys before database access', async () => {
  const result = await createAccessGrant(neverCalledDb, {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: '',
  })

  if (result.ok || result.status !== 400) {
    throw new TypeError('empty permission key should return 400')
  }
  assertEquals(result.error, 'Invalid permission key')
})

test('createAccessGrant inserts without allow column', async () => {
  const capturedKeys: string[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: validUuid }]),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        capturedKeys.push(...Object.keys(row))
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: 'grant-1' }]),
          }),
        }
      },
    }),
  } as unknown as Db

  const result = await createAccessGrant(db, {
    entityType: 'organization',
    entityId: validUuid,
    actorType: 'user',
    actorId: otherUuid,
    permissionKey: 'organization:manage',
  })

  if (!result.ok) {
    throw new TypeError('grant create should succeed')
  }
  assertEquals(capturedKeys.includes('allow'), false)
  assertEquals(capturedKeys.includes('permission'), true)
})

test('validatePermissionEntityCompatibility rejects org permissions on team entities', () => {
  const ownOnTeam = validatePermissionEntityCompatibility('organization:own', 'team')
  if (ownOnTeam.ok) {
    throw new TypeError('organization:own on team should be rejected')
  }
  assertEquals(ownOnTeam.error, 'organization:own may only be granted on organization entities')

  const manageOnTeam = validatePermissionEntityCompatibility('organization:manage', 'team')
  if (manageOnTeam.ok) {
    throw new TypeError('organization:manage on team should be rejected')
  }
  assertEquals(
    manageOnTeam.error,
    'organization:manage may only be granted on organization entities',
  )
})

test('validatePermissionEntityCompatibility rejects system permissions on team entities', () => {
  const result = validatePermissionEntityCompatibility('system:read', 'team')
  if (result.ok) {
    throw new TypeError('system:read on team should be rejected')
  }
  assertEquals(result.error, 'system:read may only be granted on organization entities')
})

test('validateGrantEntityTarget rejects non-grant entity kinds', async () => {
  const result = await validateGrantEntityTarget(createExistsDb(true), 'network', validUuid)
  if (result.ok || result.status !== 404) {
    throw new TypeError('network is not a grant entity type')
  }
  assertEquals(result.error, 'Entity not found')
})

test('validateGrantEntityTarget rejects invitation organization mismatches', async () => {
  const result = await validateGrantEntityTarget(
    createExistsDb(true),
    'organization',
    validUuid,
    otherUuid,
  )
  if (result.ok || result.status !== 400) {
    throw new TypeError('organization mismatch should return 400')
  }
  assertEquals(result.error, 'Entity must belong to the invitation organization')
})

test('validateGrantEntityTarget returns 404 when organization resolution fails', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: validUuid }]),
        }),
      }),
    }),
    execute: () => Promise.resolve([]),
  } as unknown as Db

  const result = await validateGrantEntityTarget(db, 'environment', validUuid)
  if (result.ok || result.status !== 404) {
    throw new TypeError('missing organization ancestry should return 404')
  }
  assertEquals(result.error, 'Entity not found')
})

test('verifyEntityExists checks every supported entity table via select', async () => {
  const selectEntityTypes = [
    'organization',
    'team',
    'workspace',
    'environment',
    'project',
    'service',
    'hosting',
    'container',
    'server',
    'tls',
    'managed',
    'variable',
    'principal',
    'storage',
    'network',
    'datacenter',
    'ip',
    'vpn',
    'peer',
  ] as const

  for (const entityType of selectEntityTypes) {
    assertEquals(await verifyEntityExists(createExistsDb(true), entityType, validUuid), true)
    assertEquals(await verifyEntityExists(createExistsDb(false), entityType, validUuid), false)
  }
})

test('resolveEntityOrganizationId resolves org ids for sql-backed entity types', async () => {
  const executeDb = {
    execute: () => Promise.resolve([{ organization_id: validUuid }]),
  } as unknown as Db

  for (const entityType of [
    'environment',
    'project',
    'service',
    'hosting',
    'container',
    'managed',
    'variable',
    'peer',
  ] as const) {
    const resolved = await resolveEntityOrganizationId(executeDb, entityType, otherUuid)
    assertEquals(resolved, validUuid)
  }
})

test('resolveEntityOrganizationId resolves org ids for select-backed entity types', async () => {
  const selectDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ organizationId: validUuid }]),
        }),
      }),
    }),
  } as unknown as Db

  for (const entityType of [
    'workspace',
    'server',
    'tls',
    'storage',
    'network',
    'datacenter',
    'ip',
    'vpn',
  ] as const) {
    const resolved = await resolveEntityOrganizationId(selectDb, entityType, otherUuid)
    assertEquals(resolved, validUuid)
  }
})

test('resolveEntityOrganizationId falls back to assignment lookup for principals', async () => {
  let executeCalls = 0
  const db = {
    execute: () => {
      executeCalls++
      if (executeCalls === 1) {
        return Promise.resolve([])
      }
      return Promise.resolve([{ organization_id: validUuid }])
    },
  } as unknown as Db

  const resolved = await resolveEntityOrganizationId(db, 'principal', otherUuid)
  assertEquals(resolved, validUuid)
})

test('resolveEntityOrganizationId returns null for unknown entity kinds', async () => {
  const resolved = await resolveEntityOrganizationId(neverCalledDb, 'not-an-entity', validUuid)
  assertEquals(resolved, null)
})

function createGrantFlowDb(options: {
  entityExists?: boolean
  userExists?: boolean
  team?: { exists: boolean; organizationId?: string }
  organizationActorExists?: boolean
  insertReturnsId?: string | null
}): Db {
  let selectCalls = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCalls++
            if (selectCalls === 1) {
              return Promise.resolve(
                options.entityExists === false ? [] : [{ id: validUuid }],
              )
            }
            if (selectCalls === 2) {
              if (options.userExists === false) {
                return Promise.resolve([])
              }
              return Promise.resolve([{ id: otherUuid }])
            }
            if (selectCalls === 3 && options.team) {
              if (!options.team.exists) {
                return Promise.resolve([])
              }
              return Promise.resolve([
                { id: otherUuid, organizationId: options.team.organizationId ?? validUuid },
              ])
            }
            if (options.organizationActorExists === false) {
              return Promise.resolve([])
            }
            return Promise.resolve([{ id: validUuid }])
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve(
              options.insertReturnsId ? [{ id: options.insertReturnsId }] : [],
            ),
        }),
      }),
    }),
  } as unknown as Db
}

test('createAccessGrant rejects missing user actors', async () => {
  const result = await createAccessGrant(
    createGrantFlowDb({ userExists: false }),
    {
      entityType: 'organization',
      entityId: validUuid,
      actorType: 'user',
      actorId: otherUuid,
      permissionKey: 'organization:manage',
    },
  )

  if (result.ok || result.status !== 404) {
    throw new TypeError('missing user actor should return 404')
  }
  assertEquals(result.error, 'User not found')
})

test('createAccessGrant rejects team actors from another organization', async () => {
  const result = await createAccessGrant(
    createGrantFlowDb({ team: { exists: true, organizationId: otherUuid } }),
    {
      entityType: 'organization',
      entityId: validUuid,
      actorType: 'team',
      actorId: otherUuid,
      permissionKey: 'organization:manage',
    },
  )

  if (result.ok || result.status !== 400) {
    throw new TypeError('cross-org team actor should return 400')
  }
  assertEquals(result.error, 'Team must belong to the same organization as the entity')
})

test('createAccessGrant rejects organization actors that do not match the entity org', async () => {
  const result = await createAccessGrant(
    createGrantFlowDb({ organizationActorExists: true }),
    {
      entityType: 'organization',
      entityId: validUuid,
      actorType: 'organization',
      actorId: otherUuid,
      permissionKey: 'organization:manage',
    },
  )

  if (result.ok || result.status !== 400) {
    throw new TypeError('organization actor mismatch should return 400')
  }
  assertEquals(result.error, 'Organization actor must match the entity organization')
})

test('createAccessGrant creates team grants when actors and entities align', async () => {
  let selectCalls = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCalls++
            if (selectCalls === 1) {
              return Promise.resolve([{ id: validUuid }])
            }
            if (selectCalls === 2) {
              return Promise.resolve([{ organizationId: validUuid }])
            }
            return Promise.resolve([{ id: otherUuid, organizationId: validUuid }])
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([{ id: 'team-grant-1' }]),
        }),
      }),
    }),
  } as unknown as Db

  const result = await createAccessGrant(db, {
    entityType: 'team',
    entityId: validUuid,
    actorType: 'team',
    actorId: otherUuid,
    permissionKey: 'team:manage',
  })

  if (!result.ok || !result.created) {
    throw new TypeError('expected created team grant')
  }
  assertEquals(result.ids, ['team-grant-1'])
})
