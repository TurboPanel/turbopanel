import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app/app.ts'

export type PlatformAdminRoutesRegistrar = (
  admin: Hono<AppEnv>,
  deps: { rootOnly: MiddlewareHandler<AppEnv> }
) => void

/**
 * The admin registrar `startDenoServer` hands to `registerAdminRoutes`: the
 * self-hosted routes always, plus the development-only routes (Build and Push
 * Daemon) when the developer surface is on and the development entry supplied
 * them. Otherwise those routes are never mounted, so they answer 404.
 */
export function withDevelopmentAdminRoutes(
  base: PlatformAdminRoutesRegistrar,
  developerSurface: boolean,
  development?: PlatformAdminRoutesRegistrar
): PlatformAdminRoutesRegistrar {
  return (admin, deps) => {
    base(admin, deps)
    if (developerSurface) development?.(admin, deps)
  }
}
