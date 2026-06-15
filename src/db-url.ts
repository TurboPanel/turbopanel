export type PostgresConfigMeta = {
  configured: boolean
  transport: 'socket' | 'tcp' | null
  user: string | null
  database: string | null
}

/** Parse self-hosted postgres URLs, including Unix-socket `?host=` form. */
export function parsePostgresDatabaseUrl(url: string): {
  user: string
  database: string
  transport: 'socket' | 'tcp'
} | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return undefined
    }

    const user = decodeURIComponent(parsed.username)
    const database = parsed.pathname.replace(/^\//, '')
    if (!user || !database) return undefined

    const hostParam = parsed.searchParams.get('host')?.trim()
    if (hostParam) {
      return { user, database, transport: 'socket' }
    }

    if (parsed.hostname) {
      return { user, database, transport: 'tcp' }
    }

    return undefined
  } catch {
    // `postgresql://user:pass@/db?host=/path` has no hostname — URL rejects it.
    const match = url.match(/^postgres(?:ql)?:\/\/([^:@]+)(?::([^@]*))?@\/([^?]+)(?:\?(.*))?$/)
    if (!match) return undefined

    const [, userEnc, , dbEnc, query = ''] = match
    const hostParam = new URLSearchParams(query).get('host')?.trim()
    if (!hostParam) return undefined

    const user = decodeURIComponent(userEnc)
    const database = decodeURIComponent(dbEnc)
    if (!user || !database) return undefined

    return { user, database, transport: 'socket' }
  }
}

/** Derive status metadata from `TURBOPANEL_DATABASE_URL`. */
export function postgresConfigFromEnv(): PostgresConfigMeta {
  const explicit = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  if (!explicit) {
    return { configured: false, transport: null, user: null, database: null }
  }

  const parsed = parsePostgresDatabaseUrl(explicit)
  if (!parsed) {
    return { configured: false, transport: null, user: null, database: null }
  }

  return {
    configured: true,
    transport: parsed.transport,
    user: parsed.user,
    database: parsed.database,
  }
}

/** Self-hosted Postgres connection URL (`TURBOPANEL_DATABASE_URL` only). */
export function getDatabaseUrl(): string | undefined {
  const url = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  return url || undefined
}
