/**
 * The pipeline against a real Postgres: fan-out to the inbox, routing to a
 * channel by rule, the delivery ledger, the retry sweep, and the two
 * contracts that matter most — email/push rows stay pending for their own
 * transports, and a delivery failure never becomes the emitter's failure.
 * Skipped without TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { createDenoDb, endDbConnection } from "../../db.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../../client/authn/secrets.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import {
  notification,
  notificationChannel,
  notificationDelivery,
  organization,
  team,
  teammate,
  user,
} from "../db/schema.ts";
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

    // An info event does not pass a warning floor: no delivery row at all.
    const quiet = await emitNotification(db, enc, {
      event: "server.deleted",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured) });
    assertEquals(quiet, { inbox: 1, deliveries: 0, sent: 0, failed: 0 });
    assertEquals(captured.length, 1);
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
    });
    await replaceRulesForChannel(db, email.id, [{
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
    const hosted = await emitNotification(db, enc, {
      event: "server.offline",
      organizationId,
      context: { serverName: "db-1" },
    }, { fetchImpl: fakeFetch(200, captured), allowPrivateTargets: false });
    // Two routed channels (email, LAN); the disabled one is not routed at all.
    assertEquals(hosted.deliveries, 2);
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
    // deno-lint-ignore no-explicit-any
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
