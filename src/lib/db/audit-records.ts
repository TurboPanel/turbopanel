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
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { audit } from "./schema.ts";
import { logWarn } from "../../logger.ts";

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
  "server.daemon_key.revoke",
  "server.delete",
  "grant.create",
  "grant.delete",
  "forge.create",
  "forge.update",
  "forge.delete",
  "organization.compose_privileged_fields.set",
  "organization.deploy_hooks.set",
  "organization.compose_resource_defaults.set",
  "organization.acme.set",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  /** Null for an instance-wide action that belongs to no organization. */
  organizationId: string | null;
  /** Null only for an action the platform took on nobody's behalf. */
  actorUserId?: string | null;
  /** Denormalized so the trail survives the account's deletion. */
  actorEmail?: string | null;
  action: AuditAction;
  /** A catalog entity kind, or `organization`. */
  targetType: string;
  targetId?: string | null;
  /** Small, non-secret facts worth keeping beside the action. */
  context?: Record<string, unknown> | null;
};

/**
 * Record one action. Never throws: see the module header — an audit write
 * must not be the reason an operator's action fails.
 */
export async function recordAudit(
  db: Db | undefined,
  entry: AuditEntry,
): Promise<void> {
  if (db === undefined) return;
  try {
    await db.insert(audit).values({
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      context: entry.context ?? null,
    });
  } catch (err) {
    logWarn(
      "audit",
      `failed to record ${entry.action} on ${entry.targetType} ${
        entry.targetId ?? "-"
      }: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type AuditRecord = {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  context: unknown;
};

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

/**
 * One organization's trail, newest first. Keyset pagination on `created_at`:
 * the ids are uuidv7 so insertion order and time order agree, and a cursor
 * cannot drift the way an offset does while rows are being appended.
 */
export async function listAuditForOrganization(
  db: Db,
  params: {
    organizationId: string;
    /** `created_at` of the last row of the previous page. */
    before?: string;
    limit?: number;
  },
): Promise<AuditRecord[]> {
  const limit = Math.min(
    Math.max(1, params.limit ?? AUDIT_PAGE_SIZE),
    AUDIT_MAX_PAGE_SIZE,
  );
  const where = params.before
    ? and(
      eq(audit.organizationId, params.organizationId),
      lt(audit.createdAt, params.before),
    )
    : eq(audit.organizationId, params.organizationId);

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
    .limit(limit);

  return rows;
}
