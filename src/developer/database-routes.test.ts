import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { Db } from '../db.ts'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import { registerDatabaseRoutes } from './database-routes.ts'
import { testOnlyPostgresTcpUrl } from '../test-fixtures/database-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function buildDatabaseApp(db: Db | undefined, postgresConnectionString?: string) {
  const app = new Hono()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    if (postgresConnectionString) {
      c.set('postgresConnectionString', postgresConnectionString)
    }
    return next()
  })
  registerDatabaseRoutes(app)
  return app
}

test('GET /database/status reports unconfigured postgres', async () => {
  const urlKey = 'TURBOPANEL_DATABASE_URL'
  const dbKey = 'DATABASE_URL'
  const prevUrl = Deno.env.get(urlKey)
  const prevDb = Deno.env.get(dbKey)
  Deno.env.delete(urlKey)
  Deno.env.delete(dbKey)
  try {
    const app = buildDatabaseApp({} as Db)
    const res = await app.request('/database/status')
    assertEquals(res.status, 200)
    const body = await res.json() as {
      configured: boolean
      connected: boolean
      error: string | null
    }
    assertEquals(body.configured, false)
    assertEquals(body.connected, false)
    assertEquals(body.error, 'postgres is not configured (missing database URL)')
  } finally {
    if (prevUrl === undefined) Deno.env.delete(urlKey)
    else Deno.env.set(urlKey, prevUrl)
    if (prevDb === undefined) Deno.env.delete(dbKey)
    else Deno.env.set(dbKey, prevDb)
  }
})

test('GET /database/status reports client unavailable when db missing', async () => {
  const dbUrl = getDatabaseUrl()
  if (!dbUrl) {
    console.warn('Skipping database client unavailable test: no database URL')
    return
  }

  const app = buildDatabaseApp(undefined, dbUrl)
  const res = await app.request('/database/status')
  assertEquals(res.status, 200)
  const body = await res.json() as {
    configured: boolean
    connected: boolean
    error: string | null
  }
  assertEquals(body.configured, true)
  assertEquals(body.connected, false)
  assertEquals(body.error, 'database client failed to initialize')
})

test('GET /database/status returns connected postgres metadata', async () => {
  const dbUrl = getDatabaseUrl()
  if (!dbUrl) {
    console.warn('Skipping database connected test: no database URL')
    return
  }

  const db = createDenoDb()
  const app = buildDatabaseApp(db, dbUrl)
  const res = await app.request('/database/status')
  assertEquals(res.status, 200)
  const body = await res.json() as {
    configured: boolean
    connected: boolean
    version: string | null
    database: string | null
    error: string | null
  }
  assertEquals(body.configured, true)
  assertEquals(body.connected, true)
  assertEquals(body.error, null)
  assertEquals(typeof body.version, 'string')
  assertEquals(body.version!.includes('PostgreSQL'), true)
  assertEquals(body.database, 'turbopanel')
})

test('GET /database/status surfaces query errors', async () => {
  const db = {
    execute: async () => {
      throw new Error('connection refused')
    },
  } as unknown as Db

  const app = buildDatabaseApp(db, testOnlyPostgresTcpUrl())
  const res = await app.request('/database/status')
  assertEquals(res.status, 200)
  const body = await res.json() as {
    connected: boolean
    error: string | null
  }
  assertEquals(body.connected, false)
  assertEquals(body.error, 'connection refused')
})

test('GET /database/studio returns probe payload', async () => {
  const app = buildDatabaseApp(undefined)
  const res = await app.request('/database/studio')
  assertEquals(res.status, 200)
  const body = await res.json() as {
    running: boolean
    browserUrl: string
    port: number
  }
  assertEquals(typeof body.running, 'boolean')
  assertEquals(typeof body.browserUrl, 'string')
  assertEquals(typeof body.port, 'number')
})
