/**
 * Reads and writes for the four notification tables — the only module that
 * touches them, so the sealing rule and the vocabularies live in one place.
 *
 * Sealing: a channel's `address` is a `tpsecret` envelope for every kind but
 * `email`. A webhook URL is a credential (the path is the secret), and so is a
 * push token; an email address is what it looks like. `signing_secret` is
 * always sealed. The re-encrypt sweep (`src/admin/reencrypt-secrets.ts`)
 * re-seals both columns under the current key version.
 */
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from "../../lib/secrets/data-encryption.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import {
  grant,
  notification,
  notificationChannel,
  notificationDelivery,
  notificationRule,
  organization,
  team,
  teammate,
  user,
} from "../../db/schema.ts";
import {
  NOTIFICATION_RULE_ANY_EVENT,
  type NotificationContext,
  type NotificationEvent,
  type NotificationSeverity,
  severityAtLeast,
} from "./events.ts";

function channelOwnerFilter(
  organizationId: string | null,
  memberIds: readonly string[],
) {
  if (!organizationId) return eq(notificationChannel.scope, "instance");
  const memberClause = memberIds.length > 0
    ? inArray(notificationChannel.userId, memberIds)
    : sql`false`;
  return or(
    eq(notificationChannel.scope, "instance"),
    eq(notificationChannel.organizationId, organizationId),
    memberClause,
  );
}

export const NOTIFICATION_CHANNEL_SCOPES = [
  "instance",
  "organization",
  "user",
] as const;
export type NotificationChannelScope =
  (typeof NOTIFICATION_CHANNEL_SCOPES)[number];

export const NOTIFICATION_CHANNEL_KINDS = [
  "email",
  "webhook",
  "slack",
  "discord",
  "telegram",
  "push",
] as const;
export type NotificationChannelKind =
  (typeof NOTIFICATION_CHANNEL_KINDS)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "failed",
  "abandoned",
] as const;
export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** Kinds whose address is a credential and is therefore stored sealed. */
export function channelAddressIsSecret(kind: NotificationChannelKind): boolean {
  return kind !== "email";
}

/** After this many failed attempts a delivery is abandoned, not retried. */
export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;

/** Backoff between attempts: 1, 5, 25, 125 minutes — bounded by the cap above. */
export function nextAttemptDelayMs(attempts: number): number {
  return 60_000 * 5 ** Math.max(0, Math.min(attempts - 1, 3));
}

