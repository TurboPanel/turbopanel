// Deno-only: called from the PAM root sign-in path (gated to runtime === 'deno' in verifyCredentials).

import { eq, and } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { user, account, organization, team } from '../db/schema.ts'
import { ROOT_USERNAME, SUPERUSER_ROLE } from './session-store.ts'

export async function ensureRootProvisioned(db: Db): Promise<string> {
  return await db.transaction(async (tx) => {
    let [rootUser] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.username, ROOT_USERNAME))
      .limit(1)

    if (!rootUser) {
      const inserted = await tx
        .insert(user)
        .values({
          displayName: ROOT_USERNAME,
          username: ROOT_USERNAME,
          displayUsername: ROOT_USERNAME,
          email: 'root@localhost',
          isEmailVerified: true,
          role: SUPERUSER_ROLE,
        })
        .returning({ id: user.id })
      rootUser = inserted[0]
    } else {
      await tx
        .update(user)
        .set({ role: SUPERUSER_ROLE })
        .where(
          and(eq(user.id, rootUser.id), eq(user.role, 'system')),
        )
    }

    if (!rootUser) {
      throw new Error('root user provisioning failed')
    }

    const userId = rootUser.id

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
        and(eq(account.userId, userId), eq(account.providerId, 'pam')),
      )
      .limit(1)

    if (!existingAccount) {
      await tx.insert(account).values({
        userId,
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

    return userId
  })
}
