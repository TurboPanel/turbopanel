import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertIpScopeFkRules,
  applyJsonbPatchFields,
  isIpAddressUniqueViolation,
  mergeIpScopeFks,
  parseCreateIpAddress,
  parseCreateIpEnums,
  parseEnumQueryFilter,
  parseScopeFkUuid,
  rejectImmutableIpPatchFields,
  serializeIpRow,
} from './ip-create-validation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(query: Record<string, string> = {}): Context<AppEnv> {
  return {
    req: {
      query(key: string) {
        return query[key]
      },
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectInvalidRequest(response: Response | { address: string }): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected invalid request response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Invalid request' })
}

test('isIpAddressUniqueViolation matches the org address index', () => {
  const orgErr = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_ip_org_address"'),
    { code: '23505' },
  )
  const otherErr = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_ip_vpn_address"'),
    { code: '23505' },
  )
  assertEquals(isIpAddressUniqueViolation(orgErr), true)
  assertEquals(isIpAddressUniqueViolation(otherErr), false)
  assertEquals(isIpAddressUniqueViolation({ code: '23505', message: 'other' }), false)
})

test('parseCreateIpAddress rejects client-supplied version and invalid addresses', async () => {
  const c = mockContext()

  await expectInvalidRequest(parseCreateIpAddress(c, { address: '203.0.113.10', version: 4 }))
  await expectInvalidRequest(parseCreateIpAddress(c, { address: 'not-an-ip' }))

  const parsed = parseCreateIpAddress(c, { address: ' 203.0.113.10 ' })
  if (parsed instanceof Response) {
    throw new TypeError('expected parsed IP address')
  }
  assertEquals(parsed.address, '203.0.113.10')
})

test('assertIpScopeFkRules enforces free-pool and datacenter-anchor rules', async () => {
  const c = mockContext()

  await expectInvalidRequest(assertIpScopeFkRules(c, 'datacenter', {
    datacenterId: 'dc-1',
    serverId: 'srv-1',
  }))
  await expectInvalidRequest(assertIpScopeFkRules(c, 'datacenter', {}))
  assertEquals(assertIpScopeFkRules(c, 'datacenter', { datacenterId: 'dc-1' }), null)
  assertEquals(assertIpScopeFkRules(c, 'datacenter', { serverId: 'srv-1' }), null)
  assertEquals(assertIpScopeFkRules(c, 'public', {}), null)
})

test('serializeIpRow derives version from address', () => {
  const row = {
    id: 'ip-1',
    organizationId: 'org-1',
    datacenterId: null,
    networkId: null,
    serverId: null,
    address: '203.0.113.10',
    allocation: 'dedicated',
    scope: 'public',
    displayName: null,
    metadata: null,
    options: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  }
  assertEquals(serializeIpRow(row).version, 4)
})

test('parseCreateIpEnums validates allocation and scope', async () => {
  const c = mockContext()
  assertEquals(
    parseCreateIpEnums(c, { allocation: 'shared', scope: 'public' }),
    { allocation: 'shared', scope: 'public' },
  )
  const badAllocation = parseCreateIpEnums(c, { allocation: 'pool', scope: 'public' })
  if (!(badAllocation instanceof Response)) throw new TypeError('expected response')
  assertEquals(badAllocation.status, 400)
  const badScope = parseCreateIpEnums(c, { allocation: 'dedicated', scope: 'vpn' })
  if (!(badScope instanceof Response)) throw new TypeError('expected response')
  assertEquals(badScope.status, 400)
})

test('rejectImmutableIpPatchFields blocks address and scope mutations', async () => {
  const c = mockContext()
  assertEquals(rejectImmutableIpPatchFields(c, {}), null)
  const denied = rejectImmutableIpPatchFields(c, { address: '203.0.113.11' })
  if (!(denied instanceof Response)) throw new TypeError('expected response')
  assertEquals(denied.status, 400)
})

test('mergeIpScopeFks preserves existing FKs when patch omits them', () => {
  const existing = {
    scope: 'public',
    serverId: null,
    datacenterId: null,
    networkId: null,
    address: '203.0.113.5',
  }
  assertEquals(
    mergeIpScopeFks(existing, { serverId: 'srv-2' }),
    { serverId: 'srv-2', datacenterId: null, networkId: null },
  )
})

test('parseEnumQueryFilter and parseScopeFkUuid validate query and body UUIDs', async () => {
  const c = mockContext({ scope: 'public', allocation: 'dedicated' })
  assertEquals(parseEnumQueryFilter(c, 'scope', new Set(['public', 'datacenter'])), 'public')
  const badScope = parseEnumQueryFilter(mockContext({ scope: 'loopback' }), 'scope', new Set(['public']))
  if (!(badScope instanceof Response)) throw new TypeError('expected response')
  assertEquals(badScope.status, 400)

  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseScopeFkUuid(valid), { ok: true, value: valid })
  assertEquals(parseScopeFkUuid(undefined), { ok: true, value: undefined })
  assertEquals(parseScopeFkUuid(null), { ok: true, value: null })
  assertEquals(parseScopeFkUuid('bad'), { ok: false })
})

test('applyJsonbPatchFields merges metadata and options on IP patch', async () => {
  const c = mockContext()
  const patchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }
  assertEquals(applyJsonbPatchFields(c, { metadata: { tag: 'edge' } }, patchFields), null)
  assertEquals(patchFields.metadata, { tag: 'edge' })
})
