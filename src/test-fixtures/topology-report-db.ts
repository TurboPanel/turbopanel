/**
 * A fake `Db` surface for tests that only need to see what a `topology-report`
 * writes. `recordTopologyGeneration` runs inside a transaction, takes a lock
 * on the server row, reads `server.metadata.hardware` and writes it back with
 * `jsonb_set`; this fake answers those statements (the server has no hardware
 * yet, the write succeeds) and captures the values the write carried.
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
      if (text.includes('FOR UPDATE')) {
        return Promise.resolve([{ has_hardware: false, same: false, recently_written: false }])
      }
      if (text.includes("'{hardware}'")) {
        const [generation, bootGeneration, snapshot, appliedAt, serverId] = params
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
