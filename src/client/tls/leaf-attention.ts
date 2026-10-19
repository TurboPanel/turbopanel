/**
 * The Organization CA leaf certificates an owner has to look at: the ones due
 * for renewal (still on an older CA generation, or close to expiry) and the
 * ones marked stale. Each is listed with what it belongs to (a server, a
 * database cluster and the environment and project it lives in), why it is
 * listed, and the last thing that went wrong, so nothing is a bare number.
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, leaf, managed, project, server } from '../../db/schema.ts'
import { LEAF_STALE_BY_OWNER, clipLeafText } from '../../features/tls/leaf-vocabulary.ts'
import { leafRenewalDeadlineIso } from './leaf-renewal-sweep.ts'

/** Most leaves one listing returns. */
export const LEAF_ATTENTION_LIMIT = 100

export type LeafAttentionState = 'due' | 'stale'

export type LeafAttentionItem = {
  id: string
  kind: 'ingress' | 'engine'
  state: LeafAttentionState
  /** Plain words: why this certificate is listed. */
  reason: string
  serverId: string
  serverName: string | null
  managedId: string | null
  managedName: string | null
  environmentId: string | null
  environmentName: string | null
  projectName: string | null
  caGeneration: number
  notAfter: string
  issuedAt: string
  attempts: number
  attemptedAt: string | null
  lastError: string | null
  staleAt: string | null
  staleReason: string | null
}

function whyListed(params: {
  state: LeafAttentionState
  caGeneration: number
  activeGeneration: number
  notAfter: string
  nowMs: number
}): string {
  if (params.state === 'stale') return 'Marked stale: nothing is waiting on it.'
  if (params.caGeneration !== params.activeGeneration) {
    return 'Still signed by a previous Organization CA generation.'
  }
  if (Date.parse(params.notAfter) < params.nowMs) return 'The certificate has expired.'
  return 'The certificate expires soon.'
}

/**
 * Due or stale leaves of one organization, due first (soonest expiry first),
 * with their owners resolved by name.
 */
export async function listLeavesNeedingAttention(
  db: Db,
  organizationId: string,
  params: { activeGeneration: number; nowMs?: number; limit?: number }
): Promise<LeafAttentionItem[]> {
  const nowMs = params.nowMs ?? Date.now()
  const deadlineIso = leafRenewalDeadlineIso(nowMs)
  const rows = await db
    .select({
      id: leaf.id,
      kind: leaf.kind,
      state: leaf.state,
      serverId: leaf.serverId,
      serverName: server.name,
      serverHostname: server.hostname,
      managedId: leaf.managedId,
      managedName: managed.name,
      environmentId: environment.id,
      environmentName: environment.name,
      projectName: project.name,
      caGeneration: leaf.caGeneration,
      notAfter: leaf.notAfter,
      issuedAt: leaf.issuedAt,
      attempts: leaf.attempts,
      attemptedAt: leaf.attemptedAt,
      lastError: leaf.lastError,
      staleAt: leaf.staleAt,
      staleReason: leaf.staleReason,
    })
    .from(leaf)
    .leftJoin(server, eq(server.id, leaf.serverId))
    .leftJoin(managed, eq(managed.id, leaf.managedId))
    .leftJoin(environment, eq(environment.id, managed.environmentId))
    .leftJoin(project, eq(project.id, environment.projectId))
    .where(
      and(
        eq(leaf.organizationId, organizationId),
        sql`(${leaf.state} = 'stale' OR ${leaf.notAfter} < ${deadlineIso}::timestamptz OR ${leaf.caGeneration} IS DISTINCT FROM ${params.activeGeneration})`
      )
    )
    .orderBy(asc(leaf.state), asc(leaf.notAfter), asc(leaf.id))
    .limit(params.limit ?? LEAF_ATTENTION_LIMIT)

  return rows.map((row) => {
    const state: LeafAttentionState = row.state === 'stale' ? 'stale' : 'due'
    return {
      id: row.id,
      kind: row.kind === 'engine' ? 'engine' : 'ingress',
      state,
      reason: whyListed({
        state,
        caGeneration: row.caGeneration,
        activeGeneration: params.activeGeneration,
        notAfter: row.notAfter,
        nowMs,
      }),
      serverId: row.serverId,
      serverName: row.serverName?.trim() || row.serverHostname?.trim() || null,
      managedId: row.managedId,
      managedName: row.managedName,
      environmentId: row.environmentId,
      environmentName: row.environmentName,
      projectName: row.projectName,
      caGeneration: row.caGeneration,
      notAfter: row.notAfter,
      issuedAt: row.issuedAt,
      attempts: row.attempts,
      attemptedAt: row.attemptedAt,
      lastError: row.lastError,
      staleAt: row.staleAt,
      staleReason: row.staleReason,
    }
  })
}

/** One leaf of the organization (the routes never touch another organization's row). */
export async function loadOrganizationLeaf(
  db: Db,
  organizationId: string,
  leafId: string
): Promise<{
  id: string
  organizationId: string
  serverId: string
  kind: string
  managedId: string | null
  replicaId: string | null
  caGeneration: number
  notAfter: string
  attempts: number
  state: string
  serverConnected: boolean | null
  serverStatusChangedAt: string | null
} | null> {
  const [row] = await db
    .select({
      id: leaf.id,
      organizationId: leaf.organizationId,
      serverId: leaf.serverId,
      kind: leaf.kind,
      managedId: leaf.managedId,
      replicaId: leaf.replicaId,
      caGeneration: leaf.caGeneration,
      notAfter: leaf.notAfter,
      attempts: leaf.attempts,
      state: leaf.state,
      serverConnected: server.isConnected,
      serverStatusChangedAt: server.statusChangedAt,
    })
    .from(leaf)
    .leftJoin(server, eq(server.id, leaf.serverId))
    .where(and(eq(leaf.id, leafId), eq(leaf.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/** An owner says nothing is waiting on this certificate. */
export async function markLeafStaleByOwner(
  db: Db,
  organizationId: string,
  leafId: string,
  reason?: string,
  nowMs = Date.now()
): Promise<boolean> {
  const stamp = new Date(nowMs).toISOString()
  const rows = await db
    .update(leaf)
    .set({
      state: 'stale',
      staleAt: stamp,
      staleReason: clipLeafText(reason?.trim() ? reason : LEAF_STALE_BY_OWNER),
      updatedAt: stamp,
    })
    .where(
      and(eq(leaf.id, leafId), eq(leaf.organizationId, organizationId), eq(leaf.state, 'active'))
    )
    .returning({ id: leaf.id })
  return rows.length > 0
}

/** Delete the tracking record only; the certificate on the server is untouched. */
export async function deleteLeafRecord(
  db: Db,
  organizationId: string,
  leafId: string
): Promise<boolean> {
  const rows = await db
    .delete(leaf)
    .where(and(eq(leaf.id, leafId), eq(leaf.organizationId, organizationId)))
    .returning({ id: leaf.id })
  return rows.length > 0
}

/** Put a stale leaf back in the renewal queue (an owner asked to renew it). */
export async function reactivateLeaf(
  db: Db,
  organizationId: string,
  leafId: string
): Promise<void> {
  await db
    .update(leaf)
    .set({ state: 'active', staleAt: null, staleReason: null, attempts: 0, attemptedAt: null })
    .where(and(eq(leaf.id, leafId), eq(leaf.organizationId, organizationId)))
}
