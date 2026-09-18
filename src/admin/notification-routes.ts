/**
 * Instance-scoped notification channels — the operator's own receivers,
 * which hear every event on the instance (an organization event reaches
 * every instance channel a rule routes it to). Mounted under
 * `/api/admin/v1`, so the admin middleware has already required an
 * administrator; the same shapes as the client channel routes, with one
 * difference: an instance email channel may name any administrator's account
 * email.
 *
 * The operator's legacy `ALERT_WEBHOOK_URL` setting shows up here as the
 * channel it was folded into ("Operator alert webhook"); `PUT
 * /settings/alert-webhook` still edits that same channel.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getDb } from "../db.ts";
import { adoptLegacyAlertWebhook } from "../lib/alerts/alert-webhook-settings.ts";
import {
  createNotificationChannel,
  deleteChannel,
  describeChannelAddress,
  getChannel,
  instanceAdminEmails,
  listInstanceChannels,
  listRecentDeliveriesForChannel,
  listRulesForChannel,
  type NotificationChannelRecord,
  replaceRulesForChannel,
  resolveChannelAddress,
  setChannelDisabled,
  updateChannelLabel,
} from "../lib/notifications/records.ts";
import {
  parseChannelCreateBody,
  parseChannelPatchBody,
} from "../client/notifications/routes-helpers.ts";

export function registerNotificationAdminRoutes(
  admin: Hono<AppEnv>,
  opts: { runtime: "deno" | "workers" },
) {
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

  async function instanceChannel(
    c: Parameters<typeof getDb>[0],
    id: string,
  ): Promise<NotificationChannelRecord | Response> {
    const channel = await getChannel(getDb(c)!, id);
    if (!channel || channel.scope !== "instance") {
      return c.json({ error: "Not found" }, 404);
    }
    return channel;
  }

  admin.get("/notification-channels", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    // The legacy setting, if it still exists, becomes a channel here so the
    // operator sees one list.
    await adoptLegacyAlertWebhook(db, c.get("dataEncryptionSecrets"));
    const channels = await listInstanceChannels(db);
    return c.json({
      channels: await Promise.all(channels.map((ch) => present(c, ch))),
    });
  });

  admin.post("/notification-channels", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = await parseChannelCreateBody(
      { ...(body as Record<string, unknown> | null), scope: "user" },
      { allowPrivateTargets: opts.runtime === "deno" },
    );
    if (!parsed.ok) {
      return c.json(
        {
          error: parsed.error,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
        },
        parsed.status,
      );
    }
    const secrets = c.get("dataEncryptionSecrets");
    if (parsed.value.kind !== "email" && !secrets) {
      return c.json({
        error: "Encryption unavailable — no encryption key configured",
      }, 503);
    }
    let verifiedAt: string | null = null;
    if (parsed.value.kind === "email") {
      const known = await instanceAdminEmails(db);
      if (!known.has(parsed.value.address.toLowerCase())) {
        return c.json(
          {
            error: "address_not_a_member",
            reason: "the address must be an administrator's account email",
          },
          422,
        );
      }
      verifiedAt = new Date().toISOString();
    }
    const channel = await createNotificationChannel(db, secrets, {
      scope: "instance",
      kind: parsed.value.kind,
      label: parsed.value.label,
      address: parsed.value.address,
      signingSecret: parsed.value.signingSecret,
      createdByUserId: session.userId,
      verifiedAt,
    });
    await replaceRulesForChannel(db, channel.id, parsed.value.rules);
    return c.json({ ok: true, channel: await present(c, channel) }, 201);
  });

  admin.patch("/notification-channels/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const owned = await instanceChannel(c, c.req.param("id"));
    if (owned instanceof Response) return owned;
    const body = await c.req.json().catch(() => null);
    const parsed = parseChannelPatchBody(body);
    if (!parsed.ok) {
      return c.json(
        {
          error: parsed.error,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
        },
        parsed.status,
      );
    }
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

  admin.delete("/notification-channels/:id", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);
    const owned = await instanceChannel(c, c.req.param("id"));
    if (owned instanceof Response) return owned;
    await deleteChannel(db, owned.id);
    return c.json({ ok: true });
  });
}
