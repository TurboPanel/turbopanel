/**
 * The record of a server joining or replacing its daemon key: an audit row
 * and a notification to the organization's managers. Servers are accepted
 * automatically; this is how owners find out. Never throws into the enroll
 * path.
 *
 * Workers-bundleable: nothing at module load.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { recordAudit, type AuditAction } from '../audit/audit-records.ts'
import { emitNotification } from '../notifications/emit.ts'
import { shortFingerprint } from '../notifications/repo-key-alerts.ts'

type Announcement = {
  event: 'server.enrolled' | 'server.key_replaced'
  action: AuditAction
  organizationId: string
  serverId: string
  serverName: string | null
  context: Record<string, string>
}

async function announce(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  a: Announcement
): Promise<void> {
  try {
    await recordAudit(db, {
      organizationId: a.organizationId,
      action: a.action,
      targetType: 'server',
      targetId: a.serverId,
      context: a.context,
    })
    await emitNotification(
      db,
      secrets,
      {
        event: a.event,
        organizationId: a.organizationId,
        context: { serverName: a.serverName ?? 'A new server', ...a.context },
        targetType: 'server',
        targetId: a.serverId,
      },
      { allowPrivateTargets: true }
    )
  } catch (err) {
    compatLogWarn(
      'enroll-announce',
      `${a.event} not announced: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** A new server enrolled with an install key. */
export function announceServerEnrolled(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: {
    organizationId: string
    serverId: string
    serverName: string | null
    fingerprint: string
  }
): Promise<void> {
  return announce(db, secrets, {
    event: 'server.enrolled',
    action: 'server.enroll',
    ...input,
    context: { daemonKey: shortFingerprint(input.fingerprint) },
  })
}

/** A re-enroll ticket replaced a server's daemon key. */
export function announceKeyReplaced(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: {
    organizationId: string
    serverId: string
    serverName: string | null
    oldFingerprint: string
    newFingerprint: string
  }
): Promise<void> {
  return announce(db, secrets, {
    event: 'server.key_replaced',
    action: 'server.key_replace',
    organizationId: input.organizationId,
    serverId: input.serverId,
    serverName: input.serverName,
    context: {
      oldKey: shortFingerprint(input.oldFingerprint),
      newKey: shortFingerprint(input.newFingerprint),
    },
  })
}

/** The organization and display name of a server, or null for an unassigned one. */
export async function loadServerForAnnouncement(
  db: Db,
  serverId: string
): Promise<{ organizationId: string; serverName: string | null } | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId, name: server.name })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.organizationId ? { organizationId: row.organizationId, serverName: row.name } : null
}
