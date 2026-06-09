// Deno-only: called from the PAM root sign-in path (gated to runtime === 'deno' in verifyCredentials).

import { eq, and } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { user, account, organization, team } from '../db/schema.ts'
import { ROOT_USER_ID } from './session-store.ts'

export async function ensureRootProvisioned(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(user)
      .values({
        id: ROOT_USER_ID,
        displayName: 'root',
        username: 'root',
        displayUsername: 'root',
        email: 'root@localhost',
        isEmailVerified: true,
        role: 'system',
      })
      .onConflictDoNothing({ target: user.id })

    const [rootUser] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ROOT_USER_ID))
      .limit(1)

    if (!rootUser) {
      throw new Error('root user provisioning failed')
    }

    await tx
      .insert(organization)
      .values({
        displayName: 'Root',
        slug: 'root',
      })
      .onConflictDoNothing({ target: organization.slug })

    const [rootOrg] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, 'root'))
      .limit(1)

    if (!rootOrg) {
      throw new Error('root organization provisioning failed')
    }

    const [existingAccount] = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(eq(account.userId, ROOT_USER_ID), eq(account.providerId, 'pam')),
      )
      .limit(1)

    if (!existingAccount) {
      await tx.insert(account).values({
        userId: ROOT_USER_ID,
        providerId: 'pam',
        providerUserId: '0',
      })
    }

    const [existingTeam] = await tx
      .select({ id: team.id })
      .from(team)
      .where(
        and(
          eq(team.organizationId, rootOrg.id),
          eq(team.displayName, 'System Administrators'),
        ),
      )
      .limit(1)

    if (!existingTeam) {
      await tx.insert(team).values({
        organizationId: rootOrg.id,
        displayName: 'System Administrators',
      })
    }
  })
}
