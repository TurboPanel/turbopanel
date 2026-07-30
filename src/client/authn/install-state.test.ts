import { assertEquals } from 'jsr:@std/assert@1'
import { and, eq, isNull } from 'drizzle-orm'
import { it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, type Db } from '../../db.ts'
import {
  COLOCATED_SERVER_DISPLAY_NAME,
  completeInstanceInstall,
  DEFAULT_ORGANIZATION_NAME,
  getInstallStatus,
  INSTANCE_ALREADY_CONFIGURED_ERROR,
  INSTANCE_INSTALL_SENTINEL_KEY,
  isInstanceInstalled,
  resolveColocatedServerId,
  rotateColocatedLicenseCredentials,
} from './install-state.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import {
  account,
  grant,
  license,
  member,
  organization,
  server,
  setting,
  team,
  teammate,
  user,
  workspace,
} from '../../lib/db/schema.ts'

const dbUrl = getDatabaseUrl()

it('unmigrated database does not report needsInstall as a normal state', async () => {
  const missingRelation = Object.assign(
    new Error('relation "organization" does not exist'),
    { code: '42P01' },
  )
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.reject(missingRelation),
        }),
      }),
    }),
  } as unknown as Db

  let installedThrew = false
  try {
    await isInstanceInstalled(db)
  } catch (err) {
    installedThrew = true
    if (!(err instanceof Error) || !err.message.includes('does not exist')) {
      throw new Error(`unexpected isInstanceInstalled error: ${err}`)
    }
    if ((err as { code?: string }).code !== '42P01') {
      throw new Error('expected PostgreSQL undefined_table code 42P01')
    }
  }
  if (!installedThrew) {
    throw new Error(
      'expected isInstanceInstalled to throw for an unmigrated database',
    )
  }

  let statusThrew = false
  try {
    await getInstallStatus(db)
  } catch (err) {
    statusThrew = true
    if (!(err instanceof Error) || !err.message.includes('does not exist')) {
      throw new Error(`unexpected getInstallStatus error: ${err}`)
    }
  }
  if (!statusThrew) {
    throw new Error(
      'expected getInstallStatus to throw rather than report needsInstall',
    )
  }
})

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

it('resolveColocatedServerId falls back to the server.hostname column', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping colocated hostname fallback test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  let hostname: string
  try {
    hostname = Deno.hostname()
  } catch {
    console.warn(
      'Skipping colocated hostname fallback test: Deno.hostname() unavailable',
    )
    return
  }

  const db = createDenoDb()
  const now = new Date().toISOString()

  // Two unassigned rows so the single-unassigned fallback cannot rescue this path.
  const [match] = await db
    .insert(server)
    .values({
      hostname,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const [other] = await db
    .insert(server)
    .values({
      hostname: `other-${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })

  try {
    const resolved = await resolveColocatedServerId(db)
    assertEquals(resolved, match!.id)
  } finally {
    await db.delete(server).where(eq(server.id, match!.id))
    await db.delete(server).where(eq(server.id, other!.id))
  }
})

it('rotateColocatedLicenseCredentials revokes stale this-server licenses then mints one', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping colocated license rotate test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: `Colocated License Rotate ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = insertedOrg[0]!.id

  try {
    // Seed one active colocated license (plaintext is intentionally discarded —
    // recovery cannot reuse it).
    const [stale] = await db
      .insert(license)
      .values({
        organizationId,
        displayName: COLOCATED_SERVER_DISPLAY_NAME,
        token: `stale-hash-${crypto.randomUUID()}`,
      })
      .returning({ id: license.id })

    const rotated = await rotateColocatedLicenseCredentials(db, organizationId)

    const active = await db
      .select({ id: license.id, revokedAt: license.revokedAt })
      .from(license)
      .where(and(
        eq(license.organizationId, organizationId),
        eq(license.displayName, COLOCATED_SERVER_DISPLAY_NAME),
        isNull(license.revokedAt),
      ))

    if (active.length !== 1) {
      throw new Error(
        `expected exactly one active colocated license, got ${active.length}`,
      )
    }
    if (active[0]?.id !== rotated.licenseId) {
      throw new Error('active colocated license id does not match rotated mint')
    }
    if (active[0]?.id === stale!.id) {
      throw new Error('stale colocated license must not remain active')
    }

    const staleRow = await db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, stale!.id))
      .limit(1)
    if (!staleRow[0]?.revokedAt) {
      throw new Error('stale colocated license must be revoked')
    }

    if (!rotated.licenseToken || rotated.licenseToken.length < 8) {
      throw new Error('rotated mint must return a plaintext token once')
    }
  } finally {
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
