/**
 * Host-free coverage for access route pure validation helpers.
 */

import { assertEquals } from '@std/assert'
import {
  isUuid,
  invitationAcceptErrorPayload,
  invitationEmailsMatch,
  organizationResourceIdMismatch,
  ownerRemovalConflictMessage,
  parseCreateAccessBody,
  validateAccessCheckQuery,
  validateAccessListQuery,
  validateAccessResourceIdQuery,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const validUuid = '11111111-1111-4111-8111-111111111111'
const otherUuid = '22222222-2222-4222-8222-222222222222'

test('isUuid accepts mixed case and rejects malformed values', () => {
  assertEquals(isUuid('ABCDEF12-3456-789A-BCDE-F0123456789A'), true)
  assertEquals(isUuid(''), false)
  assertEquals(isUuid('11111111-1111-4111-8111'), false)
  assertEquals(isUuid('11111111-1111-4111-8111-11111111111g'), false)
})

test('ownerRemovalConflictMessage ignores non-errors and unknown messages', () => {
  assertEquals(ownerRemovalConflictMessage(null), null)
  assertEquals(ownerRemovalConflictMessage(undefined), null)
  assertEquals(ownerRemovalConflictMessage({ message: 'x' }), null)
  assertEquals(ownerRemovalConflictMessage(new Error('other conflict')), null)
})

test('parseCreateAccessBody rejects invalid shapes and deny effect', () => {
  const nullBody = parseCreateAccessBody(null)
  if (!('ok' in nullBody) || nullBody.ok !== false) {
    throw new TypeError('expected null body rejection')
  }

  const arrayBody = parseCreateAccessBody([])
  if (!('ok' in arrayBody) || arrayBody.ok !== false) {
    throw new TypeError('expected array body rejection')
  }

  const badKind = parseCreateAccessBody({ subjectKind: 'group' })
  if (!('ok' in badKind) || badKind.ok !== false) {
    throw new TypeError('expected invalid subjectKind rejection')
  }

  const badSubjectId = parseCreateAccessBody({
    subjectKind: 'user',
    subjectId: 1,
    resourceId: validUuid,
    permissionKey: 'organization:manage',
  })
  if (!('ok' in badSubjectId) || badSubjectId.ok !== false) {
    throw new TypeError('expected non-string subjectId rejection')
  }

  const deny = parseCreateAccessBody({
    subjectKind: 'user',
    subjectId: validUuid,
    resourceId: validUuid,
    effect: 'deny',
    permissionKey: 'organization:manage',
  })
  if (!('ok' in deny) || deny.ok !== false) {
    throw new TypeError('expected deny effect rejection')
  }

  assertEquals(
    parseCreateAccessBody({
      subjectKind: 'user',
      subjectId: validUuid,
      resourceId: validUuid,
      permissionKey: 'not-a-permission',
    }),
    { ok: false, error: 'permissionKey is required', status: 400 },
  )

  const badUuid = parseCreateAccessBody({
    subjectKind: 'user',
    subjectId: 'not-a-uuid',
    resourceId: validUuid,
    permissionKey: 'organization:manage',
  })
  if (!('ok' in badUuid) || badUuid.ok !== false) {
    throw new TypeError('expected invalid uuid rejection')
  }
})

test('parseCreateAccessBody accepts allow-only grants for all subject kinds', () => {
  for (const subjectKind of ['user', 'team', 'organization'] as const) {
    const parsed = parseCreateAccessBody({
      subjectKind,
      subjectId: validUuid,
      resourceId: otherUuid,
      permissionKey: 'team:manage',
    })
    if ('ok' in parsed) {
      throw new TypeError(`expected valid ${subjectKind} grant body`)
    }
    assertEquals(parsed.subjectKind, subjectKind)
    assertEquals(parsed.permissionKey, 'team:manage')
  }

  const memberKind = parseCreateAccessBody({
    subjectKind: 'member',
    subjectId: validUuid,
    resourceId: otherUuid,
    permissionKey: 'organization:manage',
  })
  if (!('ok' in memberKind) || memberKind.ok !== false) {
    throw new TypeError('expected member subjectKind rejection')
  }

  const omittedEffect = parseCreateAccessBody({
    subjectKind: 'user',
    subjectId: validUuid,
    resourceId: otherUuid,
    permissionKey: 'organization:own',
  })
  if ('ok' in omittedEffect) {
    throw new TypeError('expected valid body when effect is omitted')
  }
  assertEquals(omittedEffect.subjectId, validUuid)
})

test('validateAccessCheckQuery requires params and valid catalog keys', () => {
  assertEquals(
    validateAccessCheckQuery(undefined, 'organization:manage'),
    {
      ok: false,
      error: 'resourceId and permissionKey query parameters are required',
      status: 400,
    },
  )
  assertEquals(
    validateAccessCheckQuery(validUuid, undefined),
    {
      ok: false,
      error: 'resourceId and permissionKey query parameters are required',
      status: 400,
    },
  )
  assertEquals(
    validateAccessCheckQuery('bad-id', 'organization:manage'),
    { ok: false, error: 'Invalid resourceId', status: 400 },
  )
  assertEquals(
    validateAccessCheckQuery(validUuid, 'organization:delete'),
    { ok: false, error: 'Invalid permissionKey', status: 400 },
  )

  const ok = validateAccessCheckQuery(validUuid, 'team:own')
  if (!ok.ok) {
    throw new TypeError('expected valid access/check query')
  }
  assertEquals(ok.resourceId, validUuid)
  assertEquals(ok.permissionKey, 'team:own')
})

test('validateAccessListQuery requires a UUID resourceId', () => {
  assertEquals(
    validateAccessListQuery(undefined),
    {
      ok: false,
      error: 'resourceId query parameter is required',
      status: 400,
    },
  )
  assertEquals(
    validateAccessListQuery(''),
    {
      ok: false,
      error: 'resourceId query parameter is required',
      status: 400,
    },
  )
  assertEquals(
    validateAccessListQuery('not-a-uuid'),
    { ok: false, error: 'Invalid resourceId', status: 400 },
  )

  const ok = validateAccessListQuery(validUuid)
  if (!ok.ok) {
    throw new TypeError('expected valid access list query')
  }
  assertEquals(ok.resourceId, validUuid)
})

test('validateAccessResourceIdQuery requires kind and itemId', () => {
  assertEquals(
    validateAccessResourceIdQuery(undefined, validUuid),
    {
      ok: false,
      error: 'kind and itemId query parameters are required',
      status: 400,
    },
  )
  assertEquals(
    validateAccessResourceIdQuery('organization', undefined),
    {
      ok: false,
      error: 'kind and itemId query parameters are required',
      status: 400,
    },
  )

  const ok = validateAccessResourceIdQuery('team', otherUuid)
  if (!ok.ok) {
    throw new TypeError('expected valid resource-id query')
  }
  assertEquals(ok.kind, 'team')
  assertEquals(ok.itemId, otherUuid)
})

test('invitationEmailsMatch is case and whitespace insensitive', () => {
  assertEquals(
    invitationEmailsMatch('User@Example.com', ' user@example.com '),
    true,
  )
  assertEquals(invitationEmailsMatch('a@b.co', 'c@d.co'), false)
})

test('invitationAcceptErrorPayload maps gone and invalid_grant', () => {
  assertEquals(invitationAcceptErrorPayload('invalid_grant'), {
    body: { error: 'Invalid invitation grants' },
    status: 400,
  })
  assertEquals(invitationAcceptErrorPayload('gone'), {
    body: { error: 'Invitation expired or already used' },
    status: 410,
  })
})

test('organizationResourceIdMismatch only flags organization kind drift', () => {
  assertEquals(
    organizationResourceIdMismatch('organization', validUuid, otherUuid),
    true,
  )
  assertEquals(
    organizationResourceIdMismatch('organization', validUuid, validUuid),
    false,
  )
  assertEquals(
    organizationResourceIdMismatch('team', otherUuid, validUuid),
    false,
  )
})
