import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  colocatedLicenseRevokeError,
  isProtectedColocatedLicenseId,
  resolveProtectedColocatedLicenseIds,
} from '../authn/install-state.ts'
import { createLicense, invalidateLicense, listLicenses, listServersBoundToLicenses } from '../authn/license.ts'
import { assertLicenseInvalidationAllowed } from '../authn/license-lifecycle.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { compatLogInfo } from '../../log-compat.ts'
import { getDb, getDaemonCellRegistry } from '../../db.ts'
import { isDeveloperSurfaceEnabled } from '../../dev-mode.ts'
import { buildLicenseInstallCommand } from '../../lib/daemon-install-command.ts'
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from '../../lib/resolve-public-base-url.ts'
import {
  canReserveServerSeat,
  loadOrgServerCapacity,
  SERVER_CAPACITY_EXCEEDED_ERROR,
} from '../../lib/server-capacity.ts'
import { getOrgId } from '../shared.ts'
import {
  installBaseUrlValidationError,
  isReservedColocatedLicenseName,
  parseLicenseCreateFields,
  reservedColocatedLicenseNameError,
  serializeLicenseListEntry,
  serverCapacityExceededBody,
} from './routes-helpers.ts'

// License create/list/revoke are owner-only. Use the exact owner-only guard so
// an organization manager cannot mint or revoke registration keys.
async function assertBillingOrOrgMember(
  c: Context,
  organizationId: string,
): Promise<Response | null> {
  return assertOrgOwnerOr403(c, 'organization', organizationId)
}

export function registerLicenseRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/licenses', createSessionMiddleware(opts.secrets))
  router.use('/licenses/:id', createSessionMiddleware(opts.secrets))

  router.get('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const licenses = await listLicenses(db, organizationId)
    const protectedIds = await resolveProtectedColocatedLicenseIds(
      db,
      registry,
      organizationId,
    )
    const licenseIds = licenses.map((entry) => entry.id)
    const boundServers = await listServersBoundToLicenses(db, organizationId, licenseIds)
    const boundServerIds = [...boundServers.values()].map((entry) => entry.id)
    const statusRecords = boundServerIds.length > 0 && registry
      ? await loadServerStatusRecords(db, registry, boundServerIds)
      : []
    const statusByServerId = new Map(
      statusRecords.map((record) => [record.serverId, record]),
    )

    return c.json({
      licenses: licenses.map(({ id, name, createdAt }) => {
        const bound = boundServers.get(id)
        const status = bound ? statusByServerId.get(bound.id) : undefined
        return serializeLicenseListEntry({
          id,
          name,
          createdAt,
          revocable: !protectedIds.has(id),
          bound,
          status,
        })
      }),
    })
  })

  router.post('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const rawBody = await c.req.text().catch(() => '')
    const parsedFields = parseLicenseCreateFields(rawBody)
    if (parsedFields === 'invalid') {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const { name, installBaseUrl } = parsedFields

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    // Reserved for the co-located control-plane license (install / disk recovery).
    if (isReservedColocatedLicenseName(name, COLOCATED_SERVER_DISPLAY_NAME)) {
      return c.json(
        {
          error: reservedColocatedLicenseNameError(COLOCATED_SERVER_DISPLAY_NAME),
        },
        400,
      )
    }

    const devSurface = opts.runtime === 'deno' && isDeveloperSurfaceEnabled()
    // The install base URL override is a runtime-agnostic developer convenience
    // (the UI only surfaces it in __DEV__). Parsing an HTTPS override is safe on
    // both Deno and Workers, so don't gate that behind the Deno-only devSurface —
    // that left Workers dev unable to use the override at all. A plaintext
    // `http:` override is only permitted on the developer surface; outside dev it
    // is rejected so a plaintext control-plane URL cannot leak into a managed
    // install command.
    const parsedInstallBaseUrl = parseInstallBaseUrl(installBaseUrl, {
      allowHttp: devSurface,
    })
    if (installBaseUrl?.trim() && !parsedInstallBaseUrl) {
      return c.json(
        {
          error: installBaseUrlValidationError(devSurface),
        },
        400,
      )
    }

    // Seat check before minting: enrolled servers + unconsumed keys count
    // against organization.options.maxServers (null/omitted = unlimited).
    const capacity = await loadOrgServerCapacity(db, organizationId)
    if (!capacity) return c.json({ error: 'Not found' }, 404)
    if (!canReserveServerSeat(capacity)) {
      return c.json(
        serverCapacityExceededBody(capacity, SERVER_CAPACITY_EXCEEDED_ERROR),
        409,
      )
    }

    // The instance does not build daemon release artifacts. In self-hosted dev
    // the operator builds them via the console (daemon `deno task release:package`);
    // Caddy serves whatever is present under the daemon checkout's `dist/`.
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      name,
    })

    const instanceUrl = parsedInstallBaseUrl ?? await resolvePublicBaseUrl(c, opts)
    // Only enable curl -k / TURBOPANEL_INSECURE_TLS for the explicit developer
    // surface (self-signed platform CA). A production HTTPS installBaseUrl
    // override must not force insecure TLS.
    const insecureTls = Boolean(devSurface)
    // Instance-host `/run.sh` is served only by the dev overlay Caddyfile.
    // Production / self-hosted Deno installs curl the CDN and pass TURBOPANEL_HOST.
    const installCommand = buildLicenseInstallCommand({
      runtime: opts.runtime,
      instanceUrl,
      licenseId,
      licenseToken,
      insecureTls,
      useInstanceRunScript: Boolean(devSurface),
    })

    compatLogInfo('auth', 'license created; licenseToken is shown once and not stored in plaintext')

    return c.json({ licenseId, licenseToken, installCommand })
  })

  router.delete('/licenses/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    const id = c.req.param('id')
    const registry = getDaemonCellRegistry(c)
    if (await isProtectedColocatedLicenseId(db, id, registry, organizationId)) {
      return c.json({ error: colocatedLicenseRevokeError() }, 403)
    }

    const billingDenied = await assertLicenseInvalidationAllowed(opts.runtime, id)
    if (billingDenied) return billingDenied

    const invalidated = await invalidateLicense(db, id, organizationId)
    if (!invalidated.ok) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Actively disconnect bound daemons — revoke alone leaves live sockets and
    // unexpired JWTs usable until they naturally expire.
    for (const serverId of invalidated.serverIds) {
      try {
        await registry.getCell(serverId).purge()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `Failed to purge daemon cell after license invalidate for server ${serverId}: ${message}`,
        )
      }
    }

    return c.json({ ok: true as const })
  })
}
