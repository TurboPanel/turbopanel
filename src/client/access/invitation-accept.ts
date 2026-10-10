/**
 * Accepting an invitation: one transaction that adds the user to the invited
 * team, materializes the invitation's grants, and marks the row accepted last.
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
  parseInvitationGrants,
  validateInvitationGrantSpecs,
} from '../authn/invitation-grants.ts'
import { inviterHoldsTeamGrants } from './invitation-delegation.ts'
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

async function loadPendingInvitationForUpdate(
  tx: Tx,
  invitationId: string,
  now: string
): Promise<typeof invitation.$inferSelect | undefined> {
  const rows = await tx
    .select()
    .from(invitation)
    .where(
      and(
        eq(invitation.id, invitationId),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now)
      )
    )
    .for('update')
    .limit(1)
  return rows[0]
}

function invalidGrantFromValidation(err: unknown): InvitationAcceptError | undefined {
  return err instanceof InvitationGrantValidationError ? 'invalid_grant' : undefined
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
  try {
    return await db.transaction(async (tx) => {
      const organizationIdFromPrior = await alreadyAcceptedBy(tx, invitationId, userId)
      if (organizationIdFromPrior) {
        return { ok: true as const, organizationId: organizationIdFromPrior }
      }

      const invite = await loadPendingInvitationForUpdate(tx, invitationId, now)
      if (!invite) {
        return { error: 'gone' as const }
      }

      const organizationId = await organizationOfTeam(tx, invite.teamId)
      if (!organizationId) {
        return { error: 'gone' as const }
      }

      // Re-checked at accept time: covers invitations sent before the rule
      // existed, and grants given to the team after the invitation went out.
      if (!(await inviterHoldsTeamGrants(tx, invite.userId, invite.teamId))) {
        return { error: 'invalid_grant' as const }
      }

      const grantsParsed = parseInvitationGrants(invite.grants)
      if (invite.grants != null && grantsParsed === null) {
        return { error: 'invalid_grant' as const }
      }
      const grants = grantsParsed ?? []

      try {
        await validateInvitationGrantSpecs(tx, grants, organizationId)
      } catch (err) {
        const code = invalidGrantFromValidation(err)
        if (code) return { error: code }
        throw err
      }

      await tx
        .insert(teammate)
        .values({ teamId: invite.teamId, userId })
        .onConflictDoNothing({ target: [teammate.teamId, teammate.userId] })

      await materializeInvitationGrants(tx, userId, grants, organizationId)

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

      if (!claimed[0]) {
        const organizationIdRetry = await alreadyAcceptedBy(tx, invitationId, userId)
        return organizationIdRetry
          ? { ok: true as const, organizationId: organizationIdRetry }
          : { error: 'gone' as const }
      }

      return { ok: true as const, organizationId }
    })
  } catch (err) {
    const code = invalidGrantFromValidation(err)
    if (code) return { error: code }
    throw err
  }
}
