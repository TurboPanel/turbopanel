import { assertEquals, assertStringIncludes } from '@std/assert'

import {
  configuredDrizzleStudioHost,
  DRIZZLE_STUDIO_BROWSER_ORIGIN,
  DRIZZLE_STUDIO_PORT,
  drizzleStudioBrowserUrl,
  drizzleStudioProbeStatus,
  formatDrizzleStudioHttpHost,
  probeDrizzleStudioPort,
  resolveDrizzleStudioBindHost,
} from './drizzle-studio-probe.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('DRIZZLE_STUDIO_PORT and browser origin defaults are stable', () => {
  assertEquals(typeof DRIZZLE_STUDIO_PORT, 'number')
  assertEquals(DRIZZLE_STUDIO_BROWSER_ORIGIN, 'https://local.drizzle.studio')
})

test('configuredDrizzleStudioHost defaults to localhost', () => {
  const key = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
  const previous = Deno.env.get(key)
  try {
    Deno.env.delete(key)
    assertEquals(configuredDrizzleStudioHost(), 'localhost')
    Deno.env.set(key, '  ::1  ')
    assertEquals(configuredDrizzleStudioHost(), '::1')
  } finally {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
})

test('resolveDrizzleStudioBindHost maps loopback hosts', () => {
  const local = resolveDrizzleStudioBindHost('localhost')
  assertEquals(local.ok, true)
  if (!local.ok) throw new TypeError('expected ok')
  assertEquals(local.bindHost, '127.0.0.1')
  assertEquals(local.browserHost, 'localhost')

  const v6 = resolveDrizzleStudioBindHost('[::1]')
  assertEquals(v6.ok, true)
  if (!v6.ok) throw new TypeError('expected ok')
  assertEquals(v6.bindHost, '::1')
  assertEquals(v6.browserHost, '::1')
})

test('resolveDrizzleStudioBindHost rejects non-loopback hosts', () => {
  const result = resolveDrizzleStudioBindHost('203.0.113.10')
  assertEquals(result.ok, false)
  if (result.ok) throw new TypeError('expected failure')
  assertStringIncludes(result.error, 'loopback')
})

test('formatDrizzleStudioHttpHost brackets IPv6', () => {
  assertEquals(formatDrizzleStudioHttpHost('127.0.0.1'), '127.0.0.1')
  assertEquals(formatDrizzleStudioHttpHost('::1'), '[::1]')
})

test('drizzleStudioBrowserUrl builds the hosted studio query', () => {
  const url = drizzleStudioBrowserUrl(4983, '127.0.0.1')
  assertStringIncludes(url, DRIZZLE_STUDIO_BROWSER_ORIGIN)
  assertStringIncludes(url, 'host=localhost')
  assertStringIncludes(url, 'port=4983')
})

test('drizzleStudioBrowserUrl falls back to localhost for invalid hosts', () => {
  const url = drizzleStudioBrowserUrl(4983, '0.0.0.0')
  assertStringIncludes(url, 'host=localhost')
})

test('probeDrizzleStudioPort returns false when nothing listens', async () => {
  // Unused high port — fetch should fail closed.
  assertEquals(await probeDrizzleStudioPort('127.0.0.1', 1), false)
})

test('probeDrizzleStudioPort returns true when a loopback listener answers', async () => {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, () =>
    new Response('ok', { status: 200 })
  )
  try {
    const { port } = server.addr as Deno.NetAddr
    assertEquals(await probeDrizzleStudioPort('127.0.0.1', port), true)
  } finally {
    await server.shutdown()
  }
})

test('drizzleStudioProbeStatus reports invalid configured host', async () => {
  const key = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
  const previous = Deno.env.get(key)
  Deno.env.set(key, '0.0.0.0')
  try {
    const status = await drizzleStudioProbeStatus()
    assertEquals(status.running, false)
    assertStringIncludes(status.error ?? '', 'loopback')
    assertStringIncludes(status.browserUrl, 'host=localhost')
  } finally {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
})

test('drizzleStudioProbeStatus probes loopback when configured correctly', async () => {
  const key = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
  const previous = Deno.env.get(key)
  Deno.env.set(key, 'localhost')
  try {
    const status = await drizzleStudioProbeStatus()
    assertEquals(typeof status.running, 'boolean')
    assertEquals(status.port, DRIZZLE_STUDIO_PORT)
    assertStringIncludes(status.browserUrl, DRIZZLE_STUDIO_BROWSER_ORIGIN)
    assertEquals(status.error, undefined)
  } finally {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
})
