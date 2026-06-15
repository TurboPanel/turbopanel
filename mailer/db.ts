import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getDatabaseUrl, resolvePostgresConnection } from '../src/db-url.ts'
import * as schema from '../src/db/schema.ts'

export type Db = PostgresJsDatabase<typeof schema>

const PG_OPTS_DENO = {
  prepare: false as const,
  max: 10,
  backoff: 0,
}

export function createMailerDb(): Db | undefined {
  const url = getDatabaseUrl()
  if (!url) return undefined

  const client = postgres(resolvePostgresConnection(url), PG_OPTS_DENO)
  return drizzle(client, { schema })
}
