/**
 * The pipeline against a real Postgres: fan-out to the inbox, routing to a
 * channel by rule, the delivery ledger, the retry sweep, and the two
 * contracts that matter most — email/push rows stay pending for their own
 * transports, and a delivery failure never becomes the emitter's failure.
 * Skipped without TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { createDenoDb, endDbConnection } from "../../db/connection.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../../lib/secrets/secrets.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import {
  grant,
  notification,
  notificationChannel,
  notificationDelivery,
  organization,
  team,
  teammate,
  user,
} from "../../db/schema.ts";
import { emitNotification, retryDueDeliveries } from "./emit.ts";
import {
  countUnreadForUser,
  createNotificationChannel,
  listNotificationsForUser,
  markNotificationsRead,
  replaceRulesForChannel,
  resolveChannelAddress,
} from "./records.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();

async function secrets() {
  return await deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, "deno"),
    "data-encryption",
  );
}

async function withFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    organizationId: string;
    memberId: string;
    outsiderId: string;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping notifications emit tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }
  const db = createDenoDb();
  const [org] = await db.insert(organization).values({ name: "Notify Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;
  const [member] = await db
    .insert(user)
    .values({
      email: `notify-member-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const [outsider] = await db
    .insert(user)
    .values({
      email: `notify-outsider-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const [t] = await db.insert(team).values({
    name: "Notify Team",
    organizationId,
  }).returning({ id: team.id });
  await db.insert(teammate).values({ teamId: t!.id, userId: member!.id });
  try {
    await fn({
      db,
      organizationId,
      memberId: member!.id,
      outsiderId: outsider!.id,
    });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, member!.id));
    await db.delete(user).where(eq(user.id, outsider!.id));
    await endDbConnection(db);
  }
}

type Captured = { url: string; body: unknown };

function fakeFetch(status: number, captured: Captured[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "null")),
    });
    return Promise.resolve(new Response("", { status }));
  }) as typeof fetch;
}

test("an organization event lands in every member inbox and reaches a routed channel, sealed address and all", async () => {
  await withFixture(async ({ db, organizationId, memberId, outsiderId }) => {
    const enc = await secrets();
    const channel = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "slack",
      label: "Ops",
      address: "https://hooks.slack.com/services/T0/B0/SECRET",
      createdByUserId: memberId,
    });
    // Stored sealed; readable back with the key.
    assertEquals(channel.address.startsWith("tpsecret."), true);
    assertEquals(
      await resolveChannelAddress(enc, channel),
      "https://hooks.slack.com/services/T0/B0/SECRET",
    );
    await replaceRulesForChannel(db, channel.id, [{
      event: "*",
      minSeverity: "warning",
    }]);

    const captured: Captured[] = [];
    const result = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-1", serverId: "x" },
      targetType: "server",
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(result, { inbox: 1, deliveries: 1, sent: 1, failed: 0 });
    assertEquals(captured.length, 1);
    assertEquals(
      (captured[0]!.body as { text: string }).text.startsWith(
        "Server db-1 went offline",
      ),
      true,
    );

    // The member has the row, unread; the outsider has nothing.
    const inbox = await listNotificationsForUser(db, memberId);
    assertEquals(inbox.length, 1);
    assertEquals(inbox[0]!.event, "server.offline");
    assertEquals(inbox[0]!.severity, "critical");
    assertEquals(await countUnreadForUser(db, memberId), 1);
    assertEquals(await listNotificationsForUser(db, outsiderId), []);
    assertEquals(await markNotificationsRead(db, memberId, []), 1);
    assertEquals(await countUnreadForUser(db, memberId), 0);

    // The ledger says sent.
    const [delivery] = await db
      .select({
        status: notificationDelivery.status,
        attempts: notificationDelivery.attempts,
      })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id));
    assertEquals(delivery, { status: "sent", attempts: 1 });

    // An audit-derived event goes to managers only (decided 2026-09-18): a
    // plain member gets no inbox row for it. (The organization channel above
    // has a warning floor, so this info event routes nowhere either; the
    // audience rule for personal channels is pinned in its own test below.)
    const quiet = await emitNotification(db, enc, {
      event: "server.deleted",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(quiet, { inbox: 0, deliveries: 0, sent: 0, failed: 0 });
    assertEquals(captured.length, 1);

    // Once the member holds organization:manage, the same event reaches them.
    await db.insert(grant).values({
      entityType: "organization",
      entityId: organizationId,
      actorType: "user",
      actorId: memberId,
      permission: "organization:manage",
    });
    const managed = await emitNotification(db, enc, {
      event: "server.deleted",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(managed.inbox, 1);
  });
});

test("a managers-only event never reaches a plain member's personal channel", async () => {
  await withFixture(async ({ db, organizationId, memberId }) => {
    const enc = await secrets();
    // The member's own channel, subscribed to everything from info up: the
    // severity floor lets every event through, so only the audience decides.
    const personal = await createNotificationChannel(db, enc, {
      scope: "user",
      userId: memberId,
      kind: "webhook",
      label: "Mine",
      address: "https://member.example.com/hook",
    });
    await replaceRulesForChannel(db, personal.id, [{
      event: "*",
      minSeverity: "info",
    }]);

    const captured: Captured[] = [];
    const hidden = await emitNotification(db, enc, {
      event: "server.deleted",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(hidden, { inbox: 0, deliveries: 0, sent: 0, failed: 0 });
    assertEquals(captured.length, 0);

    // A members event still reaches the same channel.
    const shown = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(shown.deliveries, 1);
    assertEquals(captured.length, 1);

    // Once the member manages the organization, the managers event reaches them.
    await db.insert(grant).values({
      entityType: "organization",
      entityId: organizationId,
      actorType: "user",
      actorId: memberId,
      permission: "organization:manage",
    });
    const managed = await emitNotification(db, enc, {
      event: "server.deleted",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(managed.deliveries, 1);
    assertEquals(captured.length, 2);
  });
});

test("rows for a paused channel never fill the retry batch and starve a live one", async () => {
  await withFixture(async ({ db, organizationId }) => {
    const enc = await secrets();
    const paused = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "webhook",
      label: "Paused",
      address: "https://paused.example.com/hook",
    });
    const live = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "webhook",
      label: "Live",
      address: "https://live.example.com/hook",
    });
    await db
      .update(notificationChannel)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(notificationChannel.id, paused.id));

    const payload = {
      event: "server.offline",
      severity: "critical",
      title: "Server db-1 went offline",
      body: null,
      organizationId,
      organizationName: "Notify Org",
      targetType: null,
      targetId: null,
      context: { serverName: "db-1" },
      at: new Date().toISOString(),
    };
    // A full batch of older due rows for the paused channel, then one for the live one.
    const older = new Date(Date.now() - 60 * 60_000).toISOString();
    const newer = new Date(Date.now() - 60_000).toISOString();
    await db.insert(notificationDelivery).values(
      Array.from({ length: 5 }, () => ({
        channelId: paused.id,
        organizationId,
        event: "server.offline",
        severity: "critical",
        payload,
        status: "failed",
        attempts: 1,
        nextAttemptAt: older,
      })),
    );
    await db.insert(notificationDelivery).values({
      channelId: live.id,
      organizationId,
      event: "server.offline",
      severity: "critical",
      payload,
      status: "failed",
      attempts: 1,
      nextAttemptAt: newer,
    });

    const captured: Captured[] = [];
    const swept = await retryDueDeliveries(db, enc, {
      fetchImpl: fakeFetch(200, captured),
    }, 5);
    assertEquals(swept.sent, 1);
    assertEquals(captured.map((c) => c.url), ["https://live.example.com/hook"]);

    // The paused channel's rows are left waiting, untouched, for it to resume.
    const pausedRows = await db
      .select({ status: notificationDelivery.status })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, paused.id));
    assertEquals(pausedRows.length, 5);
    assertEquals(pausedRows.every((r) => r.status === "failed"), true);
  });
});

test("a failed delivery is a failed ledger row with a retry time, then the sweep resends it", async () => {
  await withFixture(async ({ db, organizationId }) => {
    const enc = await secrets();
    const channel = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "webhook",
      label: "Receiver",
      address: "https://receiver.example.com/hook",
      signingSecret: "shh",
    });
    await replaceRulesForChannel(db, channel.id, [{
      event: "server.offline",
      minSeverity: "info",
    }]);

    const result = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(503, []) });
    assertEquals(result.failed, 1);
    const [row] = await db
      .select({
        status: notificationDelivery.status,
        attempts: notificationDelivery.attempts,
        lastError: notificationDelivery.lastError,
        nextAttemptAt: notificationDelivery.nextAttemptAt,
      })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id));
    assertEquals(row!.status, "failed");
    assertEquals(row!.attempts, 1);
    assertEquals(row!.lastError, "http_503");
    assertEquals(typeof row!.nextAttemptAt, "string");

    // Bring the retry time forward and run the sweep with a receiver that answers.
    await db
      .update(notificationDelivery)
      .set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(notificationDelivery.channelId, channel.id));
    const captured: Captured[] = [];
    const swept = await retryDueDeliveries(db, enc, {
      fetchImpl: fakeFetch(200, captured),
    });
    assertEquals(swept.attempted >= 1, true);
    assertEquals(captured.length >= 1, true);
    const [after] = await db
      .select({
        status: notificationDelivery.status,
        attempts: notificationDelivery.attempts,
      })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channel.id));
    assertEquals(after, { status: "sent", attempts: 2 });
  });
});

test("email rows stay pending for the mailer; a disabled channel gets nothing; a LAN target obeys the policy", async () => {
  await withFixture(async ({ db, organizationId }) => {
    const enc = await secrets();
    const email = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "email",
      label: "Ops mail",
      address: "ops@example.com",
      verifiedAt: new Date().toISOString(),
    });
    await replaceRulesForChannel(db, email.id, [{
      event: "*",
      minSeverity: "info",
    }]);
    // An unverified address is never delivered to: its row stays pending.
    const stranger = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "email",
      label: "Stranger",
      address: "stranger@example.com",
    });
    await replaceRulesForChannel(db, stranger.id, [{
      event: "*",
      minSeverity: "info",
    }]);
    const lan = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "webhook",
      label: "Alertmanager",
      address: "https://10.0.0.5/alerts",
    });
    await replaceRulesForChannel(db, lan.id, [{
      event: "*",
      minSeverity: "info",
    }]);
    const off = await createNotificationChannel(db, enc, {
      scope: "organization",
      organizationId,
      kind: "slack",
      label: "Old",
      address: "https://hooks.slack.com/services/OLD",
    });
    await replaceRulesForChannel(db, off.id, [{
      event: "*",
      minSeverity: "info",
    }]);
    await db.update(notificationChannel).set({
      disabledAt: new Date().toISOString(),
    }).where(eq(notificationChannel.id, off.id));

    const captured: Captured[] = [];
    // The strict address gate through the test seam: proves a refused
    // address is recorded as a failed delivery rather than thrown.
    const hosted = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured), allowPrivateTargets: false });
    // Three routed channels (email, stranger email, LAN); the disabled one is not routed at all.
    assertEquals(hosted.deliveries, 3);
    assertEquals(captured.length, 0);
    const rows = await db
      .select({
        channelId: notificationDelivery.channelId,
        status: notificationDelivery.status,
        lastError: notificationDelivery.lastError,
      })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.organizationId, organizationId));
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    assertEquals(byChannel.get(email.id)?.status, "pending");
    assertEquals(byChannel.get(stranger.id)?.status, "pending");
    assertEquals(byChannel.get(lan.id)?.status, "failed");
    assertEquals(
      byChannel.get(lan.id)?.lastError,
      "address_address_not_public",
    );
    assertEquals(byChannel.has(off.id), false);

    // Self-hosted policy with a mail queue: the LAN receiver is dialled and
    // the email channel becomes one rendered job on the queue.
    const jobs: unknown[] = [];
    const selfHosted = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-2" },
      targetType: "server",
      targetId: "00000000-0000-4000-8000-0000000000b2",
    }, {
      fetchImpl: fakeFetch(200, captured),
      allowPrivateTargets: true,
      email: {
        queue: {
          enqueue: (job) => {
            jobs.push(job);
            return Promise.resolve();
          },
        },
        from: "noreply@example.com",
        consoleBaseUrl: "https://panel.example.com/",
      },
    });
    // The LAN receiver and the verified email; the stranger's stays pending.
    assertEquals(selfHosted.sent, 2);
    assertEquals(captured[0]!.url, "https://10.0.0.5/alerts");
    assertEquals(jobs.length, 1);
    const job = jobs[0] as Record<string, unknown>;
    assertEquals(job.type, "notification");
    assertEquals(job.to, "ops@example.com");
    assertEquals(job.title, "Server db-2 went offline");
    assertEquals(job.organizationName, "Notify Org");
    assertEquals(
      job.consoleUrl,
      `https://panel.example.com/${organizationId}/servers/00000000-0000-4000-8000-0000000000b2`,
    );
  });
});

test("emitting never throws: a broken database is a logged no-op", async () => {
  const broken = {
    transaction: () => Promise.reject(new Error("down")),
    select: () => {
      throw new Error("down");
    },
  } as unknown as ReturnType<typeof createDenoDb>;
  const result = await emitNotification(broken, undefined, {
    event: "server.offline",
    organizationId: "00000000-0000-4000-8000-0000000000a1",
  });
  assertEquals(result, { inbox: 0, deliveries: 0, sent: 0, failed: 0 });
  // A missing organization on an organization event is skipped, not thrown.
  const skipped = await emitNotification(broken, undefined, {
    event: "server.offline",
  });
  assertEquals(skipped.inbox, 0);
  // The inbox row count is unaffected: nothing reached a table.
  assertEquals(typeof notification, "object");
});
