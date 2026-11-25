/**
 * Request parsing for the per-name certificate choice, without a database:
 * every refusal that is decided before a pin is looked up, and the check that
 * a choice names something the site serves.
 */
import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { parseNameChoices, unservedChoice } from './name-certificates-routes.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const ORG = '00000000-0000-4000-8000-000000000001'
const NO_DB = {} as unknown as Db

function ctx(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function refusal(body: Record<string, unknown>): Promise<[number, unknown]> {
  const result = await parseNameChoices(ctx(), NO_DB, ORG, body)
  if (result.kind !== 'error') throw new TypeError(`expected an error, got ${result.kind}`)
  return [result.response.status, await result.response.json()]
}

test('a body without names is absent', async () => {
  const result = await parseNameChoices(ctx(), NO_DB, ORG, {})
  assertEquals(result, { kind: 'absent' })
})

test('names that are not a list are refused', async () => {
  const [status, body] = await refusal({ names: 'a.example.com' })
  assertEquals(status, 400)
  assertEquals((body as { error: string }).error, 'invalid_name_certificates')
})

test('a list longer than the cap is refused', async () => {
  const names = Array.from({ length: 201 }, (_, i) => ({
    hostname: `n${i}.example.com`,
    certificate: 'self_signed',
  }))
  const [status] = await refusal({ names })
  assertEquals(status, 400)
})

test('an entry that is not an object is refused', async () => {
  for (const item of ['x', null, [], 5]) {
    const [status, body] = await refusal({ names: [item] })
    assertEquals(status, 400)
    assertEquals((body as { message: string }).message, 'each name choice must be an object')
  }
})

test('an entry without a hostname is refused', async () => {
  for (const hostname of [undefined, 3, '  ']) {
    const [status, body] = await refusal({ names: [{ hostname, certificate: 'self_signed' }] })
    assertEquals(status, 400)
    assertEquals((body as { message: string }).message, 'each name choice needs a hostname')
  }
})

test('an unknown certificate choice is refused and names the hostname', async () => {
  const [status, body] = await refusal({ names: [{ hostname: 'a.example.com', certificate: 'x' }] })
  assertEquals(status, 400)
  assertEquals((body as { message: string }).message, 'a.example.com: unknown certificate choice')
})

test('the same name twice is refused after normalising case', async () => {
  const [status, body] = await refusal({
    names: [
      { hostname: 'A.example.com', certificate: 'self_signed' },
      { hostname: 'a.EXAMPLE.com', certificate: 'self_signed' },
    ],
  })
  assertEquals(status, 400)
  assertEquals((body as { message: string }).message, 'a.example.com is listed twice')
})

test('a library choice with no certificate is refused', async () => {
  const [status, body] = await refusal({
    names: [{ hostname: 'a.example.com', certificate: 'library' }],
  })
  assertEquals(status, 400)
  assertEquals(
    (body as { message: string }).message,
    'a.example.com: pick a certificate from the library'
  )
})

test('a library choice with a null pin is refused too', async () => {
  const [status] = await refusal({
    names: [{ hostname: 'a.example.com', certificate: 'library', tlsId: null }],
  })
  assertEquals(status, 400)
})

test('choices without pins parse into a map keyed by the lower-case name', async () => {
  const result = await parseNameChoices(ctx(), NO_DB, ORG, {
    names: [
      { hostname: 'A.example.com', certificate: 'self_signed' },
      { hostname: 'b.example.com', certificate: 'letsencrypt_http' },
      { hostname: 'c.example.com', certificate: 'cloudflare_origin', tlsId: null },
    ],
  })
  if (result.kind !== 'value') throw new TypeError('expected a value')
  assertEquals(
    [...result.choices],
    [
      ['a.example.com', { certificate: 'self_signed', tlsId: null }],
      ['b.example.com', { certificate: 'letsencrypt_http', tlsId: null }],
      ['c.example.com', { certificate: 'cloudflare_origin', tlsId: null }],
    ]
  )
})

test('an empty list parses to no choices', async () => {
  const result = await parseNameChoices(ctx(), NO_DB, ORG, { names: [] })
  if (result.kind !== 'value') throw new TypeError('expected a value')
  assertEquals(result.choices.size, 0)
})

test('a choice for a name the site does not serve is refused', async () => {
  const choices = new Map([
    ['other.example.com', { certificate: 'self_signed' as const, tlsId: null }],
  ])
  const response = unservedChoice(ctx(), choices, ['a.example.com'], 'off')
  assertEquals(response?.status, 400)
  assertEquals(await response?.json(), {
    error: 'name_not_served',
    message: "other.example.com is not one of this site's names",
  })
})

test('typed names and the www partner are served names', () => {
  const choices = new Map([
    ['a.example.com', { certificate: 'self_signed' as const, tlsId: null }],
    ['www.a.example.com', { certificate: 'self_signed' as const, tlsId: null }],
  ])
  assertEquals(unservedChoice(ctx(), choices, ['a.example.com'], 'both'), null)
  const unserved = unservedChoice(ctx(), choices, ['a.example.com'], 'off')
  assertEquals(unserved?.status, 400)
})
