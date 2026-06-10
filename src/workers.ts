import type { Hono } from 'hono'
import { createApp } from './app'
import { createWorkersDb } from './db'
import { registerDeveloperRoutesCore } from './developer-routes-core.ts'

let cachedApp: ReturnType<typeof createApp> | null = null

function workerApp(env: CloudflareBindings) {
  if (!cachedApp) {
    const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
    cachedApp = createApp({
      db,
      sessionSecret: env.SESSION_SECRET,
      runtime: 'workers',
    })
    registerDeveloperRoutesCore(cachedApp as unknown as Hono, {
      sessionSecret: env.SESSION_SECRET,
      db,
    })
  }
  return cachedApp
}

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!env.SESSION_SECRET) {
      throw new Error(
        'SESSION_SECRET binding is required — add to .dev.vars for local Wrangler dev or wrangler secret put for production',
      )
    }
    return workerApp(env).fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
