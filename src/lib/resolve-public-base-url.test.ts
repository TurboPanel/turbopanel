import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { parseInstallBaseUrl, resolvePublicBaseUrl } from './resolve-public-base-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseInstallBaseUrl accepts https origins in production', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com'), 'https://panel.example.com')
})

test('parseInstallBaseUrl rejects plaintext http without dev allowance', () => {
  assertEquals(parseInstallBaseUrl('http://panel.example.com'), null)
})

test('parseInstallBaseUrl allows plaintext http with dev allowance', () => {
  assertEquals(
    parseInstallBaseUrl('http://dev.example.com:8880', { allowHttp: true }),
    'http://dev.example.com:8880',
  )
})

test('parseInstallBaseUrl rejects paths, query strings, and shell metacharacters', () => {
  assertEquals(parseInstallBaseUrl('https://panel.example.com; curl http://evil'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/path'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com?x=$(id)'), null)
  assertEquals(parseInstallBaseUrl('https://panel.example.com/`whoami`'), null)
})

test('resolvePublicBaseUrl prefers opts.baseUrl over forwarded headers', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('platformEnv', {})
    return c.text(await resolvePublicBaseUrl(c, { baseUrl: 'https://preferred.example.com' }))
  })
  const res = await app.request('https://internal.invalid/t', {
    headers: {
      'x-forwarded-host': 'ignored.example.com',
      'x-forwarded-proto': 'https',
    },
  })
  assertEquals(await res.text(), 'https://preferred.example.com')
})

test('resolvePublicBaseUrl reads TURBOPANEL_BASE_URL from platformEnv on Workers', async () => {
  const app = new Hono<AppEnv>()
  app.get('/t', async (c) => {
    c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://workers.example.com' })
    return c.text(await resolvePublicBaseUrl(c))
  })
  const res = await app.request('https://internal.invalid/t')
  assertEquals(await res.text(), 'https://workers.example.com')
})
