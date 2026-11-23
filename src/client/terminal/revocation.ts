/**
 * Does a terminal session's owner still hold what the session was opened with?
 *
 * A session is opened for one sign-in (the auth session), by one active user
 * who holds `terminal:container` on the container. Whatever takes that away
 * (the sign-in revoked or expired, "sign out everywhere", the account disabled,
 * removal from the organization, a lost grant) ends the session, so the check
 * reads the same rows the open gate does rather than hooking every place that
 * can change them. The cell and the self-hosted hub run it on a short timer for
 * their live and pending sessions.
 */
import { and, eq, gt, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, session, user } from '../../db/schema.ts'
import type { ShellSessionMeta } from '../../contracts/shell-relay.ts'
import { can } from '../authz/evaluator.ts'

/** How often a runtime re-checks the sessions it holds. */
export const TERMINAL_REVOCATION_CHECK_MS = 30_000

export type TerminalRevocation = 'session-ended' | 'user-disabled' | 'permission-lost'

/** The facts the check needs; a `ShellSessionMeta` or a pending open both fit. */
export type TerminalRevocationSubject = Pick<
  ShellSessionMeta,
  'serverId' | 'userId' | 'authSessionId' | 'containerId' | 'kind'
>

/** Why the session must end, or null when its owner still holds everything. */
export async function terminalRevocation(
  db: Db,
  subject: TerminalRevocationSubject
): Promise<TerminalRevocation | null> {
  const [signIn] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, subject.authSessionId),
        eq(session.userId, subject.userId),
        gt(session.expiresAt, sql`now()`)
      )
    )
    .limit(1)
  if (!signIn) return 'session-ended'

  const [account] = await db
    .select({ isDisabled: user.isDisabled })
    .from(user)
    .where(eq(user.id, subject.userId))
    .limit(1)
  if (!account || account.isDisabled) return 'user-disabled'

  if (subject.kind !== 'container') return null
  // The daemon's handle maps back to the container row the open gate checked.
  const [row] = await db
    .select({ id: container.id })
    .from(container)
    .where(
      and(eq(container.serverId, subject.serverId), eq(container.containerId, subject.containerId))
    )
    .limit(1)
  // A container that is gone is not an authorization matter; the daemon ends that session.
  if (!row) return null
  const holds = await can(db, subject.userId, 'terminal:container', 'container', row.id)
  return holds ? null : 'permission-lost'
}
