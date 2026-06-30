import type { Db } from '../db.ts'
import { isApprovedReadModelId } from './approved-read-models.ts'
import type { QueryCache } from './contracts.ts'

class PassthroughQueryCache implements QueryCache {
  constructor(private readonly db?: Db) {}

  async getReadModel<T>(opts: {
    readModel: string
    key: string
    ttlSeconds?: number
    load: (db: Db) => Promise<T>
  }): Promise<T> {
    if (!isApprovedReadModelId(opts.readModel)) {
      throw new Error(`Unapproved read model for query cache: ${opts.readModel}`)
    }
    if (this.db === undefined) {
      throw new Error('Database unavailable')
    }
    return opts.load(this.db)
  }
}

export function createPassthroughQueryCache(db?: Db): QueryCache {
  return new PassthroughQueryCache(db)
}
