/**
 * The notifications surface a signed-in person uses: their inbox, and the
 * channels and rules that decide what leaves the console.
 *
 * Inbox rows are the user's own — no organization header, no grant: they were
 * fanned out to this user at emit time. Channels are owned by the user
 * (`scope: user`, theirs alone) or by the organization in the session's
 * context (`scope: organization`, `organization:manage`). Instance channels
 * are the admin surface (`/api/admin/v1/notification-channels`), not this one.
 *
 * Every response that mentions a channel address goes through
 * `describeChannelAddress`: a webhook URL is a credential and is never handed
 * back whole.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { getDb } from "../../db.ts";
import { getOrgId } from "../shared.ts";
import { assertCanOr403 } from "../authz/http.ts";
import {
  countUnreadForUser,
  createNotificationChannel,
  deleteChannel,
  describeChannelAddress,
  dismissNotification,
  getChannel,
  listChannelsForOrganization,
  listChannelsForUser,
  listNotificationsForUser,
  listRecentDeliveriesForChannel,
  listRulesForChannel,
  markNotificationsRead,
  type NotificationChannelRecord,
  organizationMemberEmails,
  replaceRulesForChannel,
  resolveChannelAddress,
  setChannelDisabled,
  updateChannelLabel,
} from "../../lib/notifications/records.ts";
import {
  describeEvent,
  eventScope,
  eventSeverity,
  NOTIFICATION_EVENTS,
} from "../../lib/notifications/events.ts";
import {
  type ChannelWriteRefusal,
  parseChannelCreateBody,
  parseChannelPatchBody,
  parseRulesBody,
} from "./routes-helpers.ts";

export function registerNotificationRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError("session secrets are required for notification routes");
  }
  const session = createSessionMiddleware(opts.secrets);
  router.use("/notifications", session);
  router.use("/notifications/*", session);
  router.use("/notification-channels", session);
  router.use("/notification-channels/*", session);
  router.use("/notification-events", session);

  /** The catalogue, for the preferences matrix. */
  router.get("/notification-events", (c) => {
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      events: NOTIFICATION_EVENTS.map((event) => ({
        event,
        severity: eventSeverity(event),
        scope: eventScope(event),
        example: describeEvent(event).title,
      })),
    });
  });

  // ---- inbox ---------------------------------------------------------------

  router.get("/notifications", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      return c.json({ error: "Invalid limit" }, 400);
    }
    const before = c.req.query("before") ?? undefined;
    const [notifications, unread] = await Promise.all([
      listNotificationsForUser(db, sess.userId, { limit, before }),
      countUnreadForUser(db, sess.userId),
    ]);
    return c.json({ notifications, unread });
  });

  router.get("/notifications/unread-count", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ unread: await countUnreadForUser(db, sess.userId) });
  });

  /** Mark the given ids read, or every unread row when the body carries none. */
  router.post("/notifications/read", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray((body as { ids?: unknown }).ids)
      ? (body as { ids: unknown[] }).ids.filter((v): v is string =>
        typeof v === "string"
      )
      : [];
    const updated = await markNotificationsRead(db, sess.userId, ids);
    return c.json({
      ok: true,
      updated,
      unread: await countUnreadForUser(db, sess.userId),
    });
  });

  router.delete("/notifications/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const dismissed = await dismissNotification(
      db,
      sess.userId,
      c.req.param("id"),
    );
    if (!dismissed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // ---- channels ------------------------------------------------------------

  async function present(
    c: Parameters<typeof getDb>[0],
    channel: NotificationChannelRecord,
  ) {
    const db = getDb(c)!;
    const secrets = c.get("dataEncryptionSecrets");
    const [rules, deliveries] = await Promise.all([
      listRulesForChannel(db, channel.id),
      listRecentDeliveriesForChannel(
        db,
        channel.id,
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    ]);
    return {
      id: channel.id,
      scope: channel.scope,
      organizationId: channel.organizationId,
      kind: channel.kind,
      label: channel.label,
      address: describeChannelAddress(
        channel.kind,
        await resolveChannelAddress(secrets, channel),
      ),
      signed: channel.signingSecret !== null,
      verifiedAt: channel.verifiedAt,
      disabledAt: channel.disabledAt,
      createdAt: channel.createdAt,
      rules: rules.map((r) => ({ event: r.event, minSeverity: r.minSeverity })),
      recentDeliveries: deliveries.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        at: d.payload.at,
      })),
    };
  }

  /** The organization in context when the caller may manage its channels, else a refusal. */
  async function organizationForWrite(
    c: Parameters<typeof getDb>[0],
    userId: string,
  ): Promise<string | Response> {
    const orgResult = await getOrgId(c, userId);
    if (orgResult instanceof Response) return orgResult;
    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "organization",
      orgResult,
    );
    if (denied) return denied;
    return orgResult;
  }

  /** A channel the caller may act on: their own, or their organization's as a manager. */
  async function ownedChannel(
    c: Parameters<typeof getDb>[0],
    userId: string,
    id: string,
  ): Promise<NotificationChannelRecord | Response> {
    const db = getDb(c)!;
    const channel = await getChannel(db, id);
    if (!channel || channel.scope === "instance") {
      return c.json({ error: "Not found" }, 404);
    }
    if (channel.scope === "user") {
      return channel.userId === userId
        ? channel
        : c.json({ error: "Not found" }, 404);
    }
    const denied = await assertCanOr403(
      c,
      "organization:manage",
      "organization",
      channel.organizationId!,
    );
    return denied ?? channel;
  }

  function refuse(
    c: Parameters<typeof getDb>[0],
    refusal: ChannelWriteRefusal,
  ) {
    return c.json({
      error: refusal.error,
      ...(refusal.reason ? { reason: refusal.reason } : {}),
    }, refusal.status);
  }

  router.get("/notification-channels", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const scope = c.req.query("scope") ?? "user";
    if (scope !== "user" && scope !== "organization") {
      return c.json({ error: "scope must be user or organization" }, 400);
    }
    let channels: NotificationChannelRecord[];
    if (scope === "user") {
      channels = await listChannelsForUser(db, sess.userId);
    } else {
      const orgResult = await getOrgId(c, sess.userId);
      if (orgResult instanceof Response) return orgResult;
      const denied = await assertCanOr403(
        c,
        "organization:manage",
        "organization",
        orgResult,
      );
      if (denied) return denied;
      channels = await listChannelsForOrganization(db, orgResult);
    }
    return c.json({
      channels: await Promise.all(channels.map((ch) => present(c, ch))),
    });
  });

  router.post("/notification-channels", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = await parseChannelCreateBody(body, {
      allowPrivateTargets: true,
    });
    if (!parsed.ok) return refuse(c, parsed);
    let organizationId: string | null = null;
    if (parsed.value.scope === "organization") {
      const org = await organizationForWrite(c, sess.userId);
      if (org instanceof Response) return org;
      organizationId = org;
    }
    const secrets = c.get("dataEncryptionSecrets");
    if (parsed.value.kind !== "email" && !secrets) {
      return c.json({
        error: "Encryption unavailable — no encryption key configured",
      }, 503);
    }
    // An email channel may name only an address the platform already knows
    // belongs to someone here: the caller's own for a personal channel, any
    // member's account email for an organization channel. That is what
    // `verified_at` records; a stranger's address waits for a verification
    // flow that does not exist yet (decided 2026-09-18).
    let verifiedAt: string | null = null;
    if (parsed.value.kind === "email") {
      const address = parsed.value.address.toLowerCase();
      const known = organizationId
        ? await organizationMemberEmails(db, organizationId)
        : new Set([sess.email.toLowerCase()]);
      if (!known.has(address)) {
        return c.json(
          {
            error: "address_not_a_member",
            reason: organizationId
              ? "the address must be a member's account email"
              : "the address must be your own",
          },
          422,
        );
      }
      verifiedAt = new Date().toISOString();
    }
    const channel = await createNotificationChannel(db, secrets, {
      scope: parsed.value.scope,
      organizationId,
      userId: parsed.value.scope === "user" ? sess.userId : null,
      kind: parsed.value.kind,
      label: parsed.value.label,
      address: parsed.value.address,
      signingSecret: parsed.value.signingSecret,
      createdByUserId: sess.userId,
      verifiedAt,
    });
    await replaceRulesForChannel(db, channel.id, parsed.value.rules);
    return c.json({ ok: true, channel: await present(c, channel) }, 201);
  });

  router.patch("/notification-channels/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const owned = await ownedChannel(c, sess.userId, c.req.param("id"));
    if (owned instanceof Response) return owned;
    const body = await c.req.json().catch(() => null);
    const parsed = parseChannelPatchBody(body);
    if (!parsed.ok) return refuse(c, parsed);
    if (parsed.value.label !== undefined) {
      await updateChannelLabel(db, owned.id, parsed.value.label);
    }
    if (parsed.value.disabled !== undefined) {
      await setChannelDisabled(db, owned.id, parsed.value.disabled);
    }
    if (parsed.value.rules !== undefined) {
      await replaceRulesForChannel(db, owned.id, parsed.value.rules);
    }
    const fresh = await getChannel(db, owned.id);
    return c.json({
      ok: true,
      channel: fresh ? await present(c, fresh) : null,
    });
  });

  router.put("/notification-channels/:id/rules", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const owned = await ownedChannel(c, sess.userId, c.req.param("id"));
    if (owned instanceof Response) return owned;
    const body = await c.req.json().catch(() => null);
    const parsed = parseRulesBody((body as { rules?: unknown } | null)?.rules);
    if (!parsed.ok) return refuse(c, parsed);
    await replaceRulesForChannel(db, owned.id, parsed.value);
    return c.json({ ok: true, rules: parsed.value });
  });

  router.delete("/notification-channels/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const sess = c.get("session");
    if (!sess) return c.json({ error: "Unauthorized" }, 401);
    const owned = await ownedChannel(c, sess.userId, c.req.param("id"));
    if (owned instanceof Response) return owned;
    await deleteChannel(db, owned.id);
    return c.json({ ok: true });
  });
}
