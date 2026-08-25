/**
 * Push a principal's access to every server it exists on, without a deploy.
 *
 * Adding a key on the next deploy would be tolerable; **revoking** one that way
 * is not. The whole value of panel-managed keys is that removing one in the UI
 * removes it on the host now, not whenever an unrelated environment next ships.
 * So key, shell, and entitlement changes enqueue `server.principals.reconcile`
 * directly.
 *
 * The payload carries the **complete** managed set for each server, because
 * that is what makes removal on the daemon side safe: an account absent from it
 * is one TurboPanel no longer manages there. Building anything narrower —
 * "just this principal" — would either forbid removal or make it delete
 * everyone else's key files.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { environment, principal, project } from '../../lib/db/schema.ts'
import { createCommandRecord, transitionCommand } from '../../lib/db/command-records.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { loadPrincipalMaterial } from '../environments/deploy-prepare.ts'

export type PrincipalsReconcileActor = {
  actorType: string
  actorId: string
}

/**
 * Servers where this principal's project has at least one environment.
 *
 * That is the same reach a deploy has, so it is exactly the set of hosts where
 * the account can have been materialized. An environment with no server
 * assigned yet has nothing to reconcile.
 */
export async function serversForPrincipal(
  db: Db,
  principalId: string,
): Promise<string[]> {
  const rows = await db
    .select({ serverId: environment.serverId })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(
      and(eq(principal.id, principalId), isNotNull(environment.serverId)),
    )
  return [...new Set(rows.map((row) => row.serverId as string))]
}

/** Every principal TurboPanel manages on one server — the completeness rule. */
export async function principalIdsOnServer(
  db: Db,
  serverId: string,
): Promise<string[]> {
  const rows = await db
    .select({ principalId: principal.id })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(eq(environment.serverId, serverId))
  return [...new Set(rows.map((row) => row.principalId))]
}

export type PrincipalsReconcileOutcome = {
  /** Servers a command was queued for. */
  queuedServerIds: string[]
  /** Servers whose command could not be queued; the rows are marked failed. */
  failedServerIds: string[]
}

/**
 * Enqueue a full-state reconcile on every server a principal reaches.
 *
 * Best-effort per server and **never throws**: this runs after the write that
 * changed the key, and the write has already succeeded. Turning a queue hiccup
 * into a 500 would tell the operator their revocation did not happen when the
 * row is in fact gone — the opposite of the truth, and the reason the caller
 * gets an outcome to report rather than an exception to swallow.
 */
export async function enqueuePrincipalsReconcile(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  serverIds: readonly string[],
): Promise<PrincipalsReconcileOutcome> {
  const queued: string[] = []
  const failed: string[] = []
  if (!queue) return { queuedServerIds: queued, failedServerIds: [...serverIds] }

  for (const serverId of serverIds) {
    try {
      const principalIds = await principalIdsOnServer(db, serverId)
      const principals = await loadPrincipalMaterial(db, principalIds)
      const record = await createCommandRecord(db, {
        serverId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        type: 'server.principals.reconcile',
        payload: { principals },
      })
      const envelope: CommandEnvelope = {
        commandId: record.id,
        serverId,
        type: 'server.principals.reconcile',
        attempt: 1,
        queuedAt: record.queuedAt ?? record.createdAt,
      }
      try {
        await queue.enqueue(envelope)
        queued.push(serverId)
      } catch {
        // The row exists but nothing will ever pick it up; leaving it `queued`
        // would show the operator a command that is permanently pending.
        await transitionCommand(db, record.id, {
          status: 'failed',
          error: 'Failed to enqueue principals reconcile',
        })
        failed.push(serverId)
      }
    } catch {
      failed.push(serverId)
    }
  }
  return { queuedServerIds: queued, failedServerIds: failed }
}

/** Convenience: resolve the servers for one principal, then reconcile them. */
export async function reconcilePrincipalAccess(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  principalId: string,
): Promise<PrincipalsReconcileOutcome> {
  const serverIds = await serversForPrincipal(db, principalId)
  return await enqueuePrincipalsReconcile(db, queue, actor, serverIds)
}

/** Reconcile every server a set of principals reaches, each server once. */
export async function reconcilePrincipalsAccess(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  principalIds: readonly string[],
): Promise<PrincipalsReconcileOutcome> {
  if (principalIds.length === 0) {
    return { queuedServerIds: [], failedServerIds: [] }
  }
  const rows = await db
    .select({ serverId: environment.serverId })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(
      and(
        inArray(principal.id, [...principalIds]),
        isNotNull(environment.serverId),
      ),
    )
  const serverIds = [...new Set(rows.map((row) => row.serverId as string))]
  return await enqueuePrincipalsReconcile(db, queue, actor, serverIds)
}
