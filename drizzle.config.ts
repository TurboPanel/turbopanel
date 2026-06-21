import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.TURBOPANEL_DATABASE_URL ??
      (() => {
        throw new Error('TURBOPANEL_DATABASE_URL is required')
      })(),
  },
})