export type NotificationChannelRecord = {
  id: string;
  scope: NotificationChannelScope;
  organizationId: string | null;
  userId: string | null;
  kind: NotificationChannelKind;
  label: string;
  /** Stored form: sealed for secret kinds. Use {@link resolveChannelAddress} to read it. */
  address: string;
  signingSecret: string | null;
  verifiedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

export type NotificationRuleRecord = {
  id: string;
  channelId: string;
  event: string;
  minSeverity: NotificationSeverity;
};

function asChannel(
  row: typeof notificationChannel.$inferSelect,
): NotificationChannelRecord {
  return {
    id: row.id,
    scope: row.scope as NotificationChannelScope,
    organizationId: row.organizationId,
    userId: row.userId,
    kind: row.kind as NotificationChannelKind,
    label: row.label,
    address: row.address,
    signingSecret: row.signingSecret,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
  };
}

export type CreateChannelInput = {
  scope: NotificationChannelScope;
  organizationId?: string | null;
  userId?: string | null;
  kind: NotificationChannelKind;
  label: string;
  /** Plain; sealed here when the kind calls for it. */
  address: string;
  /** Plain; always sealed. */
  signingSecret?: string | null;
  createdByUserId?: string | null;
  verifiedAt?: string | null;
};

export async function createNotificationChannel(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: CreateChannelInput,
): Promise<NotificationChannelRecord> {
  const sealed = channelAddressIsSecret(input.kind) || input.signingSecret;
  if (sealed && !secrets) {
    throw new Error(
      "data encryption secrets are required to store a notification channel address",
    );
  }
  const address = channelAddressIsSecret(input.kind)
    ? await encryptSecret(secrets!, input.address)
    : input.address;
  const signingSecret = input.signingSecret
    ? await encryptSecret(secrets!, input.signingSecret)
    : null;
  const [row] = await db
    .insert(notificationChannel)
    .values({
      scope: input.scope,
      organizationId: input.organizationId ?? null,
      userId: input.userId ?? null,
      kind: input.kind,
      label: input.label,
      address,
      signingSecret,
      createdByUserId: input.createdByUserId ?? null,
      verifiedAt: input.verifiedAt ?? null,
    })
    .returning();
  if (!row) throw new Error("notification channel insert returned no row");
  return asChannel(row);
}

/** The plain address, whatever form it is stored in; null when it cannot be unsealed. */
export async function resolveChannelAddress(
  secrets: DerivedSecretsConfig | undefined,
  channel: Pick<NotificationChannelRecord, "kind" | "address">,
): Promise<string | null> {
  if (
    !channelAddressIsSecret(channel.kind) || !isSealedEnvelope(channel.address)
  ) {
    return channel.address;
  }
  if (!secrets) return null;
  try {
    return await decryptSecret(secrets, channel.address);
  } catch {
    return null;
  }
}

export async function resolveChannelSigningSecret(
  secrets: DerivedSecretsConfig | undefined,
  channel: Pick<NotificationChannelRecord, "signingSecret">,
): Promise<string | null> {
  if (!channel.signingSecret) return null;
  if (!isSealedEnvelope(channel.signingSecret)) return channel.signingSecret;
  if (!secrets) return null;
  try {
    return await decryptSecret(secrets, channel.signingSecret);
  } catch {
    return null;
  }
}

/** What a settings screen renders: never the address of a secret kind, only its origin or a mask. */
export function describeChannelAddress(
  kind: NotificationChannelKind,
  plainAddress: string | null,
): string {
  if (plainAddress === null) return "(unreadable)";
  if (!channelAddressIsSecret(kind)) return plainAddress;
  if (kind === "webhook" || kind === "slack" || kind === "discord") {
    try {
      return new URL(plainAddress).origin;
    } catch {
      return "(invalid URL)";
    }
  }
  // Telegram chat ids and push tokens: show the tail so two can be told apart.
  return plainAddress.length > 6 ? `…${plainAddress.slice(-4)}` : "…";
}

export async function listChannelsForUser(
  db: Db,
  userId: string,
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.userId, userId))
    .orderBy(desc(notificationChannel.createdAt));
  return rows.map(asChannel);
}

export async function listChannelsForOrganization(
  db: Db,
  organizationId: string,
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.organizationId, organizationId))
    .orderBy(desc(notificationChannel.createdAt));
  return rows.map(asChannel);
}

export async function listInstanceChannels(
  db: Db,
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.scope, "instance"))
    .orderBy(desc(notificationChannel.createdAt));
  return rows.map(asChannel);
}

export async function getChannel(
  db: Db,
  id: string,
): Promise<NotificationChannelRecord | null> {
  const [row] = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.id, id))
    .limit(1);
  return row ? asChannel(row) : null;
}

export async function deleteChannel(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(notificationChannel)
    .where(eq(notificationChannel.id, id))
    .returning({ id: notificationChannel.id });
  return rows.length > 0;
}

export async function updateChannelLabel(
  db: Db,
  id: string,
  label: string,
): Promise<void> {
  await db
    .update(notificationChannel)
    .set({ label })
    .where(eq(notificationChannel.id, id));
}

export async function setChannelDisabled(
  db: Db,
  id: string,
  disabled: boolean,
): Promise<void> {
  await db
    .update(notificationChannel)
    .set({ disabledAt: disabled ? sql`now()` : null })
    .where(eq(notificationChannel.id, id));
}

export async function listRulesForChannel(
  db: Db,
  channelId: string,
): Promise<NotificationRuleRecord[]> {
  const rows = await db
    .select()
    .from(notificationRule)
    .where(eq(notificationRule.channelId, channelId));
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    event: r.event,
    minSeverity: r.minSeverity as NotificationSeverity,
  }));
}

/** Replace a channel's rules wholesale — the preferences screen saves the matrix, not a diff. */
export async function replaceRulesForChannel(
  db: Db,
  channelId: string,
  rules: ReadonlyArray<{ event: string; minSeverity: NotificationSeverity }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(notificationRule).where(
      eq(notificationRule.channelId, channelId),
    );
    if (rules.length > 0) {
      await tx.insert(notificationRule).values(
        rules.map((r) => ({
          channelId,
          event: r.event,
          minSeverity: r.minSeverity,
        })),
      );
    }
  });
}

