import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import postgres from 'postgres'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import { getDatabaseUrl, resolvePostgresConnection } from './db-url.ts'
import * as schema from './lib/db/schema.ts'

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

const DATABASE_URL_REQUIRED = 'TURBOPANEL_DATABASE_URL is required'

export function createDenoDb(): Db {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error(DATABASE_URL_REQUIRED)
  }
  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  return drizzle(client, { schema })
}

/** Node/drizzle-kit migration repair — requires `TURBOPANEL_DATABASE_URL`. */
export function createToolingDb(): Db {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error(DATABASE_URL_REQUIRED)
  }
  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  return drizzle(client, { schema })
}

/** Run tooling DB work and close the postgres.js pool so short-lived scripts can exit. */
export async function withToolingDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = getDatabaseUrl()
  if (!url) {
    throw new Error(DATABASE_URL_REQUIRED)
  }
  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  const db = drizzle(client, { schema })
  try {
    return await fn(db)
  } finally {
    await client.end({ timeout: 5 })
  }
}

export function getDb(c: Context): Db | undefined {
  return c.get('db')
}

export function getDaemonCellRegistry(c: Context): DaemonCellRegistry | undefined {
  return c.get('daemonCellRegistry')
}

export function getQueryCache(c: Context): QueryCache | undefined {
  return c.get('queryCache')
}
