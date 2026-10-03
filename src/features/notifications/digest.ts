/**
 * The digest sweep: send each channel the events it held, as one summary.
 *
 * `emitNotification` writes a `held` ledger row instead of sending when a
 * verified email, chat or webhook channel has a digest cadence, or is inside its quiet hours,
 * and the event is not urgent. This sweep, run on both maintenance ticks, is
 * the other half: per channel it asks `releaseCutoff` whether a window has
 * closed, claims the rows atomically (`claimHeldDeliveries`), and enqueues ONE
 * summary — an email, a compact chat text, or a structured webhook body
 * (`senders.ts`), grouped by event, capped in length, linked back to the app. A failed enqueue puts the rows back to `held` for the next tick.
 *
 * Never throws, like every notification phase. A paused channel is skipped and
 * its rows wait untouched until it resumes.
 */
import { type Db, runWithDbTimeout } from "../../db/connection.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import { validateOutboundUrl } from "../../lib/http/outbound-url.ts";
import { compatLogWarn } from "../../lib/log-compat.ts";
import { mapSequential } from "../../lib/sequential.ts";
import type {
  EmailJob,
  NotificationDigestGroup,
  NotificationDigestItem,
} from "../email/types.ts";
import { consoleUrlFor, type EmitEmail } from "./emit.ts";
import {
  NOTIFICATION_SEVERITIES,
  type NotificationSeverity,
} from "./events.ts";
import {
  channelTimeZones,
  claimHeldDeliveries,
  finishDigestDeliveries,
  listChannelsWithHeldDeliveries,
  type NotificationChannelRecord,
  type NotificationDeliveryRecord,
  resolveChannelAddress,
  resolveChannelSigningSecret,
} from "./records.ts";
import { type DigestMessage, sendDigest } from "./senders.ts";
import { DEFAULT_TIME_ZONE, releaseCutoff } from "./windows.ts";

/** Rows one digest may carry; a bigger backlog goes out in the next tick's digest. */
export const DIGEST_CLAIM_LIMIT = 1000;
/** Event kinds listed in one digest; the rest are counted ("and N more kinds"). */
export const DIGEST_MAX_GROUPS = 8;
/** Events listed under one kind; the rest are counted ("and N more"). */
export const DIGEST_MAX_ITEMS = 5;

export type DigestDeps = {
  /** Without a mail queue, email channels' held rows wait; chat and webhook channels do not need one. */
  email?: EmitEmail;
  /** Unseals a chat or webhook channel's address; without it those channels' rows wait, held and uncounted, until a tick that has it. */
  secrets?: DerivedSecretsConfig;
  fetchImpl?: typeof fetch;
  allowPrivateTargets?: boolean;
  now?: () => number;
};

export type DigestResult = {
  channels: number;
  digests: number;
  events: number;
};

const NONE: DigestResult = { channels: 0, digests: 0, events: 0 };

type DigestJob = Extract<EmailJob, { type: "notification-digest" }>;

function severityRank(severity: NotificationSeverity): number {
  return NOTIFICATION_SEVERITIES.indexOf(severity);
}

function toItem(
  delivery: NotificationDeliveryRecord,
  base: string | null | undefined,
): NotificationDigestItem {
  const payload = delivery.payload;
  return {
    title: payload.title,
    at: payload.at,
    url: consoleUrlFor(base, payload),
  };
}

function compareGroups(
  a: NotificationDigestGroup,
  b: NotificationDigestGroup,
): number {
  return severityRank(b.severity) - severityRank(a.severity) ||
    b.count - a.count;
}

/** Group by event, most severe and most frequent first, capped; pure, so the shape is tested directly. */
export function buildDigestGroups(
  deliveries: readonly NotificationDeliveryRecord[],
  base: string | null | undefined,
): { groups: NotificationDigestGroup[]; moreGroups: number } {
  const byEvent = new Map<string, NotificationDeliveryRecord[]>();
  for (const delivery of deliveries) {
    const list = byEvent.get(delivery.event) ?? [];
    list.push(delivery);
    byEvent.set(delivery.event, list);
  }
  const all = [...byEvent.entries()].map(([event, rows]) => {
    const ordered = rows.toSorted((a, b) =>
      a.payload.at.localeCompare(b.payload.at)
    );
    return {
      event,
      severity: ordered[0]!.severity,
      count: ordered.length,
      items: ordered.slice(0, DIGEST_MAX_ITEMS).map((row) => toItem(row, base)),
    };
  });
  const sorted = all.toSorted(compareGroups);
  return {
    groups: sorted.slice(0, DIGEST_MAX_GROUPS),
    moreGroups: Math.max(0, sorted.length - DIGEST_MAX_GROUPS),
  };
}

/** The transport-neutral digest: grouped, capped, linked; each transport renders it. */
export function buildDigestMessage(input: {
  summary: DigestMessage["summary"];
  deliveries: readonly NotificationDeliveryRecord[];
  consoleBaseUrl: string | null | undefined;
  nowMs: number;
}): DigestMessage {
  const { groups, moreGroups } = buildDigestGroups(
    input.deliveries,
    input.consoleBaseUrl,
  );
  return {
    summary: input.summary,
    total: input.deliveries.length,
    groups,
    moreGroups,
    consoleUrl: input.consoleBaseUrl ?? null,
    at: new Date(input.nowMs).toISOString(),
  };
}