/**
 * Every enabled channel a rule routes this event to, within the scope the
 * event belongs to: the organization's own channels and the user channels of
 * the people the event is for, plus instance channels for everything.
 *
 * `recipientIds` is the event's audience — the same people who get the inbox
 * row. A personal channel is a person's own copy of their inbox, so it may
 * only carry what that person may see: a managers-only event never reaches a
 * plain member's user channel.
 */
export async function channelsForEvent(
  db: Db,
  event: NotificationEvent,
  severity: NotificationSeverity,
  organizationId: string | null,
  recipientIds: readonly string[],
): Promise<NotificationChannelRecord[]> {
  const ownerFilter = channelOwnerFilter(organizationId, recipientIds);
  const rows = await db
    .select({ channel: notificationChannel, rule: notificationRule })
    .from(notificationRule)
    .innerJoin(
      notificationChannel,
      eq(notificationRule.channelId, notificationChannel.id),
    )
    .where(
      and(
        isNull(notificationChannel.disabledAt),
        ownerFilter,
        or(
          eq(notificationRule.event, NOTIFICATION_RULE_ANY_EVENT),
          eq(notificationRule.event, event),
        ),
      ),
    );
  const seen = new Set<string>();
  const out: NotificationChannelRecord[] = [];
  for (const { channel, rule } of rows) {
    if (seen.has(channel.id)) continue;
    if (!severityAtLeast(severity, rule.minSeverity as NotificationSeverity)) {
      continue;
    }
    seen.add(channel.id);
    out.push(asChannel(channel));
  }
  return out;
}

export async function organizationName(
  db: Db,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Everyone holding `organization:own` or `organization:manage` on the
 * organization — directly, through a team they belong to, or through the
 * organization itself as the subject. The inbox audience for events that
 * mirror the owner-only audit trail (decided 2026-09-18): a plain teammate
 * does not learn every grant change from the bell.
 */
export async function organizationManagerIds(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ actorType: grant.actorType, actorId: grant.actorId })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, "organization"),
        eq(grant.entityId, organizationId),
        inArray(grant.permission, ["organization:own", "organization:manage"]),
      ),
    );
  const ids = new Set<string>();
  const teamIds: string[] = [];
  let everyone = false;
  for (const row of rows) {
    if (row.actorType === "user") ids.add(row.actorId);
    else if (row.actorType === "team") teamIds.push(row.actorId);
    else if (row.actorType === "organization") everyone = true;
  }
  if (everyone) return await organizationMemberIds(db, organizationId);
  if (teamIds.length > 0) {
    const members = await db
      .selectDistinct({ userId: teammate.userId })
      .from(teammate)
      .where(inArray(teammate.teamId, teamIds));
    for (const m of members) ids.add(m.userId);
  }
  // Instance administrators see every organization; they hear about it too.
  for (const admin of await instanceAdminIds(db)) ids.add(admin);
  return [...ids];
}

/** The account emails of everyone in the organization — what an organization email channel may name. */
export async function organizationMemberEmails(
  db: Db,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ email: user.email })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .innerJoin(user, eq(teammate.userId, user.id))
    .where(eq(team.organizationId, organizationId));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/** Everyone who belongs to the organization through a team — the inbox fan-out. */
export async function organizationMemberIds(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: teammate.userId })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .where(eq(team.organizationId, organizationId));
  return rows.map((r) => r.userId);
}

/** Instance administrators — the inbox fan-out for an instance-scoped event. */
export async function instanceAdminIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.role, ["admin", "superadmin"]));
  return rows.map((r) => r.id);
}

export type NotificationInsert = {
  userId: string;
  organizationId: string | null;
  event: NotificationEvent;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  targetType?: string | null;
  targetId?: string | null;
  context?: NotificationContext | null;
};

export async function insertNotifications(
  db: Db,
  rows: NotificationInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(notification)
    .values(
      rows.map((r) => ({
        userId: r.userId,
        organizationId: r.organizationId,
        event: r.event,
        severity: r.severity,
        title: r.title,
        body: r.body,
        targetType: r.targetType ?? null,
        targetId: r.targetId ?? null,
        context: r.context ?? null,
      })),
    )
    .returning({ id: notification.id });
  return inserted.length;
}

