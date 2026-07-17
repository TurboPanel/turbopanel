import { eq } from 'drizzle-orm'
import { it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, type Db } from '../../db.ts'
import {
  completeInstanceInstall,
  DEFAULT_ORGANIZATION_NAME,
  INSTANCE_ALREADY_CONFIGURED_ERROR,
  INSTANCE_INSTALL_SENTINEL_KEY,
  isInstanceInstalled,
} from './install-state.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import {
  account,
  grant,
  license,
  member,
  organization,
  setting,
  team,
  teammate,
  user,
  workspace,
} from '../../lib/db/schema.ts'

const dbUrl = getDatabaseUrl()

async function cleanupInstall(db: Db, organizationId: string, userId: string) {
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(teammate).where(eq(teammate.userId, userId))
  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(account).where(eq(account.userId, userId))
  await db.delete(license).where(eq(license.organizationId, organizationId))
  await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
  await db.delete(team).where(eq(team.organizationId, organizationId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
  await db.delete(setting).where(eq(setting.key, INSTANCE_INSTALL_SENTINEL_KEY))
}

it('concurrent install completions create exactly one superadmin bootstrap', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping concurrent install test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  if (await isInstanceInstalled(db)) {
    console.warn('Skipping concurrent install test: instance already installed')
    return
  }

  const suffix = crypto.randomUUID()
  const emailA = `install-race-a-${suffix}@example.com`
  const emailB = `install-race-b-${suffix}@example.com`

  let winnerOrgId: string | null = null
  let winnerUserId: string | null = null

  try {
    const [resultA, resultB] = await Promise.allSettled([
      completeInstanceInstall(db, {
        superadminEmail: emailA,
        superadminPassword: 'password1!',
      }),
      completeInstanceInstall(db, {
        superadminEmail: emailB,
        superadminPassword: 'password1!',
      }),
    ])

    const fulfilled = [resultA, resultB].filter(
      (r): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof completeInstanceInstall>>
      > => r.status === 'fulfilled',
    )
    const rejected = [resultA, resultB].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    if (fulfilled.length !== 1) {
      throw new Error(
        `expected exactly one install to succeed, got ${fulfilled.length}`,
      )
    }
    if (rejected.length !== 1) {
      throw new Error(
        `expected exactly one install to fail, got ${rejected.length}`,
      )
    }

    const loserMessage = rejected[0].reason instanceof Error
      ? rejected[0].reason.message
      : String(rejected[0].reason)
    if (loserMessage !== INSTANCE_ALREADY_CONFIGURED_ERROR) {
      throw new Error(
        `expected loser to fail with "${INSTANCE_ALREADY_CONFIGURED_ERROR}", got "${loserMessage}"`,
      )
    }

    winnerOrgId = fulfilled[0].value.organizationId
    winnerUserId = fulfilled[0].value.userId

    // Exactly one Default Organization bootstrap.
    const orgRows = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.displayName, DEFAULT_ORGANIZATION_NAME))
    if (orgRows.length !== 1) {
      throw new Error(
        `expected exactly one Default Organization, got ${orgRows.length}`,
      )
    }

    // Exactly one superadmin.
    const adminRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.role, SUPERADMIN_ROLE))
    if (adminRows.length !== 1) {
      throw new Error(`expected exactly one superadmin, got ${adminRows.length}`)
    }
    if (adminRows[0]?.id !== winnerUserId) {
      throw new Error('superadmin row does not match the winning install')
    }

    // The losing email must not have created a user row.
    const loserEmail = winnerUserId
      ? (await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, winnerUserId))
        .limit(1))[0]?.email === emailA
        ? emailB
        : emailA
      : emailB
    const loserRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, loserEmail))
    if (loserRows.length !== 0) {
      throw new Error(
        `expected no user row for the losing install email, got ${loserRows.length}`,
      )
    }

    // The install sentinel exists exactly once.
    const sentinelRows = await db
      .select({ id: setting.id })
      .from(setting)
      .where(eq(setting.key, INSTANCE_INSTALL_SENTINEL_KEY))
    if (sentinelRows.length !== 1) {
      throw new Error(
        `expected exactly one install sentinel, got ${sentinelRows.length}`,
      )
    }
  } finally {
    if (winnerOrgId && winnerUserId) {
      await cleanupInstall(db, winnerOrgId, winnerUserId)
    }
  }
})
