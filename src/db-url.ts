export type PostgresConfigMeta = {
  configured: boolean
  transport: 'socket' | 'tcp' | null
  user: string | null
  database: string | null
}

export type PostgresConnectionConfig =
  | string
  | {
      host: string
      database: string
      user: string
      pass: string
    }

/** Parse self-hosted postgres URLs, including Unix-socket `?host=` form. */
export function parsePostgresDatabaseUrl(url: string): {
  user: string
  database: string
  transport: 'socket' | 'tcp'
} | undefined {
  const resolved = resolvePostgresConnectionParts(url)
  if (!resolved) return undefined
  return {
    user: resolved.user,
    database: resolved.database,
    transport: resolved.socketDir ? 'socket' : 'tcp',
  }
}

export function resolvePostgresConnectionParts(url: string): {
  user: string
  pass: string
  database: string
  socketDir: string | null
  tcpUrl: string | null
} | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return undefined
    }

    const user = decodeURIComponent(parsed.username)
    const database = parsed.pathname.replace(/^\//, '')
    if (!user || !database) return undefined

    const socketDir = parsed.searchParams.get('host')?.trim() || null
    if (socketDir) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir,
        tcpUrl: null,
      }
    }

    if (parsed.hostname) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir: null,
        tcpUrl: url,
      }
    }

    return undefined
  } catch {
    // `postgresql://user:pass@/db?host=/path` has no hostname — URL rejects it.
    const match = url.match(/^postgres(?:ql)?:\/\/([^:@]+)(?::([^@]*))?@\/([^?]+)(?:\?(.*))?$/)
    if (!match) return undefined

    const [, userEnc, passwordEnc = '', dbEnc, query = ''] = match
    const socketDir = new URLSearchParams(query).get('host')?.trim() || null
    if (!socketDir) return undefined

    const user = decodeURIComponent(userEnc)
    const database = decodeURIComponent(dbEnc)
    if (!user || !database) return undefined

    return {
      user,
      pass: decodeURIComponent(passwordEnc),
      database,
      socketDir,
      tcpUrl: null,
    }
  }
}

/**
 * Resolve `TURBOPANEL_DATABASE_URL` for postgres.js.
 * Unix-socket libpq URLs (`?host=`) become a connection object — Deno's URL
 * parser and postgres.js string parsing both reject the `@/db` form.
 */
export function resolvePostgresConnection(url: string): PostgresConnectionConfig {
  const parts = resolvePostgresConnectionParts(url)
  if (!parts) {
    throw new Error('invalid TURBOPANEL_DATABASE_URL')
  }
  if (parts.tcpUrl) {
    return parts.tcpUrl
  }
  return {
    host: parts.socketDir!,
    database: parts.database,
    user: parts.user,
    pass: parts.pass,
  }
}

/** Derive status metadata from a postgres connection URL. */
export function postgresConfigFromUrl(
  url: string | undefined,
): PostgresConfigMeta {
  const explicit = url?.trim()
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

function readEnv(name: string): string | undefined {
  if (typeof Deno !== 'undefined') {
    return Deno.env.get(name)
  }
  return process.env[name]
}

/** Derive status metadata from `TURBOPANEL_DATABASE_URL`. */
export function postgresConfigFromEnv(): PostgresConfigMeta {
  return postgresConfigFromUrl(readEnv('TURBOPANEL_DATABASE_URL'))
}

/** Self-hosted Postgres connection URL (`TURBOPANEL_DATABASE_URL` only). */
export function getDatabaseUrl(): string | undefined {
  const url = readEnv('TURBOPANEL_DATABASE_URL')?.trim()
  return url || undefined
}
