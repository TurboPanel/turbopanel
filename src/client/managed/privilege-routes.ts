/**
 * Permission grid reads (no writes):
 *
 * - `GET /environments/:id/managed/privilege-catalogue` — every privilege the
 *   cluster's exact engine series supports, in plain words, with whether a
 *   site owner's login may hold it. Nothing outside the supported series is
 *   ever listed.
 * - `GET /environments/:id/managed/users/:principalId/effective-permissions` —
 *   what the engine says the login can do right now, read from the host over
 *   the cell and joined to the catalogue. Everything is `observed`: the panel
 *   keeps no ledger of its own grants yet.
 *
 * Kept apart from `routes.ts` so the users handlers there stay untouched.
 * Design: `features/managed/privileges/DESIGN.md`.
 */
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDaemonCellRegistry, getDb } from '../../db/connection.ts'
import { managed } from '../../db/schema.ts'
import { ingressEngineVersionFromOptions } from '../../features/managed/ingress-desired-pure.ts'
import { findManagedLogin } from '../../features/managed/logins.ts'
import { parseManagedRowOptions } from '../../features/managed/options.ts'
import { privilegeCatalogueFor } from '../../features/managed/privileges/catalogue.ts'
import {
  buildEffectivePermissions,
  reportMatchesSeries,
} from '../../features/managed/privileges/effective.ts'
import {
  authorizeManagedRequest,
  loadManagedContext,
  resolveManagedTargetServerId,
} from './context.ts'
import {
  MANAGED_PERMISSIONS_PROBE_TIMEOUT_MS,
  probeManagedPermissions,
} from './permissions-probe.ts'

const UNSUPPORTED_VERSION_BODY = {
  error: 'privilege_catalogue_unsupported_version',
  message:
    'Permissions cannot be shown for this database version. Only versions the panel supports are listed.',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Databases a login is placed on, as recorded on the login. */
function loginDatabases(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.databases)) return []
  return metadata.databases.filter((entry): entry is string => typeof entry === 'string')
}

async function loadCatalogueScope(c: Context<AppEnv>, mode: 'read' | 'manage') {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const environmentId = c.req.param('id') ?? ''
  const auth = await authorizeManagedRequest(c, db, environmentId, mode)
  if (auth instanceof Response) return auth
  const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
  if (ctx instanceof Response) return ctx

  const [row] = await db
    .select({ id: managed.id, options: managed.options, serverId: managed.serverId })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const series = ingressEngineVersionFromOptions(ctx.spec, row.options)
  const catalogue = series ? privilegeCatalogueFor(ctx.spec.engine, series) : undefined
  if (!catalogue) return c.json(UNSUPPORTED_VERSION_BODY, 422)
  return { db, ctx, row, catalogue }
}

/** Session middleware for these paths comes from `managedSessionPaths()`. */
export function registerManagedPrivilegeRoutes(router: Hono<AppEnv>) {
  router.get('/environments/:id/managed/privilege-catalogue', async (c) => {
    const scope = await loadCatalogueScope(c, 'read')
    if (scope instanceof Response) return scope
    return c.json(scope.catalogue)
  })

  router.get('/environments/:id/managed/users/:principalId/effective-permissions', async (c) => {
    const scope = await loadCatalogueScope(c, 'manage')
    if (scope instanceof Response) return scope
    const { db, ctx, row, catalogue } = scope

    const target = await findManagedLogin(db, row.id, c.req.param('principalId') ?? '')
    if (!target || target.role !== 'user') return c.json({ error: 'Not found' }, 404)

    // Reads go to the primary: it is the host that holds the writable copy.
    const serverId = resolveManagedTargetServerId(c, row.serverId)
    if (serverId instanceof Response) return serverId

    const placed = loginDatabases(target.metadata)
    const databases =
      placed.length > 0 ? placed : (parseManagedRowOptions(ctx.spec, row.options)?.databases ?? [])
    const outcome = await probeManagedPermissions(db, getDaemonCellRegistry(c), {
      serverId,
      managedId: row.id,
      engine: ctx.spec.engine,
      logins: [target.appliedUsername],
      databases,
      timeoutMs: MANAGED_PERMISSIONS_PROBE_TIMEOUT_MS,
    })

    if (outcome.status === 'unsupported') {
      return c.json(
        {
          error: 'daemon_update_required',
          message:
            'This server needs a newer TurboPanel version before it can show permissions. Update the server and try again.',
        },
        409
      )
    }
    if (outcome.status === 'unavailable') {
      if (outcome.reason === 'offline') return c.json({ error: 'server_offline' }, 409)
      return c.json(
        {
          error: 'permissions_read_failed',
          reason: outcome.reason,
          message: 'The server did not answer in time. Try again in a moment.',
        },
        outcome.reason === 'timeout' ? 504 : 502
      )
    }

    const report = outcome.permissions
    const observed = report.logins.find((entry) => entry.username === target.appliedUsername)
    if (!observed) {
      return c.json(
        {
          error: 'permissions_read_failed',
          reason: 'invalid_result',
          message: 'The server answered without this login.',
        },
        502
      )
    }
    return c.json({
      ...buildEffectivePermissions(catalogue, report, observed),
      databases: databases,
      versionMatchesCatalogue: reportMatchesSeries(report.serverVersion, catalogue.series),
    })
  })
}
