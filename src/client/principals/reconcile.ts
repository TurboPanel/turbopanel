/**
 * Push a principal's access to every server it exists on, without a deploy.
 *
 * Adding a key on the next deploy would be tolerable; **revoking** one that way
 * is not. The whole value of panel-managed keys is that removing one in the UI
 * removes it on the host now, not whenever an unrelated environment next ships.
 * So key, shell, and password changes enqueue `server.principals.reconcile`
 * directly.
 *
 * The payload carries the **complete** managed set for each server, because
 * that is what makes removal on the daemon side safe: an account absent from it
 * is one TurboPanel no longer manages there. Building anything narrower —
 * "just this principal" — would either forbid removal or make it delete
 * everyone else's key files.
 */

import { forEachSequential } from '../../lib/sequential.ts'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, principal, project } from '../../db/schema.ts'
import { createCommandRecord, transitionCommand } from '../../features/commands/command-records.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { loadPrincipalMaterial } from '../environments/deploy-prepare.ts'
import { principalsStillOnServer } from '../environments/teardown.ts'

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
export async function serversForPrincipal(db: Db, principalId: string): Promise<string[]> {
  const rows = await db
    .select({ serverId: environment.serverId })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(and(eq(principal.id, principalId), isNotNull(environment.serverId)))
  return [...new Set(rows.map((row) => row.serverId as string))]
}

/** Every principal TurboPanel manages on one server — the completeness rule. */
export async function principalIdsOnServer(db: Db, serverId: string): Promise<string[]> {
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

export type PrincipalsReconcileOptions = {
  /**
   * Applied logins of principals the panel has just deleted; the daemon
   * removes the accounts after it applies the surviving set
   * (`tp-host principal-remove`). Sent to every server in `serverIds`.
   */
  retirePrincipals?: readonly string[]
}

/**
 * Enqueue a full-state reconcile on every server a principal reaches.
 *
 * Best-effort per server and **never throws**: this runs after the write that
 * changed the key, and the write has already succeeded. Turning a queue hiccup
 * into a 500 would tell the operator their revocation did not happen when the
 * row is in fact gone — the opposite of the truth, and the reason the caller
 * gets an outcome to report rather than an exception to swallow.
 *
 * A server whose managed set comes back **empty** is skipped unless there is
 * an account to retire there: an empty set would tell the daemon to remove
 * every key file on the host, and this code can never be sure enough of that
 * to say it (the daemon refuses it too, without an explicit opt-in).
 */
export async function enqueuePrincipalsReconcile(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  serverIds: readonly string[],
  options: PrincipalsReconcileOptions = {}
): Promise<PrincipalsReconcileOutcome> {
  const queued: string[] = []
  const failed: string[] = []
  if (!queue) return { queuedServerIds: queued, failedServerIds: [...serverIds] }
  const retirePrincipals = [...new Set(options.retirePrincipals ?? [])]

  await forEachSequential(serverIds, async (serverId) => {
    try {
      const principalIds = await principalIdsOnServer(db, serverId)
      const principals = await loadPrincipalMaterial(db, principalIds)
      if (principals.length === 0 && retirePrincipals.length === 0) return
      const record = await createCommandRecord(db, {
        serverId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        type: 'server.principals.reconcile',
        payload: {
          principals,
          ...(retirePrincipals.length > 0
            ? { retirePrincipals: retirePrincipals.map((username) => ({ username })) }
            : {}),
        },
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
  })
  return { queuedServerIds: queued, failedServerIds: failed }
}

/** Convenience: resolve the servers for one principal, then reconcile them. */
export async function reconcilePrincipalAccess(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  principalId: string
): Promise<PrincipalsReconcileOutcome> {
  const serverIds = await serversForPrincipal(db, principalId)
  return await enqueuePrincipalsReconcile(db, queue, actor, serverIds)
}

/** Reconcile every server a set of principals reaches, each server once. */
export async function reconcilePrincipalsAccess(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  principalIds: readonly string[]
): Promise<PrincipalsReconcileOutcome> {
  if (principalIds.length === 0) {
    return { queuedServerIds: [], failedServerIds: [] }
  }
  const rows = await db
    .select({ serverId: environment.serverId })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(and(inArray(principal.id, [...principalIds]), isNotNull(environment.serverId)))
  const serverIds = [...new Set(rows.map((row) => row.serverId as string))]
  return await enqueuePrincipalsReconcile(db, queue, actor, serverIds)
}

/**
 * After a principal row is deleted: reconcile every server it reached and
 * name its login in `retirePrincipals` there, so the daemon removes the
 * account (user, group, home, slice) once the surviving set is applied. The
 * one exception is a server where another row still places the same login
 * (`principalsStillOnServer`, the teardown rule); that server gets a plain
 * reconcile and keeps the account. Call with the server list resolved
 * **before** the delete — `serversForPrincipal` joins through the row.
 */
export async function retireDeletedPrincipal(
  db: Db,
  queue: CommandQueue | undefined,
  actor: PrincipalsReconcileActor,
  params: Readonly<{ serverIds: readonly string[]; appliedUsername: string }>
): Promise<PrincipalsReconcileOutcome> {
  const retire: string[] = []
  const keep: string[] = []
  const failed: string[] = []
  await forEachSequential(params.serverIds, async (serverId) => {
    try {
      const kept = await principalsStillOnServer(db, serverId, [params.appliedUsername])
      ;(kept.has(params.appliedUsername) ? keep : retire).push(serverId)
    } catch {
      // The row is already gone; a lookup failure keeps the account there
      // (never retire on a guess) and is reported, not thrown.
      failed.push(serverId)
    }
  })
  const retired = await enqueuePrincipalsReconcile(db, queue, actor, retire, {
    retirePrincipals: [params.appliedUsername],
  })
  const reconciled = await enqueuePrincipalsReconcile(db, queue, actor, keep)
  return {
    queuedServerIds: [...retired.queuedServerIds, ...reconciled.queuedServerIds],
    failedServerIds: [...failed, ...retired.failedServerIds, ...reconciled.failedServerIds],
  }
}
