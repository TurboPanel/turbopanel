import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createWorkersDb, endDbConnection, getDb, type Db } from '../../db/connection.ts'

export type TaskDb = { db: Db; close: () => Promise<void> }

/**
 * The database client for work that runs after the response. Workers: a fresh
 * one from the connection string, closed when the task ends (`src/workers.ts`
 * closes the request's client in its own `waitUntil`, and a task that kept
 * using it would race that close). Deno: the process client, which nothing
 * closes.
 */
export function taskDbOpener(c: Context<AppEnv>): (() => TaskDb) | null {
  if (c.get('runtime') === 'workers') {
    const connectionString = c.get('postgresConnectionString')
    if (!connectionString) return null
    return () => {
      const db = createWorkersDb({ connectionString })
      return { db, close: () => endDbConnection(db) }
    }
  }
  const db = getDb(c)
  return db ? () => ({ db, close: () => Promise.resolve() }) : null
}
