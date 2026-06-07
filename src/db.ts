import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Context } from 'hono'
import postgres from 'postgres'
import * as schema from './db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

/** Minimal Hyperdrive surface used by `createWorkersDb` (Workers runtime). */
export type HyperdriveBinding = {
  connectionString: string
}

const PG_OPTS = { prepare: false as const, max: 1 }

export function createWorkersDb(hyperdrive: HyperdriveBinding): Db {
  const client = postgres(hyperdrive.connectionString, PG_OPTS)
  return drizzle(client, { schema })
}

export function createDenoDb(): Db | undefined {
  const user = Deno.env.get('TURBOPANEL_PG_USER')
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')
  const database = Deno.env.get('TURBOPANEL_PG_DB')
  if (!user || !password || !database) return undefined

  const port = Number(Deno.env.get('TURBOPANEL_PG_PORT') ?? '5432')
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')
  const host = Deno.env.get('TURBOPANEL_PG_HOST')

  let client: ReturnType<typeof postgres>
  if (socket) {
    // postgres.js builds `host/.s.PGSQL.<port>` when host contains a slash.
    const socketDir = socket.includes('.s.PGSQL.')
      ? socket.slice(0, socket.lastIndexOf('/'))
      : socket
    client = postgres({ ...PG_OPTS, user, password, database, host: socketDir, port })
  } else if (host) {
    client = postgres({ ...PG_OPTS, user, password, database, host, port })
  } else {
    return undefined
  }

  return drizzle(client, { schema })
}

export function getDb(c: Context): Db | undefined {
  return c.get('db')
}
