import type { Hono } from 'hono'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './auth/secrets.ts'
import { createApp } from './app'
import { createWorkersDb } from './db'
import { registerDeveloperRoutesCore } from './developer-routes-core.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSecrets: DerivedSecretsConfig | null = null

async function initWorkerApp(env: CloudflareBindings) {
  const secretsConfig = parseSecretsEnv(env.SESSION_SECRET, env.SESSION_SECRETS, 'workers')
  cachedSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
  cachedApp = createApp({ db, secrets: cachedSecrets, runtime: 'workers' })
  registerDeveloperRoutesCore(cachedApp as unknown as Hono, {
    secrets: cachedSecrets,
    db,
  })
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!initPromise) initPromise = initWorkerApp(env)
    await initPromise
    return cachedApp!.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
