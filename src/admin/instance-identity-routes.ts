import type { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import { isUuid } from '../client/access/routes-helpers.ts'
import { requireInstanceStepUp } from '../client/authn/step-up.ts'
import {
  CONFIRM_NAME_REQUIRED_ERROR,
  confirmationName,
  confirmNameMatches,
} from '../client/confirm-name.ts'
import { getDb, type Db } from '../db/connection.ts'
import { server } from '../db/schema.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { recordKeyEvent } from '../features/notifications/key-event.ts'
import {
  listSealedSecretsState,
  readSealingKeyClearTarget,
} from '../features/servers/daemon-sealing-key.ts'
import { clearDaemonSealingKey } from '../features/servers/server-identity-db.ts'
import { isPanelFingerprint } from '../lib/panel-identity/fingerprint.ts'
import { type PanelIdentity, setPanelIdentityNext } from '../lib/panel-identity/identity.ts'
import { resolvePinnedBy } from '../lib/panel-identity/pinned-by.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'

export const WORKERS_NEXT_KEY_MESSAGE =
  'the next key is set through the TURBOPANEL_IDENTITY_KEYS binding'

/** Public values only: fingerprints, never key material. */
async function readIdentity(
  db: Db | undefined,
  identity: PanelIdentity | null,
  identityUrls: ((db: Db) => Promise<string[]>) | undefined
) {
  const urls = db && identityUrls ? await identityUrls(db) : []
  const servers = db
    ? (
        await db
          .select({
            id: server.id,
            name: server.name,
            organizationId: server.organizationId,
            trustPinnedBy: server.trustPinnedBy,
          })
          .from(server)
      ).map(({ trustPinnedBy, ...row }) => ({
        ...row,
        pinnedBy: resolvePinnedBy({ trustPinnedBy }),
      }))
    : []
  return {
    ok: true as const,
    configured: identity !== null,
    current: identity ? { fingerprint: identity.current.kid, keyset: identity.keyset } : null,
    next: identity?.next ? { fingerprint: identity.next.kid } : null,
    seal: identity ? { fingerprint: identity.seal.kid } : null,
    urls,
    installUrl: urls[0] ?? null,
    servers,
  }
}

function parseNextBody(body: unknown): { ok: true; fingerprint: string | null } | { ok: false } {
  if (typeof body !== 'object' || body === null || !('fingerprint' in body)) return { ok: false }
  const fingerprint = body.fingerprint
  if (fingerprint === null) return { ok: true, fingerprint }
  if (typeof fingerprint === 'string' && isPanelFingerprint(fingerprint)) {
    return { ok: true, fingerprint }
  }
  return { ok: false }
}

/**
 * `GET /instance/identity`: the control plane's current and next fingerprints
 * and each server's pinned-by state. `PUT /instance/identity/next`: set or
 * clear the next fingerprint (superadmin, self-hosted only, step-up).
 * `GET /instance/identity/sealed-secrets`: per server, whether secrets still
 * reach it in plaintext (superadmin; read by the edge go-live gate).
 * `DELETE /instance/identity/sealed-secrets/:serverId/key`: Clear Sealing Key,
 * see {@link registerClearSealingKeyRoute}.
 */
export function registerInstanceIdentityAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    secrets: DerivedSecretsConfig
    runtime: 'deno' | 'workers'
    panelIdentity?: () => Promise<PanelIdentity | null>
    identityUrls?: (db: Db) => Promise<string[]>
    /** Self-hosted composition root: swap the in-memory identity so the served document follows. */
    onNextChanged?: (fingerprint: string | null) => void
  }
): void {
  admin.get('/instance/identity', async (c) => {
    const identity = opts.panelIdentity ? await opts.panelIdentity() : null
    return c.json(await readIdentity(getDb(c), identity, opts.identityUrls))
  })

  admin.get(
    '/instance/identity/sealed-secrets',
    createRootOnlyMiddleware(opts.secrets),
    async (c) => {
      const db = getDb(c)
      if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
      const servers = await listSealedSecretsState(db)
      return c.json({
        ok: true,
        receivingPlaintext: servers.filter((entry) => entry.receivesPlaintext).length,
        servers,
      })
    }
  )

  registerClearSealingKeyRoute(admin, opts.secrets)

  admin.put('/instance/identity/next', createRootOnlyMiddleware(opts.secrets), async (c) => {
    if (opts.runtime === 'workers') {
      return c.json({ ok: false, error: WORKERS_NEXT_KEY_MESSAGE }, 422)
    }
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const parsed = parseNextBody(await c.req.json().catch(() => null))
    if (!parsed.ok) {
      return c.json({ ok: false, error: 'expected { fingerprint: string | null }' }, 422)
    }
    const stepUp = await requireInstanceStepUp(c, 'panel.identity_next.set')
    if (stepUp) return stepUp
    try {
      await setPanelIdentityNext(db, parsed.fingerprint)
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'invalid' }, 422)
    }
    opts.onNextChanged?.(parsed.fingerprint)
    const session = c.get('session')
    await recordKeyEvent(c, {
      organizationId: null,
      actorUserId: session?.userId ?? null,
      actorEmail: session?.email ?? null,
      action: parsed.fingerprint ? 'panel.identity_next.set' : 'panel.identity_next.clear',
      targetType: 'instance',
      context: parsed.fingerprint ? { fingerprint: parsed.fingerprint } : { cleared: true },
    })
    return c.json({
      ok: true,
      next: parsed.fingerprint ? { fingerprint: parsed.fingerprint } : null,
    })
  })
}

