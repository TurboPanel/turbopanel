import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import postgres from 'postgres'
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

export function createDenoDb(): Db | undefined {
  const user = Deno.env.get('TURBOPANEL_PG_USER')
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')
  const database = Deno.env.get('TURBOPANEL_PG_DB')
  if (!user || !password || !database) return undefined

  const port = Number(Deno.env.get('TURBOPANEL_PG_PORT') ?? '5432')
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')?.trim()
  const host = Deno.env.get('TURBOPANEL_PG_HOST')?.trim()

  let client: ReturnType<typeof postgres>
  if (socket) {
    // postgres.js builds `host/.s.PGSQL.<port>` when host contains a slash.
    const socketDir = socket.includes('.s.PGSQL.')
      ? socket.slice(0, socket.lastIndexOf('/'))
      : socket
    client = postgres({ ...PG_OPTS_DENO, user, password, database, host: socketDir, port })
  } else if (host) {
    // TCP fallback only when no socket path is configured.
    client = postgres({ ...PG_OPTS_DENO, user, password, database, host, port })
  } else {
    return undefined
  }

  return drizzle(client, { schema })
}

export function getDb(c: Context): Db | undefined {
  return c.get('db')
}