export function buildDigestJob(input: {
  to: string;
  email: EmitEmail;
  summary: DigestJob["summary"];
  deliveries: readonly NotificationDeliveryRecord[];
  nowMs: number;
}): DigestJob {
  const message = buildDigestMessage({
    summary: input.summary,
    deliveries: input.deliveries,
    consoleBaseUrl: input.email.consoleBaseUrl,
    nowMs: input.nowMs,
  });
  return {
    type: "notification-digest",
    to: input.to,
    from: input.email.from,
    ...message,
  };
}

async function enqueueDigest(
  email: EmitEmail,
  job: DigestJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
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

type SendOutcome = { ok: true } | { ok: false; error: string };

/** Hand one digest to the channel's transport: the mail queue, or a POST to the chat or webhook URL. */
async function sendDigestTo(
  channel: NotificationChannelRecord,
  deps: DigestDeps,
  claimed: readonly NotificationDeliveryRecord[],
  nowMs: number,
): Promise<SendOutcome> {
  const summary = channel.digestCadence ?? "quiet";
  const address = await resolveChannelAddress(deps.secrets, channel);
  if (address === null) return { ok: false, error: "address_unreadable" };
  if (channel.kind === "email") {
    if (!deps.email) return { ok: false, error: "no_email_queue" };
    const job = buildDigestJob({
      to: address,
      email: deps.email,
      summary,
      deliveries: claimed,
      nowMs,
    });
    return await enqueueDigest(deps.email, job);
  }
  // Re-validated at send, like every notification: the stored address may
  // predate a rule change.
  if (channel.kind !== "telegram") {
    const rejection = validateOutboundUrl(address, {
      allowPrivate: deps.allowPrivateTargets !== false,
    });
    if (rejection) return { ok: false, error: `address_${rejection}` };
  }
  const message = buildDigestMessage({
    summary,
    deliveries: claimed,
    consoleBaseUrl: deps.email?.consoleBaseUrl ?? null,
    nowMs,
  });
  const signingSecret = await resolveChannelSigningSecret(
    deps.secrets,
    channel,
  );
  return await sendDigest(
    { kind: channel.kind, address, signingSecret },
    message,
    deps.fetchImpl ?? fetch,
  );
}

async function digestOne(
  db: Db,
  deps: DigestDeps,
  channel: NotificationChannelRecord,
  timeZone: string,
  nowMs: number,
): Promise<{ digests: number; events: number }> {
  const cutoff = releaseCutoff(nowMs, timeZone, {
    digestCadence: channel.digestCadence,
    quiet: channel.quiet,
  });
  if (cutoff === null) return { digests: 0, events: 0 };
  const claimed = await runWithDbTimeout(
    db,
    (tx) =>
      claimHeldDeliveries(
        tx,
        channel.id,
        new Date(cutoff).toISOString(),
        DIGEST_CLAIM_LIMIT,
      ),
  );
  if (claimed.length === 0) return { digests: 0, events: 0 };
  const outcome = await sendDigestTo(channel, deps, claimed, nowMs);
  await runWithDbTimeout(db, (tx) =>
    finishDigestDeliveries(
      tx,
      claimed.map((d) => d.id),
      outcome,
    ));
  return outcome.ok
    ? { digests: 1, events: claimed.length }
    : { digests: 0, events: 0 };
}

/** One channel's failure (a slow query, a bad row) must not starve the channels after it. */
async function digestOneSafely(
  db: Db,
  deps: DigestDeps,
  channel: NotificationChannelRecord,
  timeZone: string,
  nowMs: number,
): Promise<{ digests: number; events: number }> {
  try {
    return await digestOne(db, deps, channel, timeZone, nowMs);
  } catch (error) {
    compatLogWarn(
      "notifications",
      `digest for channel ${channel.id} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { digests: 0, events: 0 };
  }
}

/** The maintenance tick's phase: send every channel's closed window as one summary. */
export async function sendDueDigests(
  db: Db,
  deps: DigestDeps = {},
): Promise<DigestResult> {
  try {
    const nowMs = deps.now?.() ?? Date.now();
    const channels = await runWithDbTimeout(
      db,
      (tx) =>
        listChannelsWithHeldDeliveries(tx, 50, {
          includeEmail: deps.email !== undefined,
          includeChat: deps.secrets !== undefined,
        }),
    );
    if (channels.length === 0) return NONE;
    const zones = await runWithDbTimeout(
      db,
      (tx) => channelTimeZones(tx, channels),
    );
    const results = await mapSequential(
      channels,
      (channel) =>
        digestOneSafely(
          db,
          deps,
          channel,
          zones.get(channel.id) ?? DEFAULT_TIME_ZONE,
          nowMs,
        ),
    );
    return {
      channels: channels.length,
      digests: results.reduce((sum, r) => sum + r.digests, 0),
      events: results.reduce((sum, r) => sum + r.events, 0),
    };
  } catch (error) {
    compatLogWarn(
      "notifications",
      `digest sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return NONE;
  }
}