export const CLEAR_SEALING_KEY_CONFIRM_MESSAGE = 'Type the server name to clear its sealing key.'
export const DAEMON_SEALS_SECRETS_ERROR = 'daemon_seals_secrets'

/**
 * Clear Sealing Key: the recovery for a host rolled back (break glass) to a
 * daemon build without sealed secrets, which cannot open the sealed answers
 * the control plane sends once a key is on file. Superadmin, the server's
 * name typed back as `?confirmName`, step-up, audited. Refused (409) while
 * the server is connected with a hello that lists sealed secrets: that daemon
 * can open sealed answers and would refuse the plaintext a clear brings. A
 * server with no key on file answers `{ cleared: false }` and changes nothing.
 */
function registerClearSealingKeyRoute(admin: Hono<AppEnv>, secrets: DerivedSecretsConfig): void {
  admin.delete(
    '/instance/identity/sealed-secrets/:serverId/key',
    createRootOnlyMiddleware(secrets),
    async (c) => {
      const db = getDb(c)
      if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
      const serverId = c.req.param('serverId')
      const target = isUuid(serverId) ? await readSealingKeyClearTarget(db, serverId) : null
      if (!target) return c.json({ ok: false, error: 'Not found' }, 404)
      const expected = confirmationName(target.name, target.hostname, target.id)
      if (!confirmNameMatches(c.req.query('confirmName'), expected)) {
        return c.json(
          {
            ok: false,
            error: CONFIRM_NAME_REQUIRED_ERROR,
            message: CLEAR_SEALING_KEY_CONFIRM_MESSAGE,
          },
          400
        )
      }
      if (target.kid === null) return c.json({ ok: true, cleared: false })
      if (target.connectedDaemonSealsSecrets) {
        return c.json(
          {
            ok: false,
            error: DAEMON_SEALS_SECRETS_ERROR,
            message:
              'The connected daemon opens sealed secrets; clear the key only for a server rolled back to an older daemon.',
          },
          409
        )
      }
      const stepUp = await requireInstanceStepUp(c, 'server.sealing_key.clear')
      if (stepUp) return stepUp
      const cleared = await clearDaemonSealingKey(db, target.id)
      if (cleared) {
        const session = c.get('session')
        await recordAudit(db, {
          organizationId: target.organizationId,
          actorUserId: session?.userId ?? null,
          actorEmail: session?.email ?? null,
          action: 'server.sealing_key.clear',
          targetType: 'server',
          targetId: target.id,
          context: { kid: target.kid },
        })
      }
      return c.json({ ok: true, cleared })
    }
  )
}
