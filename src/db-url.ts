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

/** Build a postgres TCP connection URL (socket mode must use object credentials in drizzle-kit). */
export function buildPostgresUrlFromEnv(): string | undefined {
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
