/**
 * One command at a time per server, in arrival order, on both runtimes.
 *
 * The queue delivers every command but keeps no order between consumers, and
 * on Workers many consumers run at once. So before a command starts, the
 * consumer takes its server's turn here, in one short transaction:
 *
 * 1. lock the server's row (`SELECT … FOR UPDATE`, waiting at most
 *    {@link SERVER_TURN_LOCK_TIMEOUT_MS}); the lock lives only for this
 *    transaction and Postgres drops it on commit, rollback or a lost
 *    connection, so it can never be left behind;
 * 2. look in the `command` table for another command of that server that is
 *    still running, or an older one still waiting to start;
 * 3. if there is none, mark this command `dispatching` and commit.
 *
 * Nothing is held while the command runs: "running" is the command row's own
 * status. A run that dies without reporting leaves its row live until the
 * stale-command sweep times it out, and the server's next command starts
 * then. A deploy stops counting as running once the server has taken it over
 * ({@link deployMayLeaveLane}): the server orders its own deploys.
 *
 * The self-hosted consumer also keeps its in-memory lanes; this is what holds
 * the order when more than one consumer runs.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, server } from '../../db/schema.ts'
import { DEPLOY_SIGNAL_GRACE_MS } from './deploy-wait.ts'
import { nowIso } from './ids.ts'
import { TERMINAL_COMMAND_STATUSES } from './types.ts'

/** The longest a consumer waits for another consumer's turn check on the same server. */
export const SERVER_TURN_LOCK_TIMEOUT_MS = 2_000

/**
 * An older command still `queued` makes a newer one wait only while it is this
 * young. One whose queue message was lost never starts; past this it no longer
 * holds its server up and the stale-command sweep times it out.
 */
export const OLDER_QUEUED_WAIT_MS = 5 * 60_000

/** Postgres `lock_not_available`: the lock timeout ran out. */
const LOCK_NOT_AVAILABLE = '55P03'

export type ServerTurn =
  /** This command is now `dispatching` and may run. */
  | 'claimed'
  /** Another command of this server runs or comes first; try again shortly. */
  | 'busy'
  /** The command finished meanwhile (a cancel or the sweep); nothing to run. */
  | 'finished'

/** The thrown error carries the code on itself or on `cause` depending on the driver path. */
function isLockTimeout(error: unknown): boolean {
  const code = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined
  return (
    code(error) === LOCK_NOT_AVAILABLE ||
    code((error as { cause?: unknown } | null)?.cause) === LOCK_NOT_AVAILABLE
  )
}

/** SQL: another command of the server that holds the turn or comes before this one. */
function blockingCommandExists(input: { commandId: string; serverId: string }) {
  return sql`exists (
    select 1 from ${command} other
    where other.server_id = ${input.serverId}
      and other.id <> ${input.commandId}
      and (
        (
          other.status in ('dispatching', 'sent', 'acked', 'running')
          and not (
            other.name = 'environment.deploy'
            and other.status <> 'dispatching'
            and (
              other.progress -> 'runningSince' is not null
              or other.sent_at <= now() - ${DEPLOY_SIGNAL_GRACE_MS} * interval '1 millisecond'
            )
          )
        )
        or (
          other.status = 'queued'
          and other.created_at > now() - ${OLDER_QUEUED_WAIT_MS} * interval '1 millisecond'
          and (other.created_at, other.id) < (
            select mine.created_at, mine.id from ${command} mine where mine.id = ${input.commandId}
          )
        )
      )
  )`
}

/**
 * Take the server's turn for `commandId` and mark it `dispatching`
 * (stamping `dispatch_started_at` and counting the attempt), or say why not.
 */
export async function claimServerTurn(
  db: Db,
  input: { commandId: string; serverId: string; attempts: number }
): Promise<ServerTurn> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${SERVER_TURN_LOCK_TIMEOUT_MS}ms'`))
      // A server that is gone has no row to lock; the consumer fails the command next.
      await tx
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, input.serverId))
        .for('update')
      const [blocking] = await tx.execute<{ blocked: boolean }>(
        sql`select ${blockingCommandExists(input)} as blocked`
      )
      if (blocking?.blocked === true) return 'busy'
      const now = nowIso()
      const claimed = await tx
        .update(command)
        .set({
          status: 'dispatching',
          dispatchStartedAt: now,
          updatedAt: now,
          attempts: input.attempts + 1,
        })
        .where(
          and(
            eq(command.id, input.commandId),
            notInArray(command.status, [...TERMINAL_COMMAND_STATUSES])
          )
        )
        .returning({ id: command.id })
      return claimed.length > 0 ? 'claimed' : 'finished'
    })
  } catch (error) {
    if (isLockTimeout(error)) return 'busy'
    throw error
  }
}
