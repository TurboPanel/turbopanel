/**
 * "This happened" → inbox rows for everyone concerned, and one delivery per
 * channel a rule routes it to.
 *
 * The one rule above all others, inherited from `alert-sender.ts`: **emitting
 * never fails the emitter.** The offline sweep's job is to demote stale
 * servers; a deploy route's job is to deploy. If the notifications table is
 * missing, Postgres is slow, or Slack is down, the thing being reported on
 * must still finish. So every phase here is bounded and caught, and the only
 * promise to a caller is that awaiting `emitNotification` terminates.
 *
 * Fan-out (decided 2026-09-18):
 * - inbox rows go to every member of the organization the event belongs to
 *   (through team membership), or to every instance admin for an
 *   instance-scoped event — no subscription needed for the bell;
 * - external channels receive an event only through a rule row, within
 *   scope: the organization's channels and its members' own, plus every
 *   instance channel (an operator's firehose sees every organization).
 *
 * Delivery runs inline, once, bounded; a failure leaves a `failed` ledger row
 * with a retry time that the maintenance tick (`retryDueDeliveries`) picks
 * up, up to the attempt cap. Email and push channels are not sent from here:
 * their rows stay `pending` for the transports that own them.
 */
import { type Db, runWithDbTimeout } from "../../db.ts";
import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import { compatLogWarn } from "../../log-compat.ts";
import { validateOutboundUrl } from "../http/outbound-url.ts";
import {
  describeEvent,
  eventAudience,
  eventScope,
  eventSeverity,
  type NotificationContext,
  type NotificationEvent,
} from "./events.ts";
import {
  channelsForEvent,
  type DeliveryPayload,
  getChannel,
  insertNotifications,
  insertPendingDeliveries,
  instanceAdminIds,
  listDueDeliveries,
  type NotificationChannelRecord,
  type NotificationDeliveryRecord,
  organizationManagerIds,
  organizationMemberIds,
  organizationName,
  recordDeliveryAttempt,
  resolveChannelAddress,
  resolveChannelSigningSecret,
} from "./records.ts";
import { renderDetails, send, type SendOutcome } from "./senders.ts";
import type { EmailJob, EmailQueue } from "../email/types.ts";

export type EmitInput = {
  event: NotificationEvent;
  /** Required for an organization-scoped event; ignored for an instance-scoped one. */
  organizationId?: string | null;
  context?: NotificationContext;
  targetType?: string | null;
  targetId?: string | null;
};

export type EmitEmail = {
  queue: EmailQueue;
  from: string;
  /** The console's public base URL, for the "Open in TurboPanel" link; null when unknown. */
  consoleBaseUrl?: string | null;
};

export type EmitDeps = {
  fetchImpl?: typeof fetch;
  /** Self-hosted may deliver to a LAN address; hosted may not (decided 2026-09-18). */
  allowPrivateTargets?: boolean;
  /** Without this, email channels' deliveries stay pending for a later tick that has a queue. */
  email?: EmitEmail;
  now?: () => number;
  trace?: (event: string, detail: Record<string, unknown>) => void;
};

export type EmitResult = {
  inbox: number;
  deliveries: number;
  sent: number;
  failed: number;
};

const EMPTY: EmitResult = { inbox: 0, deliveries: 0, sent: 0, failed: 0 };

/** How long the whole delivery phase of one emit may take. */
export const EMIT_DELIVERY_BUDGET_MS = 5_000;

