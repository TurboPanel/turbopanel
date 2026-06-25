import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  colocatedLicenseRevokeError,
  isProtectedColocatedLicenseId,
  resolveProtectedColocatedLicenseIds,
} from '../authn/install-state.ts'
import { createLicense, listLicenses, revokeLicense } from '../authn/license.ts'
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

async function assertBillingOrOrgMember(
  c: Context,
  organizationId: string,
): Promise<Response | null> {
  return assertCanOr403(c, 'organization:own', 'organization', organizationId)
}

export function registerLicenseRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/licenses', createSessionMiddleware(opts.secrets))
  router.use('/licenses/:id', createSessionMiddleware(opts.secrets))

  router.get('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ licenses: [] })
    }

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const licenses = await listLicenses(db, organizationId)
    const protectedIds = await resolveProtectedColocatedLicenseIds(
      db,
      registry,
      organizationId,
    )

    return c.json({
      licenses: licenses.map(({ id, displayName, createdAt }) => ({
        id,
        displayName,
        createdAt,
        revocable: !protectedIds.has(id),
      })),
    })
  })

  router.post('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    let displayName: string | undefined
    let installBaseUrl: string | undefined
    const rawBody = await c.req.text().catch(() => '')
    if (rawBody.trim()) {
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>
        if (record.displayName !== undefined) {
          if (typeof record.displayName !== 'string') {
            return c.json({ error: 'Invalid request' }, 400)
          }
          displayName = record.displayName
        }
        if (record.installBaseUrl !== undefined) {
          if (typeof record.installBaseUrl !== 'string') {
            return c.json({ error: 'Invalid request' }, 400)
          }
          installBaseUrl = record.installBaseUrl
        }
      } else {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ error: 'No organization' }, 400)
    }

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    const devSurface = opts.runtime === 'deno' && isDeveloperSurfaceEnabled()
    // The install base URL override is a runtime-agnostic developer convenience
    // (the UI only surfaces it in __DEV__). Parsing is safe on both Deno and
    // Workers, so don't gate it behind the Deno-only devSurface — that left
    // Workers dev unable to use the override at all.
    const parsedInstallBaseUrl = parseInstallBaseUrl(installBaseUrl)
    if (installBaseUrl !== undefined && installBaseUrl.trim() && !parsedInstallBaseUrl) {
      return c.json({ error: 'installBaseUrl must be a valid http(s) URL' }, 400)
    }

    // The instance does not build daemon release artifacts. In self-hosted dev
    // the operator builds them via the console (daemon `deno task release:package`);
    // Caddy serves whatever is present under the daemon checkout's `dist/`.
    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName,
    })

    const instanceUrl = parsedInstallBaseUrl ?? await resolvePublicBaseUrl(c, opts)
    const devRunScript = devSurface || parsedInstallBaseUrl != null
    const installCommand = buildLicenseInstallCommand({
      runtime: opts.runtime,
      instanceUrl,
      licenseId,
      licenseToken,
      devRunScript,
      insecureTls: devRunScript,
    })

    compatLogInfo('auth', 'license created; licenseToken is shown once and not stored in plaintext')

    return c.json({ licenseId, licenseToken, installCommand })
  })

  router.delete('/licenses/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertBillingOrOrgMember(c, organizationId)
    if (denied) return denied

    const id = c.req.param('id')
    const registry = getDaemonCellRegistry(c)
    if (await isProtectedColocatedLicenseId(db, id, registry, organizationId)) {
      return c.json({ error: colocatedLicenseRevokeError() }, 403)
    }

    const revoked = await revokeLicense(db, id, organizationId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })
}
