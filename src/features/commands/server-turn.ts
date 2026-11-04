/**
 * One command at a time per server, in arrival order, on both runtimes.
 *
 * The queue delivers every command but keeps no order between consumers, and
 * on Workers many consumers run at once. So before a command starts, the
 * consumer takes its server's turn here, in one short transaction:
 *
 * 1. lock the server's row (`SELECT … FOR NO KEY UPDATE`, waiting at most
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
 * Waiting never counts against a command: a busy check stamps it as seen
 * and moves its expiry on by the time it waited, and the stale sweep times a
 * waiting command from that stamp. {@link QUICK_COMMAND_TYPES} skip the line.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, server } from '../../db/schema.ts'
import { DEPLOY_SIGNAL_GRACE_MS } from './deploy-wait.ts'
import { SERVER_BUSY_LONGEST_DELAY_SECONDS } from './delivery-retry.ts'
import { nowIso } from './ids.ts'
import { type CommandType, TERMINAL_COMMAND_STATUSES } from './types.ts'

/** The longest a consumer waits for another consumer's turn check on the same server. */
export const SERVER_TURN_LOCK_TIMEOUT_MS = 2_000

/**
 * Quick, read-only or confirm-only commands that never wait their server's
 * turn and never hold it: the server runs them alongside a long command.
 * `server.firewall.confirm` must arrive before the server's own deadline or
 * the server undoes the new firewall rules, so it can never queue behind a
 * backup. Add a type here only if it is short and safe to run beside any
 * other command on the same server.
 */
export const QUICK_COMMAND_TYPES: ReadonlySet<CommandType> = new Set<CommandType>([
  'daemon.ping',
  'server.firewall.confirm',
  'server.tunnel.status',
])

/** The quick types as bound parameters, for the turn check. */
const QUICK_TYPES_SQL = sql.join(
  [...QUICK_COMMAND_TYPES].map((type) => sql`${type}`),
  sql`, `
)

/**
 * An older command still `queued` makes a newer one wait only while it was
 * touched this recently. Every busy check stamps the waiting command's
 * `updated_at`, so a command still waiting its turn keeps its place however
 * long the server is busy; one whose queue message was lost stops being
 * touched, and past this it no longer holds its server up. Longer than the
 * longest retry wait (`COMMAND_RETRY_DELAYS_SECONDS`, 10 minutes), so a
 * command waiting out a retry does not lose its place either.
 */
