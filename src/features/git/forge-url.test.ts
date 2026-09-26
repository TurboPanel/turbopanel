import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import {
  assertForgeUrlAllowed,
  FORGE_MAX_REDIRECTS,
  forgeFetch,
  ForgeUrlError,
  validateForgeUrl,
} from './forge-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('accepts the forges an admin can legitimately name', () => {
  for (const url of [
    'https://github.com',
    'https://github.com/',
    'https://gitlab.example.com:8443/',
    'https://ghe.corp.example.com/api/v3',
    ' https://gitlab.com ',
    // A public IP literal is unusual but not an SSRF vector.
    'https://203.0.113.10',
    'https://[2001:db8::10]:8443',
  ]) {
    assertEquals(validateForgeUrl(url), null, url)
  }
})

test('refuses anything that is not https', () => {
  assertEquals(validateForgeUrl('http://gitlab.example.com'), 'scheme_not_https')
  assertEquals(validateForgeUrl('ftp://gitlab.example.com'), 'scheme_not_https')
  assertEquals(validateForgeUrl('file:///etc/passwd'), 'scheme_not_https')
  assertEquals(validateForgeUrl('gitlab.example.com'), 'malformed')
  assertEquals(validateForgeUrl(''), 'malformed')
})

test('refuses embedded credentials', () => {
  assertEquals(validateForgeUrl('https://user:pw@gitlab.example.com'), 'credentials_in_url')
  assertEquals(validateForgeUrl('https://token@gitlab.example.com'), 'credentials_in_url')
})

test('refuses loopback, link-local, private and unusable IP literals', () => {
  for (const url of [
    'https://127.0.0.1:5432',
    'https://[::1]',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5',
    'https://172.16.4.4',
    'https://192.168.1.1',
    'https://100.64.0.1',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://0.0.0.0',
    'https://224.0.0.1',
    // IPv4-mapped IPv6 spelling of the loopback.
    'https://[::ffff:127.0.0.1]',
  ]) {
    assertEquals(validateForgeUrl(url), 'address_not_public', url)
  }
})

test('refuses reserved and single-label host names', () => {
  for (const url of [
    'https://localhost',
    'https://LOCALHOST:8443',
    'https://gitlab.localhost',
    'https://gitlab.local',
    'https://metadata.internal',
    'https://metadata.google.internal',
    'https://1.0.168.192.in-addr.arpa',
    'https://router.home.arpa',
    'https://postgres',
    'https://intranet:8080',
  ]) {
    assertEquals(validateForgeUrl(url), 'reserved_host', url)
  }
})

test('assertForgeUrlAllowed throws a typed error naming the field and reason', () => {
  assertEquals(assertForgeUrlAllowed('baseUrl', 'https://github.com'), 'https://github.com')
  const err = assertThrows(
    () => assertForgeUrlAllowed('apiUrl', 'https://127.0.0.1:5432'),
    ForgeUrlError,
  )
  assertEquals(err.field, 'apiUrl')
  assertEquals(err.reason, 'address_not_public')
})

type Resolver = (name: string, type: 'A' | 'AAAA') => Promise<string[]>

/** Swap `Deno.resolveDns` for the duration of `fn` (the fetch-time DNS check reads it). */
async function withResolver(resolver: Resolver, fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(Deno, 'resolveDns')
  Object.defineProperty(Deno, 'resolveDns', { value: resolver, configurable: true, writable: true })
  try {
    await fn()
  } finally {
    if (original) Object.defineProperty(Deno, 'resolveDns', original)
  }
}

type Seen = { url: string; init: RequestInit | undefined }

