import type { Context } from 'hono'
import type { PostgresConfigMeta } from './db-url.ts'
import { postgresConfigFromEnv, postgresConfigFromUrl } from './db-url.ts'
import { drizzleStudioProbeStatus } from './drizzle-studio-probe.ts'

export { drizzleStudioProbeStatus }

export function postgresConfigFromContext(c: Context): PostgresConfigMeta {
  const fromContext = c.get('postgresConnectionString') as string | undefined
  if (fromContext) {
    const meta = postgresConfigFromUrl(fromContext)
    if (meta.configured) return meta
  }
  return postgresConfigFromEnv()
}
