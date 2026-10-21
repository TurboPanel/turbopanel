/**
 * A fake `Db` surface for tests that only need to see what a `topology-report`
 * writes. `recordTopologyGeneration` runs inside a transaction, locks the
 * server row (a `select ... for update`, nothing stored yet) and writes the
 * `server.hardware` column; this fake answers the select and captures the
 * value the update carried.
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
    execute: (): Promise<unknown[]> => Promise.resolve([]),
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: () => Promise.resolve([{ hardware: null }]) }),
        }),
      }),
    }),
    update: () => ({
      set: (values: { hardware?: SQL }) => ({
        where: (condition: SQL) => {
          if (values.hardware) {
            const written = JSON.parse(String(dialect.sqlToQuery(values.hardware).params[0])) as {
              generation: number
              bootGeneration: number
              snapshot: unknown
              appliedAt: string
            }
            inserted.push({
              serverId: String(dialect.sqlToQuery(condition).params[0]),
              generation: written.generation,
              bootGeneration: written.bootGeneration,
              snapshot: written.snapshot,
              appliedAt: written.appliedAt,
            })
          }
          return Promise.resolve([])
        },
      }),
    }),
  }
  const db = {
    ...base,
    transaction: <T>(callback: (tx: unknown) => Promise<T>) => callback(tx),
  } as unknown as Db
  return { db, inserted }
}