export async function emitNotification(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: EmitInput,
  deps: EmitDeps = {},
): Promise<EmitResult> {
  const trace = deps.trace ?? (() => {});
  try {
    const scope = eventScope(input.event);
    const organizationId = scope === "organization"
      ? input.organizationId ?? null
      : null;
    if (scope === "organization" && !organizationId) {
      trace("notification-skipped", {
        event: input.event,
        reason: "organization_required",
      });
      return EMPTY;
    }
    const context = input.context ?? {};
    const severity = eventSeverity(input.event);
    const { title, body } = describeEvent(input.event, context);
    const payload: DeliveryPayload = {
      event: input.event,
      severity,
      title,
      body,
      organizationId,
      organizationName: organizationId
        ? await runWithDbTimeout(
          db,
          (tx) => organizationName(tx, organizationId),
        )
        : null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      context,
      at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    };

    // Phase one, bounded: the inbox rows and the pending ledger rows for
    // every routed channel. Not one transaction — a ledger row that lands
    // without its inbox rows (or the reverse) is still a true record — so
    // the writes are ordered inbox first, ledger second.
    const written = await runWithDbTimeout(db, async (tx) => {
      const recipients = organizationId
        ? eventAudience(input.event) === "managers"
          ? await organizationManagerIds(tx, organizationId)
          : await organizationMemberIds(tx, organizationId)
        : await instanceAdminIds(tx);
      const inbox = await insertNotifications(
        tx,
        recipients.map((userId) => ({
          userId,
          organizationId,
          event: payload.event,
          severity,
          title,
          body,
          targetType: payload.targetType,
          targetId: payload.targetId,
          context,
        })),
      );
      const channels = await channelsForEvent(
        tx,
        payload.event,
        severity,
        organizationId,
      );
      const deliveries = await insertPendingDeliveries(
        tx,
        channels.map((c) => c.id),
        payload,
      );
      return { inbox, channels, deliveries };
    });

    // Phase two: attempt each routed channel once, inside a budget.
    const byId = new Map(written.channels.map((c) => [c.id, c]));
    const outcome = await attemptDeliveries(
      db,
      secrets,
      written.deliveries.map((d) => ({
        delivery: d,
        channel: byId.get(d.channelId) ?? null,
      })),
      deps,
      EMIT_DELIVERY_BUDGET_MS,
    );
    return {
      inbox: written.inbox,
      deliveries: written.deliveries.length,
      sent: outcome.sent,
      failed: outcome.failed,
    };
  } catch (error) {
    compatLogWarn(
      "notifications",
      `emit ${input.event} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    trace("notification-emit-failed", { event: input.event });
    return EMPTY;
  }
}

/**
 * Sent from the ledger: never push (the Expo transport owns it), email only
 * when this tick has a queue to hand it to, never a disabled channel.
 */
function deliverableHere(
  channel: NotificationChannelRecord | null,
  deps: EmitDeps,
): channel is NotificationChannelRecord {
  if (channel === null || channel.disabledAt !== null) return false;
  if (channel.kind === "push") return false;
  // An email address is delivered to only once it is known to be the
  // recipient's (decided 2026-09-18): the route sets `verified_at` when the
  // address is the caller's own or a member's account email; anything else
  // waits for a verification flow that does not exist yet.
  if (channel.kind === "email") {
    return deps.email !== undefined && channel.verifiedAt !== null;
  }
  return true;
}

/** Where the console shows the event's target, when it has one. */
export function consoleUrlFor(
  base: string | null | undefined,
  payload: DeliveryPayload,
): string | null {
  if (!base) return null;
  const root = base.replace(/\/$/, "");
  if (
    payload.organizationId && payload.targetType === "server" &&
    payload.targetId
  ) {
    return `${root}/${payload.organizationId}/servers/${payload.targetId}`;
  }
  if (payload.organizationId) {
    return `${root}/${payload.organizationId}/overview`;
  }
  return root;
}

async function enqueueEmail(
  email: EmitEmail,
  to: string,
  payload: DeliveryPayload,
): Promise<SendOutcome> {
  const job: EmailJob = {
    type: "notification",
    to,
    from: email.from,
    event: payload.event,
    severity: payload.severity,
    title: payload.title,
    body: payload.body,
    details: renderDetails(payload),
    organizationName: payload.organizationName,
    consoleUrl: consoleUrlFor(email.consoleBaseUrl, payload),
    at: payload.at,
  };
  try {
    await email.queue.enqueue(job);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `queue_${error.name}` : "queue",
    };
  }
}

async function attemptOne(
  secrets: DerivedSecretsConfig | undefined,
  channel: NotificationChannelRecord,
  delivery: NotificationDeliveryRecord,
  deps: EmitDeps,
): Promise<SendOutcome> {
  const address = await resolveChannelAddress(secrets, channel);
  if (address === null) return { ok: false, error: "address_unreadable" };
  if (channel.kind === "email") {
    return deps.email
      ? await enqueueEmail(deps.email, address, delivery.payload)
      : { ok: false, error: "no_email_queue" };
  }
  // Re-validated at send, not only at write: a stored address may predate a
  // rule change or have been written by something other than the route.
  if (channel.kind !== "telegram") {
    const rejection = validateOutboundUrl(address, {
      allowPrivate: deps.allowPrivateTargets === true,
    });
    if (rejection) return { ok: false, error: `address_${rejection}` };
  }
  const signingSecret = await resolveChannelSigningSecret(secrets, channel);
  return await send(
    { kind: channel.kind, address, signingSecret },
    delivery.payload,
    deps.fetchImpl ?? fetch,
  );
}

async function attemptDeliveries(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  items: ReadonlyArray<
    {
      delivery: NotificationDeliveryRecord;
      channel: NotificationChannelRecord | null;
    }
  >,
  deps: EmitDeps,
  budgetMs: number,
): Promise<{ sent: number; failed: number }> {
  const deadline = (deps.now?.() ?? Date.now()) + budgetMs;
  let sent = 0;
  let failed = 0;
  for (const { delivery, channel } of items) {
    if (!deliverableHere(channel, deps)) continue;
    if ((deps.now?.() ?? Date.now()) >= deadline) {
      deps.trace?.("notification-delivery-deferred", {
        remaining: items.length - sent - failed,
      });
      break;
    }
    const outcome = await attemptOne(secrets, channel, delivery, deps);
    if (outcome.ok) sent += 1;
    else failed += 1;
    try {
      await runWithDbTimeout(
        db,
        (tx) => recordDeliveryAttempt(tx, delivery.id, outcome),
      );
    } catch (error) {
      compatLogWarn(
        "notifications",
        `could not record delivery ${delivery.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { sent, failed };
}

/**
 * The maintenance tick's phase: retry failed deliveries whose time has come,
 * a bounded batch per tick. Same never-throws contract.
 */
export async function retryDueDeliveries(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  deps: EmitDeps = {},
  limit = 50,
): Promise<{ attempted: number; sent: number; failed: number }> {
  try {
    const due = await runWithDbTimeout(
      db,
      (tx) => listDueDeliveries(tx, limit),
    );
    const items: Array<
      {
        delivery: NotificationDeliveryRecord;
        channel: NotificationChannelRecord | null;
      }
    > = [];
    for (const delivery of due) {
      const channel = await runWithDbTimeout(
        db,
        (tx) => getChannel(tx, delivery.channelId),
      );
      items.push({ delivery, channel });
    }
    const outcome = await attemptDeliveries(
      db,
      secrets,
      items,
      deps,
      EMIT_DELIVERY_BUDGET_MS * 4,
    );
    return { attempted: items.length, ...outcome };
  } catch (error) {
    compatLogWarn(
      "notifications",
      `retry sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { attempted: 0, sent: 0, failed: 0 };
  }
}
