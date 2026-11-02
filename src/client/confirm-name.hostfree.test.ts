import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import {
  CONFIRM_NAME_REQUIRED_ERROR,
  confirmNameMatches,
  confirmNameMessage,
  confirmationName,
  refuseUnlessNameConfirmed,
} from './confirm-name.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('confirmationName takes the first candidate that is not blank, trimmed', () => {
  assertEquals(confirmationName('Edge One', 'edge.example.test', 'id-1'), 'Edge One')
  assertEquals(confirmationName('  Edge One  ', 'id-1'), 'Edge One')
  assertEquals(confirmationName(null, 'edge.example.test', 'id-1'), 'edge.example.test')
  assertEquals(confirmationName('   ', undefined, 'id-1'), 'id-1')
  assertEquals(confirmationName(null, undefined), '')
})

test('confirmNameMatches needs the exact name and never matches an empty one', () => {
  assertEquals(confirmNameMatches('shop', 'shop'), true)
  assertEquals(confirmNameMatches('Shop', 'shop'), false)
  assertEquals(confirmNameMatches('shop ', 'shop'), false)
  assertEquals(confirmNameMatches(undefined, 'shop'), false)
  assertEquals(confirmNameMatches('', ''), false)
})

test('refuseUnlessNameConfirmed answers 400 confirm_name_required until the name is typed', async () => {
  const app = new Hono<AppEnv>()
  app.delete(
    '/things/:id',
    (c) => refuseUnlessNameConfirmed(c, 'Hosting Account', 'site_a') ?? c.json({ ok: true })
  )

  const refused = await app.request('/things/1?confirmName=SITE_A', { method: 'DELETE' })
  assertEquals(refused.status, 400)
  assertEquals(await refused.json(), {
    error: CONFIRM_NAME_REQUIRED_ERROR,
    message: confirmNameMessage('Hosting Account'),
  })
  assertEquals(
    confirmNameMessage('Hosting Account'),
    'Type the Hosting Account name to delete this Hosting Account.'
  )

  const allowed = await app.request('/things/1?confirmName=site_a', { method: 'DELETE' })
  assertEquals(allowed.status, 200)
})
