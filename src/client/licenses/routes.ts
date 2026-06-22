import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createLicense, listLicenses, revokeLicense } from '../authn/license.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { compatLogInfo } from '../../log-compat.ts'
import { getDb } from '../../db.ts'
import { buildLicenseInstallCommand } from '../../lib/daemon-install-command.ts'

async function assertBillingOrOrgMember(
  c: Context,
  organizationId: string,
): Promise<Response | null> {
  return assertCanOr403(c, 'organization:billing', 'organization', organizationId)
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

    const licenses = await listLicenses(db, organizationId)
    return c.json({
      licenses: licenses.map(({ id, displayName, createdAt }) => ({
        id,
        displayName,
        createdAt,
      })),
    })
  })

  router.post('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    let displayName: string | undefined
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

    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName,
    })

    const origin = new URL(c.req.url).origin
    const installCommand = buildLicenseInstallCommand({
      runtime: opts.runtime,
      origin,
      licenseId,
      licenseToken,
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
    const revoked = await revokeLicense(db, id, organizationId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })
}
