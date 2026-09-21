/**
 * The audit trail is where the platform already records the operator
 * actions a teammate would want to hear about, so the emitters for those
 * events sit beside the audit write rather than in every route twice.
 *
 * `recordAuditAndNotify` records the audit row exactly as `recordAudit` does
 * (never throwing), then emits the matching event for the actions in
 * {@link AUDIT_EVENTS}. An action with no entry here is audited and nothing
 * more — adding an event means adding it to the catalogue and to this map in
 * the same commit.
 */
import type { Context } from "hono";
import type { Db } from "../../db/connection.ts";
import type { EmailQueue } from "../email/types.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import {
  type AuditAction,
  type AuditEntry,
  recordAudit,
} from "../audit/audit-records.ts";
import { emitNotification } from "./emit.ts";
import { getEmailQueue } from "../email/types.ts";
import { resolvePublicBaseUrl } from "../install/resolve-public-base-url.ts";
import type { NotificationContext, NotificationEvent } from "./events.ts";

export const AUDIT_EVENTS: Partial<Record<AuditAction, NotificationEvent>> = {
  "server.daemon_key.revoke": "server.daemon_key_revoked",
  "server.delete": "server.deleted",
  "grant.create": "access.grant_created",
  "grant.delete": "access.grant_revoked",
};

/** The non-secret facts an event renders from: the audit context plus who acted. */
function contextFor(
  entry: AuditEntry,
  extra: NotificationContext,
): NotificationContext {
  const context: NotificationContext = {};
  for (const [key, value] of Object.entries(entry.context ?? {})) {
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      context[key] = value;
    }
  }
  if (entry.actorEmail) context.actorEmail = entry.actorEmail;
  return { ...context, ...extra };
}

type AuditNotifyEnv = {
  Variables: {
    db?: Db
    emailQueue?: EmailQueue
    emailFrom?: string
    dataEncryptionSecrets?: DerivedSecretsConfig
  }
}

export async function recordAuditAndNotify(
  c: Context<AuditNotifyEnv>,
  entry: AuditEntry,
  extra: NotificationContext = {},
): Promise<void> {
  const db = c.get("db");
  await recordAudit(db, entry);
  const event = AUDIT_EVENTS[entry.action];
  if (!event || !db || !entry.organizationId) return;
  const queue = getEmailQueue(c);
  const email = queue
    ? {
      queue,
      from: c.get("emailFrom") || "noreply@turbopanel.local",
      consoleBaseUrl: await resolvePublicBaseUrl(c).catch(() => null),
    }
    : undefined;
  await emitNotification(db, c.get("dataEncryptionSecrets"), {
    event,
    organizationId: entry.organizationId,
    context: contextFor(entry, extra),
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
  }, { allowPrivateTargets: true, email });
}
