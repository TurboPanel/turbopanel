/**
 * Turn "the sweep noticed something" into notifications.
 *
 * Both runtimes' sweeps call this — the Workers cron (`offline-sweep.ts`) and
 * the self-hosted Deno/Redis timer (`control-plane-monitor.ts` via
 * `platform/deno/server.ts`). Alerting that exists on only one of them is alerting
 * most instances do not have.
 *
 * Since 2026-09-18 an alert is an event in the notifications pipeline
 * (`src/features/notifications/`): it lands in the inbox of everyone in the
 * server's organization (or every instance admin, for the fleet-wide
 * aggregate) and reaches every channel a rule routes it to — including the
 * operator's instance-wide webhook, which the legacy setting is folded into
 * here on first touch so an upgraded instance keeps alerting. Nothing here
 * throws: a sweep's job is to demote stale servers, and it runs whether or
 * not anyone can be told about it.
 */
import { eq } from "drizzle-orm";
import { type Db, runWithDbTimeout } from "../../db/connection.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import { server } from "../../db/schema.ts";
import type { Alert, AlertSender } from "./alert-sender.ts";
import {
  adoptLegacyAlertWebhook,
  type AlertWebhookPolicy,
  ALERT_WEBHOOK_POLICY,
} from "./alert-webhook-settings.ts";
import { type EmitEmail, emitNotification } from "../notifications/emit.ts";
import type {
  NotificationContext,
  NotificationEvent,
} from "../notifications/events.ts";

export type AlertSenderTrace = (
  event:
    | "alert-sender-resolve-failed"
    | "alert-server-unknown",
  detail: Record<string, unknown>,
) => void;

type MappedEvent = {
  event: NotificationEvent;
  organizationId: string | null;
  context: NotificationContext;
  targetId: string | null;
};

/** An alert's kind is an event code; its detail is the event's context, plus what the server row adds. */
async function toEvent(
  db: Db,
  alert: Alert,
  trace: AlertSenderTrace | undefined,
): Promise<MappedEvent | null> {
  const context: NotificationContext = {};
  for (const [key, value] of Object.entries(alert.detail ?? {})) {
    if (value !== undefined) context[key] = value;
  }
  if (alert.kind === "fleet.mass_disconnect") {
    if (typeof context.staleCount === "number") {
      context.count = context.staleCount;
    }
    return {
      event: "fleet.mass_disconnect",
      organizationId: null,
      context,
      targetId: null,
    };
  }
  const serverId = typeof context.serverId === "string"
    ? context.serverId
    : null;
  if (!serverId) return null;
  const rows = await runWithDbTimeout(db, (tx) =>
    tx
      .select({
        organizationId: server.organizationId,
        name: server.name,
        hostname: server.hostname,
      })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1));
  const row = rows[0];
  if (!row?.organizationId) {
    trace?.("alert-server-unknown", { serverId });
    return null;
  }
  context.serverName = row.name ?? row.hostname ?? serverId;
  return {
    event: "server.offline",
    organizationId: row.organizationId,
    context,
    targetId: serverId,
  };
}

export async function resolveAlertSender(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  trace?: AlertSenderTrace,
  policy: AlertWebhookPolicy = ALERT_WEBHOOK_POLICY,
  email?: EmitEmail,
): Promise<AlertSender> {
  // An instance upgraded past the ALERT_WEBHOOK_URL setting keeps its
  // webhook: the setting becomes an instance channel on first touch, and the
  // pipeline below reaches it like any other. Bounded, and never the reason
  // a sweep fails.
  try {
    await runWithDbTimeout(
      db,
      (tx) => adoptLegacyAlertWebhook(tx, dataEncryptionSecrets),
    );
  } catch (err) {
    trace?.("alert-sender-resolve-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return async (alert) => {
    try {
      const mapped = await toEvent(db, alert, trace);
      if (!mapped) return;
      await emitNotification(db, dataEncryptionSecrets, {
        event: mapped.event,
        organizationId: mapped.organizationId,
        context: mapped.context,
        targetType: mapped.targetId ? "server" : null,
        targetId: mapped.targetId,
      }, { allowPrivateTargets: policy.allowPrivateTargets, email });
    } catch (err) {
      // emitNotification never throws; this guards the lookup above.
      trace?.("alert-sender-resolve-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
