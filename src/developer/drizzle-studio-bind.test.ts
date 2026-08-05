import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  resolveDrizzleStudioBindHost,
} from '../drizzle-studio-probe.ts'
import { startDrizzleStudio } from './drizzle-studio.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

describe('resolveDrizzleStudioBindHost', () => {
  it('allows localhost / 127.0.0.1 / ::1', () => {
    assertEquals(resolveDrizzleStudioBindHost('localhost').ok, true)
    assertEquals(resolveDrizzleStudioBindHost('127.0.0.1').ok, true)
    assertEquals(resolveDrizzleStudioBindHost('::1').ok, true)
    assertEquals(resolveDrizzleStudioBindHost('[::1]').ok, true)

    const local = resolveDrizzleStudioBindHost('localhost')
    if (!local.ok) throw new TypeError('expected ok')
    assertEquals(local.bindHost, '127.0.0.1')
    assertEquals(local.browserHost, 'localhost')
  })

  it('rejects non-loopback hosts', () => {
    const result = resolveDrizzleStudioBindHost('0.0.0.0')
    assertEquals(result.ok, false)
    if (result.ok) throw new TypeError('expected failure')
    assertEquals(result.error.includes('loopback'), true)

    assertEquals(resolveDrizzleStudioBindHost('192.168.1.10').ok, false)
    assertEquals(resolveDrizzleStudioBindHost('example.com').ok, false)
  })
})

describe('startDrizzleStudio loopback gate', () => {
  it('rejects non-loopback TURBOPANEL_DRIZZLE_STUDIO_HOST without spawning', async () => {
    const key = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
    const previous = Deno.env.get(key)
    Deno.env.set(key, '0.0.0.0')
    try {
      const started = await startDrizzleStudio()
      assertEquals(started.ok, false)
      if (started.ok) throw new TypeError('expected failure')
      assertEquals(started.error.includes('loopback'), true)
      assertEquals(started.error.includes('0.0.0.0'), true)
    } finally {
      if (previous === undefined) Deno.env.delete(key)
      else Deno.env.set(key, previous)
    }
  })
})

test('drizzle studio bind suite loaded', () => {
  assertEquals(typeof resolveDrizzleStudioBindHost, 'function')
})
