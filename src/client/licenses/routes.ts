import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  colocatedLicenseRevokeError,
  isProtectedColocatedLicenseId,
  resolveProtectedColocatedLicenseIds,
} from '../authn/install-state.ts'
import { createLicense, invalidateLicense, listLicenses, listServersBoundToLicenses } from '../authn/license.ts'
import { assertLicenseInvalidationAllowed } from '../authn/license-lifecycle.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { compatLogInfo } from '../../log-compat.ts'
import { getDb, getDaemonCellRegistry } from '../../db.ts'
import { isDeveloperSurfaceEnabled } from '../../dev-mode.ts'
import { buildLicenseInstallCommand } from '../../lib/daemon-install-command.ts'
import {
  parseInstallBaseUrl,
  resolvePublicBaseUrl,
} from '../../lib/resolve-public-base-url.ts'
import { getOrgId } from '../shared.ts'

async function assertBillingOrOrgMember(
  c: Context,
  organizationId: string,
): Promise<Response | null> {
  return assertCanOr403(c, 'organization:own', 'organization', organizationId)
}

type LicenseCreateFields = {
  displayName?: string
  installBaseUrl?: string
}

function parseLicenseCreateFields(
  rawBody: string,
): LicenseCreateFields | 'invalid' {
  if (!rawBody.trim()) {
    return {}
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return 'invalid'
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }

  const record = body as Record<string, unknown>
  const fields: LicenseCreateFields = {}

  if (record.displayName !== undefined) {
    if (typeof record.displayName !== 'string') {
      return 'invalid'
    }
    fields.displayName = record.displayName
  }
  if (record.installBaseUrl !== undefined) {
    if (typeof record.installBaseUrl !== 'string') {
      return 'invalid'
    }
    fields.installBaseUrl = record.installBaseUrl
  }

  return fields
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
      licenses: licenses.map(({ id, displayName, createdAt }) => {
        const bound = boundServers.get(id)
        const status = bound ? statusByServerId.get(bound.id) : undefined
        return {
          id,
          displayName,
          createdAt,
          revocable: !protectedIds.has(id),
          boundServer: bound
            ? {
              id: bound.id,
              displayName: bound.displayName,
              connected: status?.connected ?? false,
            }
            : null,
        }
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
    const { displayName, installBaseUrl } = parsedFields

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

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
          error: devSurface
            ? 'installBaseUrl must be a valid http(s) URL'
            : 'installBaseUrl must be a valid https URL',
        },
        400,
      )
    }

    // The instance does not build daemon release artifacts. In self-hosted dev
    // the operator builds them via the console (daemon `deno task release:package`);
    // Caddy serves whatever is present under the daemon checkout's `dist/`.
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName,
    })

    const instanceUrl = parsedInstallBaseUrl ?? await resolvePublicBaseUrl(c, opts)
    const insecureTls = devSurface || parsedInstallBaseUrl != null
    const installCommand = buildLicenseInstallCommand({
      runtime: opts.runtime,
      instanceUrl,
      licenseId,
      licenseToken,
      insecureTls,
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
    if (!invalidated) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })
}
