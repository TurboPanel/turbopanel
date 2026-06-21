import { defineConfig } from 'drizzle-kit'
import { drizzleDbCredentialsFromEnv } from './scripts/resolve-postgres-url.mjs'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: drizzleDbCredentialsFromEnv(),
})
