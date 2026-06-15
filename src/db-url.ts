/** Directory containing `.s.PGSQL.<port>` (or a socket path already pointing at the dir). */
export function socketDirFromPgSocket(socket: string): string {
  return socket.includes('.s.PGSQL.')
    ? socket.slice(0, socket.lastIndexOf('/'))
    : socket
}

export type PostgresEnvConfig = {
  user: string
  password: string
  database: string
  port: number
  socketDir?: string
  host?: string
}

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

/** Derive status metadata from `TURBOPANEL_DATABASE_URL` with legacy `TURBOPANEL_PG_*` fallback. */
export function postgresConfigFromEnv(): PostgresConfigMeta {
  const explicit = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  if (explicit) {
    const parsed = parsePostgresDatabaseUrl(explicit)
    if (parsed) {
      return {
        configured: true,
        transport: parsed.transport,
        user: parsed.user,
        database: parsed.database,
      }
    }
  }

  const user = Deno.env.get('TURBOPANEL_PG_USER')?.trim() ?? null
  const database = Deno.env.get('TURBOPANEL_PG_DB')?.trim() ?? null
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')?.trim()
  const host = Deno.env.get('TURBOPANEL_PG_HOST')?.trim()
  const configured = Boolean(user && password && database && (socket || host))
  const transport = socket ? 'socket' as const : host ? 'tcp' as const : null
  return { configured, transport, user, database }
}

/** Read self-hosted `TURBOPANEL_PG_*` env into a normalized shape. */
export function postgresEnvFromEnv(): PostgresEnvConfig | undefined {
  const user = Deno.env.get('TURBOPANEL_PG_USER')?.trim()
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')?.trim()
  const database = Deno.env.get('TURBOPANEL_PG_DB')?.trim()
  if (!user || !password || !database) return undefined

  const port = Number(Deno.env.get('TURBOPANEL_PG_PORT')?.trim() || '5432')
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')?.trim()
  const host = Deno.env.get('TURBOPANEL_PG_HOST')?.trim()

  if (socket) {
    return { user, password, database, port, socketDir: socketDirFromPgSocket(socket) }
  }
  if (host) {
    return { user, password, database, port, host }
  }
  return undefined
}

/** Build a postgres connection URL from env (`TURBOPANEL_DATABASE_URL` first, else legacy TCP vars). */
export function buildPostgresUrlFromEnv(): string | undefined {
  const explicit = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  if (explicit) return explicit

  const cfg = postgresEnvFromEnv()
  if (!cfg) return undefined

  const encUser = encodeURIComponent(cfg.user)
  const encPass = encodeURIComponent(cfg.password)

  if (cfg.socketDir) return undefined
  if (cfg.host) {
    return `postgresql://${encUser}:${encPass}@${cfg.host}:${cfg.port}/${cfg.database}`
  }
  return undefined
}

/** Explicit URL override, else URL derived from legacy `TURBOPANEL_PG_*` TCP vars. */
export function getDatabaseUrl(): string | undefined {
  return buildPostgresUrlFromEnv()
}
