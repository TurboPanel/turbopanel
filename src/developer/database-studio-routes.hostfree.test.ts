/**
 * Host-free coverage for Deno-only Drizzle Studio spawn routes.
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { testOnlyPostgresTcpUrl } from '../test-fixtures/database-url.ts'
import { registerDatabaseStudioRoutes } from './database-studio-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function withClearedDatabaseUrlEnv(): () => void {
  const previousDatabaseUrl = Deno.env.get('DATABASE_URL')
  const previousTurbopanelUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')
  Deno.env.delete('DATABASE_URL')
  Deno.env.delete('TURBOPANEL_DATABASE_URL')
  return () => {
    if (previousDatabaseUrl === undefined) Deno.env.delete('DATABASE_URL')
    else Deno.env.set('DATABASE_URL', previousDatabaseUrl)
    if (previousTurbopanelUrl === undefined) {
      Deno.env.delete('TURBOPANEL_DATABASE_URL')
    } else {
      Deno.env.set('TURBOPANEL_DATABASE_URL', previousTurbopanelUrl)
    }
  }
}

test('POST /database/studio returns 503 when postgres is not configured', async () => {
  const restore = withClearedDatabaseUrlEnv()
  try {
    const developer = new Hono<AppEnv>()
    registerDatabaseStudioRoutes(developer)
    const res = await developer.request('http://localhost/database/studio', {
      method: 'POST',
    })
    assertEquals(res.status, 503)
    assertEquals(await res.json(), {
      ok: false,
      error: 'postgres is not configured (missing database URL)',
    })
  } finally {
    restore()
  }
})

test('POST /database/studio returns browserUrl when start succeeds', async () => {
  const restore = withClearedDatabaseUrlEnv()
  Deno.env.set('TURBOPANEL_DATABASE_URL', testOnlyPostgresTcpUrl())
  try {
    const developer = new Hono<AppEnv>()
    registerDatabaseStudioRoutes(developer, {
      startStudio: () =>
        Promise.resolve({
          ok: true,
          browserUrl: 'http://127.0.0.1:4983',
          port: 4983,
        }),
    })
    const res = await developer.request('http://localhost/database/studio', {
      method: 'POST',
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), {
      ok: true,
      browserUrl: 'http://127.0.0.1:4983',
      port: 4983,
    })
  } finally {
    restore()
  }
})

test('POST /database/studio maps loopback errors to 400', async () => {
  const restore = withClearedDatabaseUrlEnv()
  Deno.env.set('TURBOPANEL_DATABASE_URL', testOnlyPostgresTcpUrl())
  try {
    const developer = new Hono<AppEnv>()
    registerDatabaseStudioRoutes(developer, {
      startStudio: () =>
        Promise.resolve({
          ok: false,
          error: 'bind host must be loopback',
        }),
    })
    const res = await developer.request('http://localhost/database/studio', {
      method: 'POST',
    })
    assertEquals(res.status, 400)
    assertEquals(await res.json(), {
      ok: false,
      error: 'bind host must be loopback',
    })
  } finally {
    restore()
  }
})

test('POST /database/studio maps other start failures to 500', async () => {
  const restore = withClearedDatabaseUrlEnv()
  Deno.env.set('TURBOPANEL_DATABASE_URL', testOnlyPostgresTcpUrl())
  try {
    const developer = new Hono<AppEnv>()
    registerDatabaseStudioRoutes(developer, {
      startStudio: () =>
        Promise.resolve({
          ok: false,
          error: 'drizzle-kit failed to start',
        }),
    })
    const res = await developer.request('http://localhost/database/studio', {
      method: 'POST',
    })
    assertEquals(res.status, 500)
    assertEquals(await res.json(), {
      ok: false,
      error: 'drizzle-kit failed to start',
    })
  } finally {
    restore()
  }
})
