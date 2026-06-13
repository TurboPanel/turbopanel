import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../src/db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

const PG_OPTS_DENO = {
  prepare: false as const,
  max: 10,
  backoff: 0,
}

export function createMailerDb(): Db | undefined {
  const user = Deno.env.get('TURBOPANEL_PG_USER')
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')
  const database = Deno.env.get('TURBOPANEL_PG_DB')
  if (!user || !password || !database) return undefined

  const port = Number(Deno.env.get('TURBOPANEL_PG_PORT') ?? '5432')
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')?.trim()
  const host = Deno.env.get('TURBOPANEL_PG_HOST')?.trim()

  let client: ReturnType<typeof postgres>
  if (socket) {
    const socketDir = socket.includes('.s.PGSQL.')
      ? socket.slice(0, socket.lastIndexOf('/'))
      : socket
    client = postgres({ ...PG_OPTS_DENO, user, password, database, host: socketDir, port })
  } else if (host) {
    client = postgres({ ...PG_OPTS_DENO, user, password, database, host, port })
  } else {
    return undefined
  }

  return drizzle(client, { schema })
}