/** Swap `fetch`, answering each request from `responses` in order, and record every request. */
async function withFetch(
  responses: Array<() => Response>,
  fn: (seen: Seen[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  const seen: Seen[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return Promise.resolve(next())
  }) as typeof fetch
  try {
    await fn(seen)
  } finally {
    globalThis.fetch = original
  }
}

const publicAnswer: Resolver = (_name, type) =>
  Promise.resolve(type === 'A' ? ['140.82.112.6'] : [])

test('forgeFetch never lets the runtime follow a redirect', async () => {
  await withResolver(publicAnswer, () =>
    withFetch([() => new Response('ok')], async (seen) => {
      await forgeFetch('https://ghe.example.com/api/v3/app')
      assertEquals(seen[0]!.init?.redirect, 'manual')
    }))
})

test('forgeFetch refuses a name that resolves inside the box, before any request', async () => {
  const internal: Resolver = (_name, type) => Promise.resolve(type === 'A' ? ['10.0.0.5'] : [])
  await withResolver(internal, () =>
    withFetch([], async (seen) => {
      const error = await assertRejects(
        () => forgeFetch('https://ghe.example.com/api/v3/app'),
        ForgeUrlError,
      )
      assertEquals((error as ForgeUrlError).reason, 'address_not_public')
      assertEquals(seen.length, 0)
    }))
})

test('forgeFetch fails closed on a resolver error, but leaves a missing name to the fetch', async () => {
  const servfail: Resolver = () => Promise.reject(new Error('SERVFAIL'))
  await withResolver(servfail, () =>
    withFetch([], async (seen) => {
      const error = await assertRejects(
        () => forgeFetch('https://ghe.example.com/api/v3/app'),
        ForgeUrlError,
      )
      assertEquals((error as ForgeUrlError).reason, 'dns_lookup_failed')
      assertEquals(seen.length, 0)
    }))
  const nxdomain: Resolver = () => Promise.reject(new Deno.errors.NotFound('no such name'))
  await withResolver(nxdomain, () =>
    withFetch([() => new Response('ok')], async (seen) => {
      await forgeFetch('https://ghe.example.com/api/v3/app')
      assertEquals(seen.length, 1)
    }))
})

test('forgeFetch re-checks and follows a same-origin redirect, keeping the method for a 307', async () => {
  await withResolver(publicAnswer, () =>
    withFetch([
      () => new Response(null, { status: 307, headers: { location: '/api/v3/moved' } }),
      () => new Response('ok'),
    ], async (seen) => {
      const response = await forgeFetch('https://ghe.example.com/api/v3/app', {
        method: 'POST',
        body: 'x',
      })
      assertEquals(await response.text(), 'ok')
      assertEquals(seen.map((s) => s.url), [
        'https://ghe.example.com/api/v3/app',
        'https://ghe.example.com/api/v3/moved',
      ])
      assertEquals(seen[1]!.init?.method, 'POST')
      assertEquals(seen[1]!.init?.body, 'x')
    }))
})

test('forgeFetch turns a 303 into a GET without the body', async () => {
  await withResolver(publicAnswer, () =>
    withFetch([
      () => new Response(null, { status: 303, headers: { location: '/done' } }),
      () => new Response('ok'),
    ], async (seen) => {
      await forgeFetch('https://ghe.example.com/start', { method: 'POST', body: 'x' })
      assertEquals(seen[1]!.init?.method, 'GET')
      assertEquals(seen[1]!.init?.body, undefined)
    }))
})

test('forgeFetch refuses a cross-origin redirect without sending anything there', async () => {
  await withResolver(publicAnswer, () =>
    withFetch([
      () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } }),
    ], async (seen) => {
      const error = await assertRejects(
        () => forgeFetch('https://ghe.example.com/api/v3/app'),
        ForgeUrlError,
      )
      assertEquals((error as ForgeUrlError).reason, 'cross_origin_redirect')
      assertEquals(seen.length, 1)
    }))
})

test('forgeFetch stops after a bounded number of redirects', async () => {
  const loop = () => new Response(null, { status: 301, headers: { location: '/again' } })
  await withResolver(publicAnswer, () =>
    withFetch(Array.from({ length: FORGE_MAX_REDIRECTS + 1 }, () => loop), async (seen) => {
      const error = await assertRejects(
        () => forgeFetch('https://ghe.example.com/again'),
        ForgeUrlError,
      )
      assertEquals((error as ForgeUrlError).reason, 'too_many_redirects')
      assertEquals(seen.length, FORGE_MAX_REDIRECTS + 1)
    }))
})
