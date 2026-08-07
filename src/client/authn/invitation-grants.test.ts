import { assertEquals } from '@std/assert'
import {
  defaultInvitationGrants,
  InvitationGrantValidationError,
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
  assertEquals(grants[0]?.allowed, true)
})

test('parseInvitationGrants accepts valid entries with allow alias', () => {
  const parsed = parseInvitationGrants([
    {
      entityType: 'organization',
      entityId: organizationId,
      permissionKey: 'organization:manage',
      allow: false,
    },
  ])
  assertEquals(parsed?.length, 1)
  assertEquals(parsed?.[0]?.allowed, false)
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
