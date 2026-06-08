import { createApp } from './app'
import { createWorkersDb } from './db'

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!env.SESSION_SECRET) {
      throw new Error(
        'SESSION_SECRET binding is required — add to .dev.vars for local Wrangler dev or wrangler secret put for production',
      )
    }
    const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
    const app = createApp({
      db,
      sessionSecret: env.SESSION_SECRET,
      runtime: 'workers',
    })
    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
