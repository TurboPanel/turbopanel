import { defineConfig } from 'drizzle-kit'

function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (url) return url

  const user = process.env.TURBOPANEL_PG_USER?.trim()
  const password = process.env.TURBOPANEL_PG_PASSWORD?.trim()
  const database = process.env.TURBOPANEL_PG_DB?.trim()
  const port = process.env.TURBOPANEL_PG_PORT?.trim() || '5432'
  const host = process.env.TURBOPANEL_PG_HOST?.trim()

  if (user && password && database && host) {
    const encUser = encodeURIComponent(user)
    const encPass = encodeURIComponent(password)
    return `postgresql://${encUser}:${encPass}@${host}:${port}/${database}`
  }

  throw new Error(
    'Postgres not configured for drizzle-kit (set DATABASE_URL or TURBOPANEL_PG_HOST for dev TCP)',
  )
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl(),
  },
})
