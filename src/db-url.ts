/** Build a postgres connection URL from self-hosted `TURBOPANEL_PG_*` env vars. */
export function buildPostgresUrlFromEnv(): string | undefined {
  const user = Deno.env.get('TURBOPANEL_PG_USER')?.trim()
  const password = Deno.env.get('TURBOPANEL_PG_PASSWORD')?.trim()
  const database = Deno.env.get('TURBOPANEL_PG_DB')?.trim()
  if (!user || !password || !database) return undefined

  const encUser = encodeURIComponent(user)
  const encPass = encodeURIComponent(password)
  const port = Deno.env.get('TURBOPANEL_PG_PORT')?.trim() || '5432'
  const socket = Deno.env.get('TURBOPANEL_PG_SOCKET')?.trim()
  const host = Deno.env.get('TURBOPANEL_PG_HOST')?.trim()

  if (socket) {
    const socketDir = socket.includes('.s.PGSQL.')
      ? socket.slice(0, socket.lastIndexOf('/'))
      : socket
    // libpq socket URLs need a host placeholder; `@/db` breaks Node's URL parser.
    return `postgresql://${encUser}:${encPass}@127.0.0.1:${port}/${database}?host=${
      encodeURIComponent(socketDir)
    }`
  }
  if (host) {
    return `postgresql://${encUser}:${encPass}@${host}:${port}/${database}`
  }
  return undefined
}
