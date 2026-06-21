import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import postgres from 'postgres'
import {
  getDatabaseUrl,
  getToolingDatabaseUrl,
  resolvePostgresConnection,
} from './db-url.ts'
import * as schema from './db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

/** Minimal Hyperdrive surface used by `createWorkersDb` (Workers runtime). */
export type HyperdriveBinding = {
  connectionString: string
}

/** Hyperdrive transaction pooling — one connection per isolate. */
const PG_OPTS_WORKERS = { prepare: false as const, max: 1 }

/**
 * Self-hosted Deno: up to 10 concurrent connections.
 * No idle_timeout — let connections live for the process lifetime so postgres.js
 * never has to recreate them mid-request. Tilt restarts the process anyway.
 * backoff: 0 — disable exponential reconnect delay; options.shared.retries can
 * accumulate to 6+ on any connection error and backoff(6)*1000 ≈ 7300ms, causing
 * the entire pool to pause for ~7s waiting to reconnect. With 0, reconnect is
 * immediate after any close event regardless of retry count.
 */
const PG_OPTS_DENO = {
  prepare: false as const,
  max: 10,
  backoff: 0,
}

export function createWorkersDb(hyperdrive: HyperdriveBinding): Db {
  const client = postgres(hyperdrive.connectionString, PG_OPTS_WORKERS)
  return drizzle(client, { schema })
}

const TOOLING_DATABASE_URL_ERROR =
  'TURBOPANEL_DATABASE_URL or DATABASE_URL is required'

export function createDenoDb(): Db {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error('TURBOPANEL_DATABASE_URL is required')
  }
  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  return drizzle(client, { schema })
}

/** Node/drizzle-kit migration repair — accepts `DATABASE_URL` for Workers/CI. */
export function createToolingDb(): Db {
  const url = getToolingDatabaseUrl()
  if (!url) {
    throw new Error(TOOLING_DATABASE_URL_ERROR)
  }
  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  return drizzle(client, { schema })
}

export function getDb(c: Context): Db | undefined {
  return c.get('db')
}
