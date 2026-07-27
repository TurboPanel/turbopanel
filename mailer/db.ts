import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getDatabaseUrl, resolvePostgresConnection } from '../src/db-url.ts'
import * as schema from '../src/lib/db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

const PG_OPTS_DENO = {
  prepare: false as const,
  max: 10,
  backoff: () => 0,
}

export function createMailerDb(): Db | undefined {
  const url = getDatabaseUrl()
  if (!url) return undefined

  const connection = resolvePostgresConnection(url)
  const client = typeof connection === 'string'
    ? postgres(connection, PG_OPTS_DENO)
    : postgres({ ...connection, ...PG_OPTS_DENO })
  return drizzle(client, { schema })
}
