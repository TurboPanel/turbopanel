import type { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { getDb, type Db } from '../db/connection.ts'
import { server } from '../db/schema.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { resolvePinnedBy, resolvePinReport } from '../lib/panel-identity/pinned-by.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { registerKeyRotationRoutes } from './key-rotation-routes.ts'

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
            trustPinPasskeys: server.trustPinPasskeys,
          })
          .from(server)
      ).map(({ id, name, organizationId, trustPinPasskeys, ...pin }) => ({
        id,
        name,
        organizationId,
        // Hash of the rotation passkeys the server pinned: "" none yet, null not reported.
        pinPasskeys: trustPinPasskeys ?? null,
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
 * and each server's pinned-by state. Rotation passkeys approve key changes
 * (`key-rotation-routes.ts`).
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

  registerKeyRotationRoutes(admin, {
    secrets: opts.secrets,
    runtime: opts.runtime,
    ...(opts.panelIdentity ? { panelIdentity: opts.panelIdentity } : {}),
    ...(opts.dataEncryption ? { dataEncryption: opts.dataEncryption } : {}),
    ...(opts.onIdentityChanged ? { onIdentityChanged: opts.onIdentityChanged } : {}),
  })
}
