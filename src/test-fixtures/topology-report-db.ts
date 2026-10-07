/**
 * A fake `Db` surface for tests that only need to see what a `topology-report`
 * writes. `recordTopologyGeneration` runs inside a transaction, takes a lock
 * on the server row, looks for the server's hardware row and inserts; this fake answers
 * those statements (nothing exists yet, the insert succeeds) and captures the
 * values the insert carried.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'

export type RecordedTopologyInsert = {
  serverId: string
  generation: number
  bootGeneration: number
  snapshot: unknown
  appliedAt: string
}

const dialect = new PgDialect()

export function withTopologyReportRecording(base: Record<string, unknown>): {
  db: Db
  inserted: RecordedTopologyInsert[]
} {
  const inserted: RecordedTopologyInsert[] = []
  const tx = {
    execute: (query: SQL): Promise<unknown[]> => {
      const { sql: text, params } = dialect.sqlToQuery(query)
      if (text.includes('INSERT INTO hardware')) {
        const [serverId, generation, bootGeneration, snapshot, appliedAt] = params
        inserted.push({
          serverId: String(serverId),
          generation: Number(generation),
          bootGeneration: Number(bootGeneration),
          snapshot: JSON.parse(String(snapshot)),
          appliedAt: String(appliedAt),
        })
        return Promise.resolve([{ id: 'row-1' }])
      }
      return Promise.resolve([])
    },
  }
  const db = {
    ...base,
    transaction: <T>(callback: (tx: unknown) => Promise<T>) => callback(tx),
  } as unknown as Db
  return { db, inserted }
}
