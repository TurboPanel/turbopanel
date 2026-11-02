import type { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import { requireInstanceStepUp } from '../client/authn/step-up.ts'
import { getDb, type Db } from '../db/connection.ts'
import { server } from '../db/schema.ts'
import { recordKeyEvent } from '../features/notifications/key-event.ts'
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
          .select({ id: server.id, name: server.name, organizationId: server.organizationId })
          .from(server)
      ).map((row) => ({ ...row, pinnedBy: resolvePinnedBy(row) }))
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
