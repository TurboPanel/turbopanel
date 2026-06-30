import type { Db } from '../db.ts'
import type { QueryCache } from './contracts.ts'

class PassthroughQueryCache implements QueryCache {
  constructor(private readonly db?: Db) {}

  async cached<T>(opts: {
    key: string
    ttlSeconds?: number
    load: (db: Db) => Promise<T>
  }): Promise<T> {
    if (this.db === undefined) {
      throw new Error('Database unavailable')
    }
    return opts.load(this.db)
  }
}

export function createPassthroughQueryCache(db?: Db): QueryCache {
  return new PassthroughQueryCache(db)
}
