/**
 * Accepting an invitation: one transaction that claims the pending row, adds
 * the user to the invited team and materializes the invitation's grants.
 *
 * Shared by the signed-in **Accept invitation** button
 * (`POST /invitations/:id/accept`) and the new-account path that creates the
 * password and accepts in one step (`POST /auth/invitations/:id/sign-up`).
 *
 * Idempotent for the person it was accepted by: accepting an invitation that
 * this same user already accepted answers `ok` again (a double click, a
 * retried request, the back button) instead of "expired or already used".
 */
import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { invitation, team, teammate } from '../../db/schema.ts'
import {
  InvitationGrantValidationError,
  materializeInvitationGrants,
  resolveInvitationGrants,
} from '../authn/invitation-grants.ts'
import type { InvitationAcceptError } from './routes-helpers.ts'

export type AcceptInvitationResult =
  { ok: true; organizationId: string } | { error: InvitationAcceptError }

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function organizationOfTeam(tx: Tx, teamId: string): Promise<string | undefined> {
  const rows = await tx
    .select({ organizationId: team.organizationId })
    .from(team)
    .where(eq(team.id, teamId))
    .limit(1)
  return rows[0]?.organizationId
}

/** An invitation this user already accepted: same answer as the first accept. */
async function alreadyAcceptedBy(
  tx: Tx,
  invitationId: string,
  userId: string
): Promise<string | undefined> {
  const rows = await tx
    .select({ status: invitation.status, teamId: invitation.teamId })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1)
  const row = rows[0]
  if (row?.status !== 'accepted') return undefined
  const member = await tx
    .select({ userId: teammate.userId })
    .from(teammate)
    .where(and(eq(teammate.teamId, row.teamId), eq(teammate.userId, userId)))
    .limit(1)
  if (member.length === 0) return undefined
  return await organizationOfTeam(tx, row.teamId)
}

/**
 * Claim `invitationId` for `userId`. The caller has already checked that the
 * user's email matches the invitation's.
 */
export async function acceptInvitationForUser(
  db: Db,
  invitationId: string,
  userId: string
): Promise<AcceptInvitationResult> {
  const now = new Date().toISOString()
  return await db.transaction(async (tx) => {
    const claimed = await tx
      .update(invitation)
      .set({ status: 'accepted' })
      .where(
        and(
          eq(invitation.id, invitationId),
          eq(invitation.status, 'pending'),
          gt(invitation.expiresAt, now)
        )
      )
      .returning()

    const invite = claimed[0]
    if (!invite) {
      const organizationId = await alreadyAcceptedBy(tx, invitationId, userId)
      return organizationId ? { ok: true as const, organizationId } : { error: 'gone' as const }
    }

    const organizationId = await organizationOfTeam(tx, invite.teamId)
    if (!organizationId) {
      return { error: 'gone' as const }
    }

    await tx
      .insert(teammate)
      .values({ teamId: invite.teamId, userId })
      .onConflictDoNothing({ target: [teammate.teamId, teammate.userId] })

    const grants = resolveInvitationGrants(invite.grants, organizationId)
    try {
      await materializeInvitationGrants(tx, userId, grants, organizationId)
    } catch (err) {
      if (err instanceof InvitationGrantValidationError) {
        return { error: 'invalid_grant' as const }
      }
      throw err
    }

    return { ok: true as const, organizationId }
  })
}
