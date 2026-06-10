import type { Hono } from 'hono'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import type { Db } from './db.ts'
import { registerDeveloperRoutesCore } from './developer-routes-core.ts'
import { registerDatabaseRoutes } from './database-routes.ts'
import { EXPO_UI_SERVICE, expoTmuxStatus } from './expo-pty.ts'

/**
 * Full developer console for Deno (includes Drizzle Studio + systemd Expo routes).
 * Workers use {@link registerDeveloperRoutesCore} directly — see workers.ts.
 */
export function registerDeveloperRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; db?: Db },
) {
  const developer = registerDeveloperRoutesCore(app, opts)

  registerDatabaseRoutes(developer)

  developer.get('/expo/status', async (c) => {
    const { running } = await expoTmuxStatus()
    return c.json({ running })
  })

  developer.post('/expo/restart', (c) => {
    if (!EXPO_UI_SERVICE) {
      return c.json(
        {
          ok: false,
          error:
            'expo restart unavailable: TURBOPANEL_UI_SERVICE is not set (run under systemd or configure a managed service)',
        },
        503,
      )
    }

    new Deno.Command('sudo', {
      args: ['systemctl', 'restart', EXPO_UI_SERVICE],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn()

    return c.json({ ok: true })
  })

  return app
}
