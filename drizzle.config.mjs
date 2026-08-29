import { defineConfig } from 'drizzle-kit'
import { drizzleDbCredentialsFromEnv } from './scripts/resolve-postgres-url.mjs'

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './migrations',
  // `public.migration` is drizzle's bookkeeping table (`id SERIAL PRIMARY KEY`) —
  // a documented single-writer exception to the UUID primary-key invariant; see
  // src/lib/db/AGENTS.md ("Documented exception: public.migration").
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: drizzleDbCredentialsFromEnv(),
})
