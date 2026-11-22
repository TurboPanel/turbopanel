/**
 * The audit trail: who did a security-relevant thing, to what, and when.
 *
 * Three guards in this codebase already told the reader they were "audited"
 * (the privileged-compose org gate, the daemon-key revoke route, the ACME
 * gate) while no audit facility existed. This is the one they meant.
 *
 * Shape of the contract:
 *
 * - **Append-only.** Nothing here updates or deletes a row, and the table has
 *   no `updated_at`. A trail an operator can edit after the fact is not one.
 * - **Never the thing that fails the request.** A write that cannot be
 *   recorded is logged and swallowed: refusing a revoke because its audit row
 *   would not insert turns an incident-response tool into an outage. The
 *   inverse — recording an action that did not happen — is prevented by
 *   calling this only after the action's own write has succeeded.
 * - **No secrets in `context`.** Record the fact and the identifiers, never
 *   the credential that changed; the same rule `setting` rows follow.
 */
import { and, desc, eq, gt, gte, lt, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { audit, server } from '../../db/schema.ts'
import { logWarn } from '../../lib/logger.ts'
import { auditBoundaryId } from './prune.ts'

/**
 * Every action this build records, as `<subject>.<verb>` or
 * `<subject>.<part>.<verb>`.
 *
 * Deliberately **not** a database CHECK, unlike the fixed vocabularies in
 * `schema.ts`: this list grows with every route that starts auditing, and a
 * CHECK would make each of those a migration. A value outside this list is a
 * display problem, not an integrity one — the column is a label, nothing
 * branches on it.
 */
export const AUDIT_ACTIONS = [
  'server.daemon_key.revoke',
  'server.license_tier.set',
  'server.delete',
  'grant.create',
  'grant.delete',
  'member.remove',
  'forge.create',
  'forge.update',
  'forge.delete',
  'organization.compose_privileged_fields.set',
  'compose.host_access.approve',
  'compose.host_access.use',
  'compose.network_shares.approve',
  'compose.network_shares.use',
  'server.network_shares.update',
  'organization.compose_remote_build_sources.set',
  'organization.build_limits.set',
  'organization.deploy_hooks.set',
  'organization.compose_resource_defaults.set',
  'organization.acme.set',
  'organization.acme_contact.set',
  'organization.acme_terms.accept',
  'organization.deploy_timeout.set',
  'organization.reauth_for_destructive.set',
  'organization.delete',
  'organization.icon.set',
  'organization.emoji_icons.set',
  'server.firewall_mode.set',
  'server.managed_external_access.update',
  'server.addresses.set',
  'deployment.cancel',
  'hosting.letsencrypt.requested',
  'hosting.letsencrypt.dropped',
  'tls.certificate.store',
  'tls.certificate.key_erase',
  'tls.certificate.delete',
  'mail.dead_letter.replay',
  'instance.primary_hostname_changed',
  'upgrade.pause',
  'upgrade.resume',
  'upgrade.start_now',
  'upgrade.dev_push',
  'upgrade.dev_host_update',
  'upgrade.dev_host_restart',
  'binding.create',
  'binding.update',
  'binding.delete',
  'tls.ca.retire',
  'tls.leaf.renew',
  'tls.leaf.stale',
  'tls.leaf.delete',
  'folder.remove',
  'environment.primary.set',
  'environment.delete',
  'environment.data.delete',
  'project.delete',
  'principal.delete',
  'managed.database.owner_role.move',
  'managed.backup_login.create',
  'managed.backup_login.delete',
  'managed.admin_tool.create',
  'managed.admin_tool.password',
  'managed.admin_tool.update',
  'managed.admin_tool.delete',
  'backup_target.create',
  'backup_target.update',
  'backup_target.delete',
  'backup_target.assign',
  'carrier.create',
  'carrier.delete',
  'badge.create',
  'badge.check',
  'badge.delete',
  'badge.zone_add',
  'badge.zone_remove',
  'origin_certificate.issue',
  'origin_certificate.revoke',
  'tunnel.create',
  'tunnel.update',
  'tunnel.run_token.rotate',
  'tunnel.delete',
  'doorway.create',
  'doorway.update',
  'doorway.dns_replace_failed',
  'doorway.delete',
  'server.tunnel_carrying',
  'tls.dns_certificate.create',
  'tls.dns_certificate.retry',
  'fabric.pause',
  'fabric.resume',
  'fabric.remove',
  'server.fabric.set',
  'server.enroll',
  'server.key_replace',
  'server.reenroll_ticket.issue',
  'server.reenroll_ticket.revoke',
  'server.colocated_repair',
  'server.sealing_key.clear',
  'license.key.burn',
  'panel.identity.generated',
  'panel.identity_next.set',
  'panel.identity_next.clear',
  // Written by key rotation and emergency revoke (they land with those
  // changes); named here so the vocabulary is complete.
  'panel.identity.rotated',
  'panel.identity.revoked',
  // A passkey-approved key-set statement: rotate, revoke, mark, unmark.
  'panel.key.rotate',
  'panel.key.revoke',
  'panel.approver.mark',
  'panel.approver.unmark',
  // A High Availability key change cancelled while it waited for its key.
  'panel.key.cancel',
  'server.panel_pin.reissued',
  'server.panel_pin.mismatch',
  'server.panel_pin.silent',
  'server.panel_pin.missing',
  'server.trust_downgrade.refused',
  'instance.tunnel_token.set',
  'instance.ingress_account.added',
  'instance.ingress_account.removed',
  'instance.ingress_account.rechecked',
  'instance.edge_gate.set',
  'instance.hostname_ingress.changed',
  'instance.hostname_ingress.applied',
  'instance.hostname_ingress.removed',
  'instance.dns01.ordered',
  'server.terminal.open',
  'server.terminal.close',
  'server.terminal_settings.update',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEntry = {
  /** Null for an instance-wide action that belongs to no organization. */
  organizationId: string | null
  /** Null only for an action the platform took on nobody's behalf. */
  actorUserId?: string | null
  /** Denormalized so the trail survives the account's deletion. */
  actorEmail?: string | null
  action: AuditAction
  /** A catalog entity kind, or `organization`. */
  targetType: string
  targetId?: string | null
  /** Small, non-secret facts worth keeping beside the action. */
  context?: Record<string, unknown> | null
}

/**
 * Record one action. Never throws: see the module header — an audit write
 * must not be the reason an operator's action fails.
 */
export async function recordAudit(db: Db | undefined, entry: AuditEntry): Promise<void> {
  if (db === undefined) return
  try {
    await db.insert(audit).values({
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      context: entry.context ?? null,
    })
  } catch (err) {
    logWarn(
      'audit',
      `failed to record ${entry.action} on ${entry.targetType} ${
        entry.targetId ?? '-'
      }: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export type AuditRecord = {
  id: string
  createdAt: string
  actorUserId: string | null
  actorEmail: string | null
  action: string
  targetType: string
  targetId: string | null
  context: unknown
}

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_MAX_PAGE_SIZE = 200

/**
 * One organization's trail, newest first. Keyset pagination on `created_at`:
 * the ids are uuidv7 so insertion order and time order agree, and a cursor
 * cannot drift the way an offset does while rows are being appended.
 */
export async function listAuditForOrganization(
  db: Db,
  params: {
    organizationId: string
    /** `created_at` of the last row of the previous page. */
    before?: string
    limit?: number
  }
): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(1, params.limit ?? AUDIT_PAGE_SIZE), AUDIT_MAX_PAGE_SIZE)
  const where = params.before
    ? and(eq(audit.organizationId, params.organizationId), lt(audit.createdAt, params.before))
    : eq(audit.organizationId, params.organizationId)

  const rows = await db
    .select({
      id: audit.id,
      createdAt: audit.createdAt,
      actorUserId: audit.actorUserId,
      actorEmail: audit.actorEmail,
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
      context: audit.context,
    })
    .from(audit)
    .where(where)
    .orderBy(desc(audit.createdAt), desc(audit.id))
    .limit(limit)

  return rows
}

/**
 * Record one action and throw when the row could not be written. For an
 * action that must not happen unrecorded (a terminal opening): the caller
 * refuses the action when this throws, where {@link recordAudit} would only
 * log.
 */
export async function recordAuditOrThrow(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(audit).values({
    organizationId: entry.organizationId ?? null,
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    context: entry.context ?? null,
  })
}

/** A terminal open row whose session may still owe its close row. */
export type TerminalOpenAudit = {
  organizationId: string | null
  actorUserId: string | null
  context: Record<string, unknown>
  /** A `server.terminal.close` row for the same sid already exists. */
  closed: boolean
}

/** How far back a late daemon report may look for its open row (a session lasts at most 8 h). */
const TERMINAL_OPEN_LOOKBACK_HOURS = 12

/** The cross-organization lookup's window: a session lasts at most 8 h, plus slack. */
const TERMINAL_MOVED_LOOKBACK_HOURS = 9

/**
 * The open row of one terminal session on one server, by sid, for a daemon
 * report that arrives when the control plane no longer remembers the session.
 * The sid is a random UUID the control plane minted; the server id keeps one
 * daemon from closing another server's session. Null when there is no such row.
 *
 * The open row sits under the organization that owned the server when the
 * session opened, which is not always the one that owns it now (a server can
 * move, or lose its organization). The server's current organization is tried
 * first because it keeps the scan on the organization's audit index; when it
 * has no such row the scan runs over every organization, bounded by the
 * lookback on the time-ordered primary key.
 */
export async function findTerminalOpenAudit(
  db: Db,
  serverId: string,
  sid: string
): Promise<TerminalOpenAudit | null> {
  const [owner] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (owner?.organizationId) {
    const found = await scanTerminalAudit(db, serverId, sid, owner.organizationId)
    if (found) return found
  }
  return scanMovedTerminalAudit(db, serverId, sid)
}

/**
 * The cross-organization lookup, for a session whose open row is not under the
 * server's current organization. It has no organization index to use, so it
 * stays small: the open row alone (one row), inside the window a session can
 * still be open in (8 hours plus an hour of slack) on the time-ordered key; the
 * close row is then looked for only after the open row's own id.
 */
async function scanMovedTerminalAudit(
  db: Db,
  serverId: string,
  sid: string
): Promise<TerminalOpenAudit | null> {
  const [open] = await db
    .select({
      id: audit.id,
      organizationId: audit.organizationId,
      actorUserId: audit.actorUserId,
      context: audit.context,
    })
    .from(audit)
    .where(
      and(
        gte(audit.id, auditBoundaryId(Date.now() - TERMINAL_MOVED_LOOKBACK_HOURS * 3_600_000)),
        eq(audit.action, 'server.terminal.open'),
        eq(audit.targetId, serverId),
        sql`${audit.context}->>'sid' = ${sid}`
      )
    )
    .limit(1)
  if (!open) return null
  const [close] = await db
    .select({ id: audit.id })
    .from(audit)
    .where(
      and(
        gte(audit.id, open.id),
        eq(audit.action, 'server.terminal.close'),
        eq(audit.targetId, serverId),
        sql`${audit.context}->>'sid' = ${sid}`
      )
    )
    .limit(1)
  return {
    organizationId: open.organizationId,
    actorUserId: open.actorUserId,
    context:
      open.context && typeof open.context === 'object'
        ? (open.context as Record<string, unknown>)
        : {},
    closed: close !== undefined,
  }
}

async function scanTerminalAudit(
  db: Db,
  serverId: string,
  sid: string,
  organizationId: string
): Promise<TerminalOpenAudit | null> {
  const since = sql`now() - make_interval(hours => ${TERMINAL_OPEN_LOOKBACK_HOURS})`
  const rows = await db
    .select({
      action: audit.action,
      organizationId: audit.organizationId,
      actorUserId: audit.actorUserId,
      context: audit.context,
    })
    .from(audit)
    .where(
      and(
        eq(audit.organizationId, organizationId),
        eq(audit.targetId, serverId),
        gt(audit.createdAt, since),
        sql`${audit.context}->>'sid' = ${sid}`,
        sql`${audit.action} in ('server.terminal.open', 'server.terminal.close')`
      )
    )
  const open = rows.find((row) => row.action === 'server.terminal.open')
  if (!open) return null
  const context =
    open.context && typeof open.context === 'object'
      ? (open.context as Record<string, unknown>)
      : {}
  return {
    organizationId: open.organizationId,
    actorUserId: open.actorUserId,
    context,
    closed: rows.some((row) => row.action === 'server.terminal.close'),
  }
}

/** Why a close row was written for a session nothing reported the end of. */
export const TERMINAL_LOST_CLOSE_REASON = 'lost:no-close-report'

/**
 * A session lasts at most 8 hours; an open row older than this with no close
 * row belongs to a session whose end nobody reported (the cell was replaced or
 * evicted and the daemon's report never arrived).
 */
const TERMINAL_ABANDONED_AFTER_HOURS = 9

/** How far back the abandoned-open scan looks (bounded on the time-ordered id). */
const TERMINAL_ABANDONED_LOOKBACK_HOURS = 48

/**
 * Write the close row for every terminal open row old enough that its session
 * must be over and that has none, against the organization of the open row.
 * Returns how many rows it wrote. Run from the periodic sweeps; a close row
 * that a late report wrote first is found and left alone.
 */
export async function closeAbandonedTerminalOpens(
  db: Db,
  opts: { nowMs?: number; limit?: number } = {}
): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now()
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500)
  const newest = auditBoundaryId(nowMs - TERMINAL_ABANDONED_AFTER_HOURS * 3_600_000)
  const oldest = auditBoundaryId(nowMs - TERMINAL_ABANDONED_LOOKBACK_HOURS * 3_600_000)
  const rows = await db
    .select({
      targetId: audit.targetId,
      organizationId: audit.organizationId,
      actorUserId: audit.actorUserId,
      context: audit.context,
    })
    .from(audit)
    .where(
      and(
        eq(audit.action, 'server.terminal.open'),
        gte(audit.id, oldest),
        lt(audit.id, newest),
        sql`not exists (
          select 1 from audit c
          where c.action = 'server.terminal.close'
            and c.id >= ${oldest}
            and c.target_id = ${audit.targetId}
            and c.context->>'sid' = ${audit.context}->>'sid'
        )`
      )
    )
    .limit(limit)
  const writes = rows.flatMap((open) => {
    const context =
      open.context && typeof open.context === 'object'
        ? (open.context as Record<string, unknown>)
        : {}
    if (!open.targetId || typeof context.sid !== 'string') return []
    return [
      recordAudit(db, {
        organizationId: open.organizationId,
        actorUserId: open.actorUserId,
        action: 'server.terminal.close',
        targetType: 'server',
        targetId: open.targetId,
        context: {
          sid: context.sid,
          kind: context.kind,
          containerId: context.containerId,
          loginUser: context.loginUser,
          reason: TERMINAL_LOST_CLOSE_REASON,
          confirmed: false,
        },
      }),
    ]
  })
  await Promise.all(writes)
  const written = writes.length
  return written
}