export type NotificationRecord = {
  id: string;
  createdAt: string;
  organizationId: string | null;
  event: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  readAt: string | null;
};

export async function listNotificationsForUser(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<NotificationRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = await db
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.dismissedAt),
        opts.before ? lt(notification.createdAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(notification.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    organizationId: r.organizationId,
    event: r.event,
    severity: r.severity as NotificationSeverity,
    title: r.title,
    body: r.body,
    targetType: r.targetType,
    targetId: r.targetId,
    readAt: r.readAt,
  }));
}

export async function countUnreadForUser(
  db: Db,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notification)
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.readAt),
        isNull(notification.dismissedAt),
      ),
    );
  return row?.count ?? 0;
}

/** Mark the given rows (or every unread row when `ids` is empty) read for this user. */
export async function markNotificationsRead(
  db: Db,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  const rows = await db
    .update(notification)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.readAt),
        ids.length > 0 ? inArray(notification.id, [...ids]) : undefined,
      ),
    )
    .returning({ id: notification.id });
  return rows.length;
}

export async function dismissNotification(
  db: Db,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(notification)
    .set({ dismissedAt: sql`now()`, readAt: sql`coalesce(read_at, now())` })
    .where(and(eq(notification.userId, userId), eq(notification.id, id)))
    .returning({ id: notification.id });
  return rows.length > 0;
}

export type DeliveryPayload = {
  event: NotificationEvent;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  organizationId: string | null;
  /** Denormalized for the message; null for an instance-scoped event. */
  organizationName: string | null;
  targetType: string | null;
  targetId: string | null;
  context: NotificationContext;
  /** ISO time the event happened. */
  at: string;
};

export type NotificationDeliveryRecord = {
  id: string;
  channelId: string;
  organizationId: string | null;
  event: NotificationEvent;
  severity: NotificationSeverity;
  payload: DeliveryPayload;
  status: NotificationDeliveryStatus;
  attempts: number;
};

/**
 * How long the retry sweep leaves a fresh row to the inline attempt. The
 * inline send is bounded at 5 s per channel; a sweep tick fires every 60 s on
 * both runtimes. Two minutes means the sweep only ever reaches a row whose
 * inline attempt never came back to record itself — a Worker killed
 * mid-send, the case the ledger-first design exists for — and never races a
 * slow one into a double send.
 */
export const INLINE_ATTEMPT_GRACE_MS = 2 * 60_000;

/** Write the ledger row first — a crash between here and the send leaves a pending row, not silence. */
export async function insertPendingDeliveries(
  db: Db,
  channelIds: readonly string[],
  payload: DeliveryPayload,
): Promise<NotificationDeliveryRecord[]> {
  if (channelIds.length === 0) return [];
  const rows = await db
    .insert(notificationDelivery)
    .values(
      channelIds.map((channelId) => ({
        channelId,
        organizationId: payload.organizationId,
        event: payload.event,
        severity: payload.severity,
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + INLINE_ATTEMPT_GRACE_MS)
          .toISOString(),
      })),
    )
    .returning();
  return rows.map(asDelivery);
}

function asDelivery(
  row: typeof notificationDelivery.$inferSelect,
): NotificationDeliveryRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    organizationId: row.organizationId,
    event: row.event as NotificationEvent,
    severity: row.severity as NotificationSeverity,
    payload: row.payload as DeliveryPayload,
    status: row.status as NotificationDeliveryStatus,
    attempts: row.attempts,
  };
}

/**
 * Record one attempt's outcome. The counter is bumped in SQL, not read then
 * written, so two recorders for one row can never both count as attempt 1;
 * the backoff and the abandon decision come from the value the update returns.
 */
