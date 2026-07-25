/**
 * Native Postgres `inet` and `cidr` column types via Drizzle `customType`.
 *
 * Prefer these over `varchar` so Postgres validates addresses on write and
 * operators such as `<<=` (containment) work for "is this address inside the
 * datacenter network" queries. Values round-trip as strings on Deno and
 * Workers/Hyperdrive — postgres.js has no built-in parser for these types.
 *
 * These are the **only** custom column types in this schema; do not add regex
 * CHECK constraints on `inet`/`cidr` columns.
 */

import { customType } from 'drizzle-orm/pg-core'

export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet'
  },
})

export const cidr = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'cidr'
  },
})
