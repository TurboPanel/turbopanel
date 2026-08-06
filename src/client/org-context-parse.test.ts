import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import { ORG_ID_HEADER, parseOrgIdFromRequest } from './org-context.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const VALID_ORG = '00000000-0000-4000-8000-0000000000aa'

async function parseViaApp(
  path: string,
  headers?: HeadersInit,
): Promise<Response | string> {
  const app = new Hono()
  app.get('/probe', (c) => {
    const parsed = parseOrgIdFromRequest(c)
    if (parsed instanceof Response) return parsed
    return c.json({ organizationId: parsed })
  })
  return app.request(path, { headers })
}

test('parseOrgIdFromRequest requires organizationId', async () => {
  const response = await parseViaApp('/probe')
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 400)
    assertEquals(await response.json(), { error: 'organizationId required' })
  }
})

test('parseOrgIdFromRequest rejects non-UUID values', async () => {
  const response = await parseViaApp('/probe?organizationId=not-a-uuid')
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 400)
    assertEquals(await response.json(), { error: 'Invalid organizationId' })
  }
})

test('parseOrgIdFromRequest accepts header over query', async () => {
  const response = await parseViaApp(
    `/probe?organizationId=00000000-0000-4000-8000-0000000000bb`,
    { [ORG_ID_HEADER]: VALID_ORG },
  )
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 200)
    assertEquals(await response.json(), { organizationId: VALID_ORG })
  }
})

test('parseOrgIdFromRequest accepts query when header is absent', async () => {
  const response = await parseViaApp(`/probe?organizationId=${VALID_ORG}`)
  assertEquals(response instanceof Response, true)
  if (response instanceof Response) {
    assertEquals(response.status, 200)
    assertEquals(await response.json(), { organizationId: VALID_ORG })
  }
})