export async function recordDeliveryAttempt(
  db: Db,
  id: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await db
      .update(notificationDelivery)
      .set({
        status: "sent",
        attempts: sql`${notificationDelivery.attempts} + 1`,
        sentAt: sql`now()`,
        nextAttemptAt: null,
        lastError: null,
      })
      .where(eq(notificationDelivery.id, id));
    return;
  }
  const [row] = await db
    .update(notificationDelivery)
    .set({
      status: "failed",
      attempts: sql`${notificationDelivery.attempts} + 1`,
      lastError: outcome.error.slice(0, 200),
    })
    .where(eq(notificationDelivery.id, id))
    .returning({ attempts: notificationDelivery.attempts });
  const attempts = row?.attempts ?? NOTIFICATION_DELIVERY_MAX_ATTEMPTS;
  const abandoned = attempts >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS;
  await db
    .update(notificationDelivery)
    .set({
      status: abandoned ? "abandoned" : "failed",
      nextAttemptAt: abandoned
        ? null
        : new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
    })
    .where(eq(notificationDelivery.id, id));
}

/**
 * Failed deliveries whose retry time has come — the maintenance tick's batch.
 *
 * Only rows this sweep can actually send are selected: the channel is not
 * paused, is not push (the Expo transport owns those rows), and is email only
 * when the tick has an email queue and the address is verified. A row the
 * sweep would skip is never picked, so rows for a paused channel (which wait
 * for it to resume) cannot fill the batch and starve every other channel.
 */
export async function listDueDeliveries(
  db: Db,
  limit = 50,
  opts: { includeEmail?: boolean } = {},
): Promise<NotificationDeliveryRecord[]> {
  const now = new Date().toISOString();
  const kindFilter = opts.includeEmail
    ? or(
      and(
        eq(notificationChannel.kind, "email"),
        isNotNull(notificationChannel.verifiedAt),
      ),
      notInArray(notificationChannel.kind, ["email", "push"]),
    )
    : notInArray(notificationChannel.kind, ["email", "push"]);
  const rows = await db
    .select({ delivery: notificationDelivery })
    .from(notificationDelivery)
    .innerJoin(
      notificationChannel,
      eq(notificationDelivery.channelId, notificationChannel.id),
    )
    .where(
      and(
        inArray(notificationDelivery.status, ["pending", "failed"]),
        lt(notificationDelivery.nextAttemptAt, now),
        isNull(notificationChannel.disabledAt),
        kindFilter,
      ),
    )
    .orderBy(notificationDelivery.nextAttemptAt)
    .limit(limit);
  return rows.map((r) => asDelivery(r.delivery));
}

/** Deliveries newer than `since` for one channel — what a channel's detail row shows. */
export async function listRecentDeliveriesForChannel(
  db: Db,
  channelId: string,
  since: string,
): Promise<NotificationDeliveryRecord[]> {
  const rows = await db
    .select()
    .from(notificationDelivery)
    .where(
      and(
        eq(notificationDelivery.channelId, channelId),
        gt(notificationDelivery.createdAt, since),
      ),
    )
    .orderBy(desc(notificationDelivery.createdAt))
    .limit(20);
  return rows.map(asDelivery);
}

/** The label the operator's instance-wide alert webhook carries once folded into a channel. */
export const OPERATOR_WEBHOOK_LABEL = "Operator alert webhook";

/** The instance webhook channel the legacy `ALERT_WEBHOOK_URL` setting became, if any. */
export async function getOperatorWebhookChannel(
  db: Db,
): Promise<NotificationChannelRecord | null> {
  const [row] = await db
    .select()
    .from(notificationChannel)
    .where(
      and(
        eq(notificationChannel.scope, "instance"),
        eq(notificationChannel.kind, "webhook"),
        eq(notificationChannel.label, OPERATOR_WEBHOOK_LABEL),
      ),
    )
    .orderBy(notificationChannel.createdAt)
    .limit(1);
  return row ? asChannel(row) : null;
}

/** Replace a channel's sealed address (already-validated plain input). */
export async function updateChannelAddress(
  db: Db,
  secrets: DerivedSecretsConfig,
  id: string,
  kind: NotificationChannelKind,
  plainAddress: string,
): Promise<void> {
  const address = channelAddressIsSecret(kind)
    ? await encryptSecret(secrets, plainAddress)
    : plainAddress;
  await db
    .update(notificationChannel)
    .set({ address })
    .where(eq(notificationChannel.id, id));
}

/** The account emails of every instance administrator — what an instance email channel may name. */
export async function instanceAdminEmails(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(inArray(user.role, ["admin", "superadmin"]));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}
