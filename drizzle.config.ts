import { defineConfig } from 'drizzle-kit'

function socketDirFromEnv(socket: string): string {
  return socket.includes('.s.PGSQL.')
    ? socket.slice(0, socket.lastIndexOf('/'))
    : socket
}

type PgCredentials =
  | { url: string }
  | {
    host: string
    port?: number
    user?: string
    password?: string
    database: string
  }

function postgresCredentials(): PgCredentials {
  const socket = process.env.TURBOPANEL_PG_SOCKET?.trim()
  const user = process.env.TURBOPANEL_PG_USER?.trim()
  const password = process.env.TURBOPANEL_PG_PASSWORD?.trim()
  const database = process.env.TURBOPANEL_PG_DB?.trim()
  const port = Number(process.env.TURBOPANEL_PG_PORT?.trim() || '5432')
  const host = process.env.TURBOPANEL_PG_HOST?.trim()

  // Socket-first: Node postgres.js ignores libpq `?host=` on TCP URLs.
  if (socket && user && password && database) {
    return {
      host: socketDirFromEnv(socket),
      port,
      user,
      password,
      database,
    }
  }

  const url =
    process.env.TURBOPANEL_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (url) return { url }

  if (!user || !password || !database) {
    throw new Error(
      'Postgres not configured for drizzle-kit (set TURBOPANEL_DATABASE_URL, DATABASE_URL, or TURBOPANEL_PG_* env)',
    )
  }

  if (host) {
    return { host, port, user, password, database }
  }

  throw new Error(
    'Postgres not configured for drizzle-kit (set TURBOPANEL_DATABASE_URL, DATABASE_URL, TURBOPANEL_PG_SOCKET, or TURBOPANEL_PG_HOST)',
  )
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: postgresCredentials(),
})
