import { createApp } from './app'
import { createWorkersDb } from './db'

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
    const app = createApp({ db })
    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
