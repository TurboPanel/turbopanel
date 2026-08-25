import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import { organization } from '../lib/db/schema.ts'
import {
  addressesFetchErrorStatus,
  extractAddresses,
  parseDisplayNameInput,
  parseOrganizationIdInput,
  parsePayloadBody,
  resolvePerServerLimit,
  UUID_RE,
} from './routes-core-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'

test('UUID_RE matches canonical lowercase UUIDs', () => {
  assertEquals(UUID_RE.test(ORG_ID), true)
  assertEquals(UUID_RE.test('not-a-uuid'), false)
})

test('parseDisplayNameInput trims and validates length', () => {
  assertEquals(parseDisplayNameInput(null), { ok: true, value: null })
  assertEquals(parseDisplayNameInput('  edge  '), { ok: true, value: 'edge' })
  assertEquals(parseDisplayNameInput(42), {
    ok: false,
    error: 'displayName must be a string or null',
  })
  assertEquals(parseDisplayNameInput('x'.repeat(256)), {
    ok: false,
    error: 'displayName must be at most 255 characters',
  })
  assertEquals(parseDisplayNameInput('bad\nname'), {
    ok: false,
    error: 'displayName must not contain control characters',
  })
  assertEquals(parseDisplayNameInput('Café 东京'), { ok: true, value: 'Café 东京' })
  assertEquals(parseDisplayNameInput(''), { ok: true, value: '' })
  assertEquals(parseDisplayNameInput('   '), { ok: true, value: '' })
})

test('parseOrganizationIdInput validates UUID and org existence', async () => {
  const missingDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db

  assertEquals(await parseOrganizationIdInput(missingDb, null), { ok: true, value: null })
  assertEquals(await parseOrganizationIdInput(missingDb, ORG_ID), {
    ok: false,
    error: 'Organization not found',
    status: 404,
  })
  assertEquals(await parseOrganizationIdInput(missingDb, 'bad-id'), {
    ok: false,
    error: 'organizationId must be a valid UUID',
    status: 400,
  })
  assertEquals(await parseOrganizationIdInput(missingDb, 1), {
    ok: false,
    error: 'organizationId must be a string or null',
    status: 400,
  })

  const foundDb = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== organization) throw new TypeError('unexpected table')
        return {
          where: () => ({
            limit: () => Promise.resolve([{ id: ORG_ID }]),
          }),
        }
      },
    }),
  } as unknown as Db
  assertEquals(await parseOrganizationIdInput(foundDb, ORG_ID), { ok: true, value: ORG_ID })
  assertEquals(
    await parseOrganizationIdInput(foundDb, `  ${ORG_ID}  `),
    { ok: true, value: ORG_ID },
  )
})

test('extractAddresses and addressesFetchErrorStatus mirror admin behavior', () => {
  const ips = [
    { address: '203.0.113.10', version: 4 as const, scope: 'public' as const },
  ]
  assertEquals(extractAddresses({ status: 'done', result: { ips } }), ips)
  assertEquals(addressesFetchErrorStatus('daemon not connected'), 404)
  assertEquals(addressesFetchErrorStatus('timeout waiting for addresses'), 500)
})

test('extractAddresses rejects expired, failed, and missing ips', () => {
  let expired: unknown
  try {
    extractAddresses({ status: 'expired' })
  } catch (err) {
    expired = err
  }
  if (!(expired instanceof Error)) throw new TypeError('expected Error')
  assertEquals(expired.message, 'timeout waiting for addresses')

  let failed: unknown
  try {
    extractAddresses({ status: 'failed' })
  } catch (err) {
    failed = err
  }
  if (!(failed instanceof Error)) throw new TypeError('expected Error')
  assertEquals(failed.message, 'failed to fetch addresses')

  let missing: unknown
  try {
    extractAddresses({ status: 'done', result: {} })
  } catch (err) {
    missing = err
  }
  if (!(missing instanceof Error)) throw new TypeError('expected Error')
  assertEquals(missing.message, 'missing ips in daemon response')
})

test('parsePayloadBody and resolvePerServerLimit', () => {
  assertEquals(parsePayloadBody({ payload: 'x' }), { ok: true, payload: 'x' })
  assertEquals(parsePayloadBody(undefined).ok, false)
  assertEquals(parsePayloadBody(null).ok, false)
  assertEquals(parsePayloadBody([]).ok, false)
  assertEquals(parsePayloadBody({}).ok, false)
  assertEquals(parsePayloadBody({ payload: undefined }), {
    ok: true,
    payload: undefined,
  })
  assertEquals(resolvePerServerLimit('25'), 25)
  assertEquals(resolvePerServerLimit(undefined), 50)
  assertEquals(resolvePerServerLimit(''), 0)
  assertEquals(resolvePerServerLimit('not-a-number'), 50)
  assertEquals(resolvePerServerLimit('0'), 0)
})
