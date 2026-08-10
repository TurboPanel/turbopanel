/**
 * Host-free coverage for hosting route pure helpers (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import {
  assertCreateHostingBindScope,
  assertHostingPublicBindScope,
  assertMergedHostingBindScope,
  buildHostingPatchFields,
  isHostingUuid,
  parseCreateServiceId,
  parseOptionalHostingOptions,
  parseOptionalIpId,
  parseOptionalTlsId,
  resolveOptionalHostingFks,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '00000000-0000-4000-8000-000000000001'
const TLS = '00000000-0000-4000-8000-000000000010'
const IP = '00000000-0000-4000-8000-000000000011'

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectErrorResponse(
  response: unknown,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, status)
  assertEquals(await response.json(), body)
}

function entityOrgDb(
  responses: Array<string | null | '__ip_scope__' | '__ip_public__'>,
): Db {
  let i = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const token = responses[i] ?? null
            i += 1
            if (token === '__ip_scope__') {
              return Promise.resolve([{ scope: 'datacenter' }])
            }
            if (token === '__ip_public__') {
              return Promise.resolve([{ scope: 'public' }])
            }
            if (token) {
              return Promise.resolve([{ organizationId: token }])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
  } as unknown as Db
}

test('isHostingUuid accepts canonical lowercase UUIDs only', () => {
  assertEquals(isHostingUuid(TLS), true)
  assertEquals(isHostingUuid('not-a-uuid'), false)
  assertEquals(isHostingUuid(null), false)
})

test('parseCreateServiceId trims and rejects empty values', () => {
  assertEquals(parseCreateServiceId({ serviceId: '  svc-1  ' }), 'svc-1')
  assertEquals(parseCreateServiceId({ serviceId: '' }), null)
  assertEquals(parseCreateServiceId({ serviceId: '   ' }), null)
  assertEquals(parseCreateServiceId({}), null)
})

test('parseOptionalTlsId handles absent, null, invalid, and foreign org', async () => {
  const c = mockContext()
  assertEquals(await parseOptionalTlsId(c, entityOrgDb([]), ORG, undefined), {
    kind: 'absent',
  })
  assertEquals(await parseOptionalTlsId(c, entityOrgDb([]), ORG, null), {
    kind: 'value',
    value: null,
  })
  const invalid = await parseOptionalTlsId(c, entityOrgDb([]), ORG, 'bad')
  if (invalid.kind !== 'error') throw new TypeError('expected tls error')
  await expectErrorResponse(invalid.response, 400, { error: 'Invalid request' })

  const foreign = await parseOptionalTlsId(
    c,
    entityOrgDb(['other-org']),
    ORG,
    TLS,
  )
  if (foreign.kind !== 'error') throw new TypeError('expected tls not found')
  await expectErrorResponse(foreign.response, 404, { error: 'Not found' })

  const ok = await parseOptionalTlsId(c, entityOrgDb([ORG]), ORG, TLS)
  assertEquals(ok, { kind: 'value', value: TLS })
})

test('parseOptionalIpId mirrors tls validation semantics', async () => {
  const c = mockContext()
  const invalid = await parseOptionalIpId(c, entityOrgDb([]), ORG, 99)
  if (invalid.kind !== 'error') throw new TypeError('expected ip error')
  await expectErrorResponse(invalid.response, 400, { error: 'Invalid request' })

  const ok = await parseOptionalIpId(c, entityOrgDb([ORG]), ORG, IP)
  assertEquals(ok, { kind: 'value', value: IP })
})

test('parseOptionalHostingOptions rejects non-object options payloads', async () => {
  const c = mockContext()
  assertEquals(parseOptionalHostingOptions(c, {}), { kind: 'absent' })
  const invalid = parseOptionalHostingOptions(c, { options: [] })
  if (invalid.kind !== 'error') throw new TypeError('expected options error')
  await expectErrorResponse(invalid.response, 400, { error: 'Invalid request' })

  const ok = parseOptionalHostingOptions(c, {
    options: { bind: 'public', hostnames: ['app.example.test'] },
  })
  if (ok.kind !== 'value') throw new TypeError('expected parsed hosting options')
  assertEquals(ok.value.bind, 'public')
})

test('assertHostingPublicBindScope rejects non-public IP when bind is public', async () => {
  const c = mockContext()
  const denied = await assertHostingPublicBindScope(
    c,
    entityOrgDb(['__ip_scope__']),
    IP,
    { bind: 'public' },
  )
  await expectErrorResponse(denied, 400, { error: 'hosting_bind_scope_mismatch' })

  const allowed = await assertHostingPublicBindScope(
    c,
    entityOrgDb(['__ip_public__']),
    IP,
    { bind: 'public' },
  )
  assertEquals(allowed, null)
})

test('assertCreateHostingBindScope skips absent ipId', async () => {
  const c = mockContext()
  assertEquals(
    await assertCreateHostingBindScope(c, entityOrgDb([]), { kind: 'absent' }, null),
    null,
  )
})

test('assertMergedHostingBindScope merges patch ipId and options', async () => {
  const c = mockContext()
  const denied = await assertMergedHostingBindScope(
    c,
    entityOrgDb(['__ip_scope__']),
    { ipId: null, options: { bind: 'datacenter' } },
    { ipId: IP, options: { bind: 'public' } },
  )
  await expectErrorResponse(denied, 400, { error: 'hosting_bind_scope_mismatch' })
})

test('resolveOptionalHostingFks returns ok when both FKs absent', async () => {
  const c = mockContext()
  const fks = await resolveOptionalHostingFks(c, entityOrgDb([]), ORG, {})
  assertEquals(fks, {
    kind: 'ok',
    tlsId: { kind: 'absent' },
    ipId: { kind: 'absent' },
  })
})

test('buildHostingPatchFields rejects invalid patch names', async () => {
  const c = mockContext()
  const bad = await buildHostingPatchFields(c, entityOrgDb([]), ORG, {
    name: 42,
  })
  await expectErrorResponse(bad, 400, { error: 'Invalid request' })
})
