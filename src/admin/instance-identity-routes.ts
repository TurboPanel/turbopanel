import type { Context, Hono } from 'hono'
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
import {
  listSealedSecretsState,
  readSealingKeyClearTarget,
} from '../features/servers/daemon-sealing-key.ts'
import { clearDaemonSealingKey } from '../features/servers/server-identity-db.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { resolvePinnedBy, resolvePinReport } from '../lib/panel-identity/pinned-by.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { registerKeyRotationRoutes } from './key-rotation-routes.ts'

export const NEXT_KEY_RETIRED_ERROR = 'next_key_retired'
export const NEXT_KEY_RETIRED_MESSAGE =
  'The next key is retired. Approve key changes with rotation passkeys on Control Plane Identity.'

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
            trustPinFingerprint: server.trustPinFingerprint,
            trustPinKeyset: server.trustPinKeyset,
            trustPinReportedAt: server.trustPinReportedAt,
            isTrustPinMatching: server.isTrustPinMatching,
          })
          .from(server)
      ).map(({ id, name, organizationId, ...pin }) => ({
        id,
        name,
        organizationId,
        pinnedBy: resolvePinnedBy(pin),
        pinReport: resolvePinReport(pin),
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

/**
 * `GET /instance/identity`: the control plane's current and next fingerprints
 * and each server's pinned-by state. `PUT /instance/identity/next` answers 410:
 * the next key is retired, rotation passkeys approve key changes
 * (`key-rotation-routes.ts`).
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
    /** Self-hosted: the data-encryption key the identity seeds are sealed under. */
    dataEncryption?: DerivedSecretsConfig
    /** Self-hosted composition root: reload the in-memory identity after a key change. */
    onIdentityChanged?: () => Promise<void>
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

  // The offline next key is retired: key changes are approved with rotation
  // passkeys (`key-rotation-routes.ts`).
  admin.put('/instance/identity/next', createRootOnlyMiddleware(opts.secrets), (c) =>
    c.json({ ok: false, error: NEXT_KEY_RETIRED_ERROR, message: NEXT_KEY_RETIRED_MESSAGE }, 410)
  )

  registerKeyRotationRoutes(admin, {
    secrets: opts.secrets,
    runtime: opts.runtime,
    ...(opts.panelIdentity ? { panelIdentity: opts.panelIdentity } : {}),
    ...(opts.dataEncryption ? { dataEncryption: opts.dataEncryption } : {}),
    ...(opts.onIdentityChanged ? { onIdentityChanged: opts.onIdentityChanged } : {}),
  })
}

export const CLEAR_SEALING_KEY_CONFIRM_MESSAGE = 'Type the server name to clear its sealing key.'
export const DAEMON_SEALS_SECRETS_ERROR = 'daemon_seals_secrets'

function daemonSealsSecrets(c: Context<AppEnv>): Response {
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
      if (target.connectedDaemonSealsSecrets) return daemonSealsSecrets(c)
      const stepUp = await requireInstanceStepUp(c, 'server.sealing_key.clear')
      if (stepUp) return stepUp
      const cleared = await clearDaemonSealingKey(db, target.id, target.kid)
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
      } else {
        // A current daemon connected, or a new key was registered, after the
        // read: answer as the read would now.
        const now = await readSealingKeyClearTarget(db, target.id)
        if (now?.connectedDaemonSealsSecrets) return daemonSealsSecrets(c)
      }
      return c.json({ ok: true, cleared })
    }
  )
}
