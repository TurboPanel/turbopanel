import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  defaultInvitationGrants,
  InvitationGrantValidationError,
  materializeInvitationGrants,
  parseInvitationGrants,
  resolveInvitationGrants,
} from './invitation-grants.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const organizationId = '00000000-0000-4000-8000-000000000001'

test('defaultInvitationGrants grants organization:manage on the org', () => {
  const grants = defaultInvitationGrants(organizationId)
  assertEquals(grants.length, 1)
  assertEquals(grants[0]?.entityType, 'organization')
  assertEquals(grants[0]?.entityId, organizationId)
  assertEquals(grants[0]?.permissionKey, 'organization:manage')
})

test('parseInvitationGrants accepts valid entries without allow fields', () => {
  const parsed = parseInvitationGrants([
    {
      entityType: 'organization',
      entityId: organizationId,
      permissionKey: 'organization:manage',
    },
  ])
  assertEquals(parsed?.length, 1)
  assertEquals(parsed?.[0]?.permissionKey, 'organization:manage')
})

test('parseInvitationGrants rejects allowed and allow fields', () => {
  assertEquals(
    parseInvitationGrants([
      {
        entityType: 'organization',
        entityId: organizationId,
        permissionKey: 'organization:manage',
        allow: true,
      },
    ]),
    null,
  )
  assertEquals(
    parseInvitationGrants([
      {
        entityType: 'organization',
        entityId: organizationId,
        permissionKey: 'organization:manage',
        allowed: false,
      },
    ]),
    null,
  )
})

test('parseInvitationGrants rejects invalid shapes', () => {
  assertEquals(parseInvitationGrants(null), null)
  assertEquals(parseInvitationGrants({}), null)
  assertEquals(parseInvitationGrants([]), null)
  assertEquals(
    parseInvitationGrants([{ entityType: 'organization', entityId: organizationId }]),
    null,
  )
  assertEquals(
    parseInvitationGrants([
      {
        entityType: 'organization',
        entityId: organizationId,
        permissionKey: 'not-a-permission',
      },
    ]),
    null,
  )
  assertEquals(
    parseInvitationGrants([
      {
        entityType: 'organization',
        entityId: organizationId,
        permissionKey: 'organization:manage',
        allowed: 'yes',
      },
    ]),
    null,
  )
})

test('resolveInvitationGrants falls back to defaults when raw is invalid', () => {
  const grants = resolveInvitationGrants(undefined, organizationId)
  assertEquals(grants, defaultInvitationGrants(organizationId))
})

test('InvitationGrantValidationError carries the HTTP status', () => {
  const err = new InvitationGrantValidationError('Entity not found', 404)
  assertEquals(err.name, 'InvitationGrantValidationError')
  assertEquals(err.status, 404)
  assertEquals(err.message, 'Entity not found')
})

test('parseInvitationGrants rejects entries with empty entityId', () => {
  assertEquals(
    parseInvitationGrants([
      {
        entityType: 'organization',
        entityId: '',
        permissionKey: 'organization:manage',
      },
    ]),
    null,
  )
})

function mockGrantDb(orgExists: boolean): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(orgExists ? [{ id: 'org-row' }] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        return {
          onConflictDoNothing: () => Promise.resolve(undefined),
          _row: row,
        }
      },
    }),
  } as unknown as Db
}

test('materializeInvitationGrants inserts validated grant rows', async () => {
  const inserts: unknown[] = []
  const orgId = '00000000-0000-4000-8000-000000000001'
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: orgId }]),
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        inserts.push(row)
        return {
          onConflictDoNothing: () => Promise.resolve(undefined),
        }
      },
    }),
  } as unknown as Db

  await materializeInvitationGrants(db, 'user-1', defaultInvitationGrants(orgId), orgId)
  assertEquals(inserts.length, 1)
  assertEquals((inserts[0] as { permission: string }).permission, 'organization:manage')
})

test('materializeInvitationGrants rejects incompatible permission keys', async () => {
  const orgId = '00000000-0000-4000-8000-000000000001'
  const db = mockGrantDb(true)
  await assertRejects(
    () =>
      materializeInvitationGrants(
        db,
        'user-1',
        [{ entityType: 'organization', entityId: orgId, permissionKey: 'team:own' }],
        orgId,
      ),
    InvitationGrantValidationError,
  )
})
