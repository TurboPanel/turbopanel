import { assertEquals, assertThrows } from '@std/assert'
import { Hono } from 'hono'
import { BadRequestError, parseName, requireStringField } from './request-fields.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseName returns null when name is omitted', () => {
  assertEquals(parseName({}), null)
})

test('parseName normalizes and validates display names', () => {
  assertEquals(parseName({ name: '  Acme Corp  ' }), 'Acme Corp')
  assertThrows(
    () => parseName({ name: 1 }),
    BadRequestError,
    'Invalid request',
  )
  assertThrows(
    () => parseName({ name: 'bad\nname' }),
    BadRequestError,
    'Invalid request',
  )
})

test('requireStringField returns value or 400 JSON response', async () => {
  const okApp = new Hono()
  okApp.post('/x', (c) => {
    const field = requireStringField(c, { token: 'abc' }, 'token')
    if (field instanceof Response) return field
    return c.json({ ok: true, token: field })
  })
  const ok = await okApp.request('http://instance/x', { method: 'POST' })
  assertEquals(ok.status, 200)
  assertEquals(await ok.json(), { ok: true, token: 'abc' })

  const badApp = new Hono()
  badApp.post('/y', (c) => {
    const field = requireStringField(c, { token: '' }, 'token')
    if (field instanceof Response) return field
    return c.json({ ok: true })
  })
  const bad = await badApp.request('http://instance/y', { method: 'POST' })
  assertEquals(bad.status, 400)
  assertEquals(await bad.json(), { error: 'Invalid request' })
})
