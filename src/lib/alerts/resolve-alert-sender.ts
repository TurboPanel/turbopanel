/**
 * Turn "the sweep noticed something" into notifications.
 *
 * Both runtimes' sweeps call this — the Workers cron (`offline-sweep.ts`) and
 * the self-hosted Deno/Redis timer (`control-plane-monitor.ts` via
 * `deno-server.ts`). Alerting that exists on only one of them is alerting
 * most instances do not have.
 *
 * Since 2026-09-18 an alert is an event in the notifications pipeline
 * (`src/lib/notifications/`): it lands in the inbox of everyone in the
 * server's organization (or every instance admin, for the fleet-wide
 * aggregate) and reaches every channel a rule routes it to. The operator's
 * instance-wide webhook setting — the alerting that existed before the
 * pipeline — is still honoured as one more destination, read per tick so a
 * webhook configured mid-incident gets the next sweep's alerts. Nothing here
 * throws: a sweep's job is to demote stale servers, and it runs whether or
 * not anyone can be told about it.
 */
import { eq } from "drizzle-orm";
import { type Db, runWithDbTimeout } from "../../db.ts";
import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import { server } from "../db/schema.ts";
import {
  type Alert,
  type AlertSender,
  createWebhookAlertSender,
  NOOP_ALERT_SENDER,
} from "./alert-sender.ts";
import {
  type AlertWebhookPolicy,
  getAlertWebhookUrl,
  HOSTED_ALERT_WEBHOOK_POLICY,
} from "./alert-webhook-settings.ts";
import { validateOutboundUrl } from "../http/outbound-url.ts";
import { emitNotification } from "../notifications/emit.ts";
import type {
  NotificationContext,
  NotificationEvent,
} from "../notifications/events.ts";

export type AlertSenderTrace = (
  event:
    | "alert-webhook-refused"
    | "alert-sender-resolve-failed"
    | "alert-server-unknown",
  detail: Record<string, unknown>,
) => void;

/** The legacy instance-wide webhook as a sender, or the no-op when none is configured. */
async function resolveLegacyWebhookSender(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  trace: AlertSenderTrace | undefined,
  policy: AlertWebhookPolicy,
): Promise<AlertSender> {
  try {
    // Bounded: this read sits on a sweep's critical path, and a slow — not
    // dead — Postgres must not hold a tick open over a settings lookup.
    const url = await runWithDbTimeout(
      db,
      (settingDb) => getAlertWebhookUrl(settingDb, dataEncryptionSecrets),
    );
    if (!url) return NOOP_ALERT_SENDER;
    // Re-validated here, not only at write time: this is the choke point
    // where the URL becomes an outbound fetch, and the stored value may
    // predate the gate (an unsealed legacy row) or have been written by
    // something other than the settings route.
    const rejection = validateOutboundUrl(url, {
      allowPrivate: policy.allowPrivateTargets,
    });
    if (rejection) {
      trace?.("alert-webhook-refused", { reason: rejection });
      return NOOP_ALERT_SENDER;
    }
    return createWebhookAlertSender(url);
  } catch (err) {
    trace?.("alert-sender-resolve-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NOOP_ALERT_SENDER;
  }
}

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
  policy: AlertWebhookPolicy = HOSTED_ALERT_WEBHOOK_POLICY,
): Promise<AlertSender> {
  const legacy = await resolveLegacyWebhookSender(
    db,
    dataEncryptionSecrets,
    trace,
    policy,
  );
  return async (alert) => {
    // The legacy webhook first: it is what an operator configured before the
    // pipeline existed, and it must not wait behind the fan-out.
    await legacy(alert);
    try {
      const mapped = await toEvent(db, alert, trace);
      if (!mapped) return;
      await emitNotification(db, dataEncryptionSecrets, {
        event: mapped.event,
        organizationId: mapped.organizationId,
        context: mapped.context,
        targetType: mapped.targetId ? "server" : null,
        targetId: mapped.targetId,
      }, { allowPrivateTargets: policy.allowPrivateTargets });
    } catch (err) {
      // emitNotification never throws; this guards the lookup above.
      trace?.("alert-sender-resolve-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