export const OLDER_QUEUED_WAIT_MS = 15 * 60_000

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
      and other.name not in (${QUICK_TYPES_SQL})
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
          and other.updated_at > now() - ${OLDER_QUEUED_WAIT_MS} * interval '1 millisecond'
          and (other.created_at, other.id) < (
            select mine.created_at, mine.id from ${command} mine where mine.id = ${input.commandId}
          )
        )
      )
  )`
}

/** What the consumer read of the command, so a claim only wins against that exact row. */
export type ServerTurnInput = {
  commandId: string
  serverId: string
  type: CommandType
  attempts: number
  /** The status the consumer read; the claim fails if another delivery moved it since. */
  status: string
  /** `dispatch_started_at` as read; with `status` it tells two deliveries of one command apart. */
  dispatchStartedAt: string | null
}

/** How rarely a waiting command's `updated_at` is stamped (its place and its expiry credit). */
export const WAITING_STAMP_INTERVAL_MS = 30_000

/**
 * A waiting command's expiry is never set closer than this after a stamp: the
 * longest wait before its next look plus a margin, so its next look always
 * finds it alive and stamps it again.
 */
export const WAITING_EXPIRY_FLOOR_MS = (SERVER_BUSY_LONGEST_DELAY_SECONDS + 60) * 1000

/**
 * Mark the command `dispatching` (stamping `dispatch_started_at` and counting
 * the attempt), but only if it is still exactly as the consumer read it: a
 * second delivery of the same command (an at-least-once queue can hand one
 * out twice) loses and does nothing. `false` when it lost or finished.
 */
async function markClaimed(
  tx: Pick<Db, 'update'>,
  input: ServerTurnInput,
  now: string
): Promise<boolean> {
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
        eq(command.status, input.status),
        notInArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
        sql`${command.dispatchStartedAt} is not distinct from ${input.dispatchStartedAt}::timestamptz`
      )
    )
    .returning({ id: command.id })
  return claimed.length > 0
}

/**
 * Still waiting its turn: keep its place ahead of newer commands and give the
 * time it waited since it was last seen back to its expiry. One UPDATE, so
 * every SET expression reads the row's old `updated_at` and the credit is the
 * wait since the last stamp. At most once per {@link WAITING_STAMP_INTERVAL_MS}:
 * each stamp is a row write, and the credit adds up the same either way.
 */
async function stampWaiting(db: Db, commandId: string, now: string): Promise<void> {
  await db
    .update(command)
    .set({
      updatedAt: now,
      // Never closer than the longest wait to its next look plus a margin: a
      // command with a short lifetime could otherwise expire just before it
      // looks again. No expiry stays none.
      expiresAt: sql`case when ${command.expiresAt} is null then null else greatest(
        ${command.expiresAt} + (${now}::timestamptz - ${command.updatedAt}),
        ${now}::timestamptz + ${WAITING_EXPIRY_FLOOR_MS} * interval '1 millisecond'
      ) end`,
    })
    .where(
      and(
        eq(command.id, commandId),
        eq(command.status, 'queued'),
        sql`${command.updatedAt} < ${now}::timestamptz - ${WAITING_STAMP_INTERVAL_MS} * interval '1 millisecond'`
      )
    )
}

/**
 * The unlocked turn check and, when the command is blocked, its stamp, in one
 * statement: a data-modifying CTE always runs, and its UPDATE only fires when
 * the check found something ahead (and the stamp is due). One round trip for
 * the common answer, "busy". The expiry expression is the same as
 * {@link stampWaiting}'s.
 */
async function blockedAndStamped(db: Db, input: ServerTurnInput, now: string): Promise<boolean> {
  const [row] = await db.execute<{ blocked: boolean }>(sql`
    with turn as (select ${blockingCommandExists(input)} as blocked),
    stamped as (
      update ${command}
      set updated_at = ${now}::timestamptz,
        expires_at = case when expires_at is null then null else greatest(
          expires_at + (${now}::timestamptz - updated_at),
          ${now}::timestamptz + ${WAITING_EXPIRY_FLOOR_MS} * interval '1 millisecond'
        ) end
      where id = ${input.commandId}
        and status = 'queued'
        and updated_at < ${now}::timestamptz - ${WAITING_STAMP_INTERVAL_MS} * interval '1 millisecond'
        and (select blocked from turn)
      returning 1
    )
    select blocked from turn`)
  return row?.blocked === true
}

/**
 * Take the server's turn for `commandId` and mark it `dispatching`, or say why
 * not. A busy server is the common answer and the cheap one: one unlocked
 * statement says so and stamps the waiting command (at most every 30 seconds,
 * often enough that a command with a two-minute expiry is credited before it
 * runs out). Only when nothing seems to block does it take the server row's
 * lock and check again before claiming (a false "busy" from the unlocked read
 * only means trying again a little later). A "busy" found under the lock, or a
 * lock timeout, stamps too, so no path leaves a waiting command unstamped.
 */
export async function claimServerTurn(db: Db, input: ServerTurnInput): Promise<ServerTurn> {
  if (QUICK_COMMAND_TYPES.has(input.type)) {
    return (await markClaimed(db, input, nowIso())) ? 'claimed' : 'finished'
  }
  if (await blockedAndStamped(db, input, nowIso())) return 'busy'
  let turn: ServerTurn
  try {
    turn = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${SERVER_TURN_LOCK_TIMEOUT_MS}ms'`))
      // A server that is gone has no row to lock; the consumer fails the command next.
      // `no key update` serializes claims just as well, and unlike `update` it does
      // not wait on (or block) the key-share locks that inserts referencing the
      // server take.
      await tx
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, input.serverId))
        .for('no key update')
      const [blocking] = await tx.execute<{ blocked: boolean }>(
        sql`select ${blockingCommandExists(input)} as blocked`
      )
      if (blocking?.blocked === true) return 'busy'
      return (await markClaimed(tx, input, nowIso())) ? 'claimed' : 'finished'
    })
  } catch (error) {
    if (!isLockTimeout(error)) throw error
    turn = 'busy'
  }
  if (turn === 'busy') await stampWaiting(db, input.commandId, nowIso())
  return turn
}
