/**
 * Organization CA leaf certificates that need an owner's attention:
 *
 *   GET    /tls/ca/leaves                     due and stale leaves, with their owners
 *   POST   /tls/ca/leaves/:leafId/renew       renew one now
 *   POST   /tls/ca/leaves/:leafId/stale       say nothing is waiting on it
 *   DELETE /tls/ca/leaves/:leafId             forget the tracking record
 *
 * Reads need read access to the organization; every change needs
 * `organization:manage`. Marking stale and deleting can let the previous CA
 * generation be retired while something might still use it, so both ask for a
 * re-authentication when the organization requires it.
 */
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { leaf } from '../../db/schema.ts'
import { recordAudit, type AuditAction } from '../../features/audit/audit-records.ts'
import { loadOrganizationCaSet } from '../../features/tls/organization-ca.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { assertCanReadOr403, requireDbSessionAndOrg } from '../shared.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import {
  deleteLeafRecord,
  LEAF_ATTENTION_LIMIT,
  listLeavesNeedingAttention,
  loadOrganizationLeaf,
  markLeafStaleByOwner,
  reactivateLeaf,
} from './leaf-attention.ts'
import { countLeafHealthForOrganization, renewOneTlsLeaf } from './leaf-renewal-sweep.ts'
import { isTlsUuid } from './routes-helpers.ts'

type LeafScope = {
  db: Db
  organizationId: string
  userId: string
  email: string | null
  leafId: string
}

/** Session, organization, manage permission and a well-formed leaf id, or the refusal. */
async function manageScope(c: Context<AppEnv>): Promise<LeafScope | Response> {
  const sessionOrg = await requireDbSessionAndOrg(c)
  if (sessionOrg instanceof Response) return sessionOrg
  const { db, session, organizationId } = sessionOrg
  const denied = await assertCanOr403(c, 'organization:manage', 'organization', organizationId)
  if (denied) return denied
  const leafId = c.req.param('leafId') ?? ''
  if (!isTlsUuid(leafId)) return c.json({ error: 'Not found' }, 404)
  return { db, organizationId, userId: session.userId, email: session.email ?? null, leafId }
}

async function audit(
  scope: LeafScope,
  action: AuditAction,
  context: Record<string, unknown>
): Promise<void> {
  await recordAudit(scope.db, {
    organizationId: scope.organizationId,
    actorUserId: scope.userId,
    actorEmail: scope.email,
    action,
    targetType: 'organization',
    targetId: scope.organizationId,
    context: { leafId: scope.leafId, ...context },
  })
}

export function registerTlsLeafRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for tls routes')
  }
  const session = createSessionMiddleware(opts.secrets)
  router.use('/tls/ca/leaves', session)
  router.use('/tls/ca/leaves/*', session)

  router.get('/tls/ca/leaves', async (c) => {
    const sessionOrg = await requireDbSessionAndOrg(c)
    if (sessionOrg instanceof Response) return sessionOrg
    const { db, organizationId } = sessionOrg
    const denied = await assertCanReadOr403(c, 'organization', organizationId)
    if (denied) return denied

    const active = await loadOrganizationCaSet(db, organizationId)
    if (!active) return c.json({ error: 'Not found' }, 404)
    const activeGeneration = active.signer.caGeneration
    const [leaves, health] = await Promise.all([
      listLeavesNeedingAttention(db, organizationId, { activeGeneration }),
      countLeafHealthForOrganization(db, organizationId, { activeCaGeneration: activeGeneration }),
    ])
    return c.json({
      leaves,
      dueCount: health.dueCount,
      staleCount: health.staleCount,
      caGeneration: activeGeneration,
      truncated: health.dueCount + health.staleCount > LEAF_ATTENTION_LIMIT,
    })
  })

  router.post('/tls/ca/leaves/:leafId/renew', async (c) => {
    const scope = await manageScope(c)
    if (scope instanceof Response) return scope
    const { db, organizationId, leafId } = scope

    const row = await loadOrganizationLeaf(db, organizationId, leafId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue
    const secretsConfig = c.get('secretsConfig')
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!secretsConfig || !dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }

    if (row.state === 'stale') await reactivateLeaf(db, organizationId, leafId)
    const outcome = await renewOneTlsLeaf(
      c,
      db,
      commandQueue,
      { secretsConfig, dataEncryptionSecrets },
      {
        id: row.id,
        organizationId: row.organizationId,
        serverId: row.serverId,
        kind: row.kind,
        managedId: row.managedId,
        replicaId: row.replicaId,
        caGeneration: row.caGeneration,
        notAfter: row.notAfter,
        attempts: row.attempts,
        serverConnected: row.serverConnected,
        serverStatusChangedAt: row.serverStatusChangedAt,
      },
      { ingress: new Set<string>(), managed: new Set<string>() },
      { skipOfflineCheck: true }
    )
    await audit(scope, 'tls.leaf.renew', { outcome })

    const [after] = await db
      .select({ lastError: leaf.lastError, state: leaf.state, staleReason: leaf.staleReason })
      .from(leaf)
      .where(eq(leaf.id, leafId))
      .limit(1)
    return c.json({
      ok: true as const,
      outcome: outcome === 'enqueued' ? 'queued' : outcome,
      reason: after?.state === 'stale' ? after.staleReason : (after?.lastError ?? null),
    })
  })

  router.post('/tls/ca/leaves/:leafId/stale', async (c) => {
    const scope = await manageScope(c)
    if (scope instanceof Response) return scope
    const stepUp = await requireStepUpIfConfigured(c, scope.organizationId, 'tls.leaf.stale')
    if (stepUp) return stepUp

    const marked = await markLeafStaleByOwner(scope.db, scope.organizationId, scope.leafId)
    if (!marked) {
      const exists = await loadOrganizationLeaf(scope.db, scope.organizationId, scope.leafId)
      if (!exists) return c.json({ error: 'Not found' }, 404)
    }
    await audit(scope, 'tls.leaf.stale', {})
    return c.json({ ok: true as const })
  })

  router.delete('/tls/ca/leaves/:leafId', async (c) => {
    const scope = await manageScope(c)
    if (scope instanceof Response) return scope
    const stepUp = await requireStepUpIfConfigured(c, scope.organizationId, 'tls.leaf.delete')
    if (stepUp) return stepUp

    const removed = await deleteLeafRecord(scope.db, scope.organizationId, scope.leafId)
    if (!removed) return c.json({ error: 'Not found' }, 404)
    await audit(scope, 'tls.leaf.delete', {})
    return c.json({ ok: true as const })
  })
}
