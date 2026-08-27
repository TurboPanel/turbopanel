import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import { RESOURCE_KINDS } from './catalog.ts'
import { assertCan, can, ForbiddenError, getSubjects, listVisible } from './evaluator.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const organizationId = '11111111-1111-4111-8111-111111111111'
const teamId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'

function createCanDb(allowed: boolean): Db {
  return {
    execute: () => Promise.resolve([{ allowed }]),
  } as unknown as Db
}

function createListVisibleDb(itemIds: string[]): Db {
  return {
    execute: () => Promise.resolve(itemIds.map((item_id) => ({ item_id }))),
  } as unknown as Db
}

function createGetSubjectsDb(teamIds: string[], organizationIds: string[]): Db {
  const organizationId = organizationIds[0]
  const rows = teamIds.map((teamId) => ({ teamId, organizationId }))
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

test('ForbiddenError exposes the permission key', () => {
  const error = new ForbiddenError('organization:manage')
  assertEquals(error.name, 'ForbiddenError')
  assertEquals(error.permissionKey, 'organization:manage')
  assertEquals(error.message, 'Forbidden: organization:manage')
})

test('can rejects unknown entity types before evaluating grants', async () => {
  await assertRejects(
    () =>
      can(
        createCanDb(true),
        'user-1',
        'organization:manage',
        'unknown-kind',
        organizationId,
      ),
    Error,
    'Unknown entity type for ancestry: unknown-kind',
  )
})

test('can resolves allowed flag from mocked sql execution', async () => {
  const allowed = await can(
    createCanDb(true),
    'user-1',
    'organization:manage',
    'organization',
    organizationId,
  )

  assertEquals(allowed, true)

  const denied = await can(
    createCanDb(false),
    'user-1',
    'organization:manage',
    'organization',
    organizationId,
  )

  assertEquals(denied, false)
})

test('assertCan throws ForbiddenError when access is denied', async () => {
  await assertRejects(
    () =>
      assertCan(
        createCanDb(false),
        userId,
        'organization:own',
        'organization',
        organizationId,
      ),
    ForbiddenError,
    'Forbidden: organization:own',
  )
})

test('can honors pre-fetched subjects without querying teammate tables', async () => {
  const allowed = await can(
    createCanDb(true),
    userId,
    'organization:manage',
    'organization',
    organizationId,
    {
      subjects: [
        { subjectKind: 'user', subjectId: userId },
        { subjectKind: 'organization', subjectId: organizationId },
      ],
    },
  )

  assertEquals(allowed, true)
})

test('can evaluates team-scoped ownership checks', async () => {
  const allowed = await can(
    createCanDb(true),
    userId,
    'team:own',
    'team',
    teamId,
  )

  assertEquals(allowed, true)
})

test('can evaluates system permission keys with exact grant filters', async () => {
  const allowed = await can(
    createCanDb(true),
    userId,
    'system:read',
    'organization',
    organizationId,
  )

  assertEquals(allowed, true)
})

test('getSubjects merges user, team, and organization via teammate', async () => {
  const subjects = await getSubjects(
    createGetSubjectsDb([teamId], [organizationId]),
    userId,
  )

  assertEquals(subjects, [
    { subjectKind: 'user', subjectId: userId },
    { subjectKind: 'team', subjectId: teamId },
    { subjectKind: 'organization', subjectId: organizationId },
  ])
})

test('listVisible maps visible item ids for org-scoped resource kinds', async () => {
  const workspaceIds = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]

  const visible = await listVisible(createListVisibleDb(workspaceIds), {
    kind: 'workspace',
    userId,
    organizationId,
  })

  assertEquals(visible, workspaceIds)
})

test('listVisible supports server and network leaf queries', async () => {
  const serverId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const networkId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  const servers = await listVisible(createListVisibleDb([serverId]), {
    kind: 'server',
    userId,
    organizationId,
  })
  const networks = await listVisible(createListVisibleDb([networkId]), {
    kind: 'network',
    userId,
    organizationId,
  })

  assertEquals(servers, [serverId])
  assertEquals(networks, [networkId])
})

test('listVisible rejects unknown resource kinds', async () => {
  await assertRejects(
    () =>
      listVisible(createListVisibleDb([]), {
        kind: 'not-a-resource-kind',
        userId,
        organizationId,
      }),
    Error,
    'Unknown entity kind for visibility leaves: not-a-resource-kind',
  )
})

test('listVisible builds leaf queries for supported catalog resource kinds', async () => {
  const unsupportedInLeaves = new Set(['managed'])
  for (const kind of RESOURCE_KINDS) {
    if (unsupportedInLeaves.has(kind)) {
      continue
    }
    const visible = await listVisible(createListVisibleDb([]), {
      kind,
      userId,
      organizationId,
    })
    assertEquals(visible, [])
  }
})

test('listVisible maps source leaf ids', async () => {
  const sourceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const visible = await listVisible(createListVisibleDb([sourceId]), {
    kind: 'source',
    userId,
    organizationId,
  })
  assertEquals(visible, [sourceId])
})

test('listVisible rejects managed resources until leaf query exists', async () => {
  await assertRejects(
    () =>
      listVisible(createListVisibleDb([]), {
        kind: 'managed',
        userId,
        organizationId,
      }),
    Error,
    'Unknown entity kind for visibility leaves: managed',
  )
})

test('can builds ancestry queries for workspace-tree entity types', async () => {
  const entityTypes = [
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
    'source',
  ] as const

  for (const entityType of entityTypes) {
    const allowed = await can(
      createCanDb(false),
      userId,
      'organization:manage',
      entityType,
      organizationId,
    )
    assertEquals(allowed, false)
  }
})

test('can applies superadmin-only filter for system:manage checks', async () => {
  const allowed = await can(
    createCanDb(true),
    userId,
    'system:manage',
    'organization',
    organizationId,
  )

  assertEquals(allowed, true)
})
