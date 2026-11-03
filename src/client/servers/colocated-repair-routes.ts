import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { requireInstanceStepUp } from '../authn/step-up.ts'
import {
  type ColocatedRepairDisk,
  type ColocatedRepairRefusal,
  type ColocatedRepairStore,
  type ColocatedRequestedRepairOutcome,
  createColocatedRepairDisk,
  createColocatedRepairStore,
  repairColocatedCredentialsOnRequest,
} from '../authn/colocated-self-repair.ts'
import { requireServerOwnerContext } from './owner-context.ts'

export const COLOCATED_REPAIR_PATH = '/servers/:id/colocated-repair'

/** Plain messages for each refusal; the code travels beside it. */
export const COLOCATED_REPAIR_REFUSAL_MESSAGES: Readonly<Record<ColocatedRepairRefusal, string>> = {
  not_deno: 'Repair Connection is only available on a self-hosted control plane.',
  no_colocated_seat:
    'This control plane has no license for the server it runs on, so there is nothing to repair.',
  not_colocated_server:
    'Repair Connection works only for the server this control plane runs on. For any other server, use Re-Enroll Token.',
  no_daemon_files:
    'No daemon files were found on this server, so nothing was changed. Check that the daemon is installed and has started once.',
  daemon_key_revoked:
    "This server's daemon key is revoked, so it cannot be repaired. Revocation is permanent; nothing was changed.",
  seat_changed:
    "This server's license changed while the repair ran, so nothing was changed. Try again.",
}

const WRITE_FAILED_MESSAGE =
  "New credentials were issued, but the daemon's files could not be written. Nothing else changed; try again."

export type ColocatedRepairResponse = Readonly<{
  status: 200 | 409 | 500
  body: Record<string, unknown>
}>

/** The HTTP answer for one outcome. Never carries the token. */
export function colocatedRepairResponse(
  outcome: ColocatedRequestedRepairOutcome
): ColocatedRepairResponse {
  if (outcome.status === 'repaired') {
    return {
      status: 200,
      body: {
        ok: true,
        serverId: outcome.serverId,
        reasons: outcome.reasons,
        clearedKey: outcome.clearedKey,
      },
    }
  }
  if (outcome.status === 'failed') {
    return { status: 500, body: { error: WRITE_FAILED_MESSAGE, code: 'write_failed' } }
  }
  return {
    status: 409,
    body: { error: COLOCATED_REPAIR_REFUSAL_MESSAGES[outcome.code], code: outcome.code },
  }
}

/** Seams for tests; production uses the real database store and state dir. */
export type ColocatedRepairRouteDeps = Readonly<{
  store?: (db: Db) => ColocatedRepairStore
  disk?: () => ColocatedRepairDisk
}>

/**
 * `POST /servers/:id/colocated-repair`: the owner's Repair Connection for the
 * server this control plane runs on (self-hosted only). Owner only, always
 * behind step-up, audited. It re-issues the token on the existing co-located
 * license, clears that one server's stale daemon key when the daemon no
 * longer holds it, and writes the daemon's license files, so the daemon
 * enrolls the same server again. See `repairColocatedCredentialsOnRequest`.
 */
export function registerServerColocatedRepairRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  deps: ColocatedRepairRouteDeps = {}
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server co-located repair routes')
  }
  router.use(COLOCATED_REPAIR_PATH, createSessionMiddleware(opts.secrets))

  router.post(COLOCATED_REPAIR_PATH, async (c: Context<AppEnv>) => {
    const ctx = await requireServerOwnerContext(c)
    if (ctx instanceof Response) return ctx
    const { db, session, organizationId, serverId } = ctx

    if (opts.runtime === 'workers') {
      const refused = colocatedRepairResponse({ status: 'refused', code: 'not_deno' })
      return c.json(refused.body, 409)
    }

    // Always on: this replaces the server's credentials.
    const stepUp = await requireInstanceStepUp(c, 'server.colocated_repair')
    if (stepUp) return stepUp

    const store = (deps.store ?? createColocatedRepairStore)(db)
    const disk = (deps.disk ?? createColocatedRepairDisk)()
    const outcome = await repairColocatedCredentialsOnRequest(store, disk, serverId)
    const answer = colocatedRepairResponse(outcome)

    if (outcome.status !== 'refused') {
      await recordAudit(db, {
        organizationId,
        actorUserId: session.userId,
        actorEmail: session.email,
        action: 'server.colocated_repair',
        targetType: 'server',
        targetId: serverId,
        context:
          outcome.status === 'repaired'
            ? { result: 'repaired', reasons: outcome.reasons, clearedKey: outcome.clearedKey }
            : { result: 'failed', reason: outcome.reason },
      })
    }
    return c.json(answer.body, answer.status)
  })
}
