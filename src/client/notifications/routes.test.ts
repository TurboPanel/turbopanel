/**
 * The notification routes against a real Postgres: the inbox is the user's
 * own; a channel's address is never handed back whole; organization channels
 * need a manager; a LAN address is accepted on every runtime. Skipped without
 * TURBOPANEL_DATABASE_URL like every Postgres suite.
 */
import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app/app.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import { createDenoDb, endDbConnection } from "../../db/connection.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from "../../lib/secrets/secrets.ts";
import {
  grant,
  notificationChannel,
  organization,
  team,
  teammate,
  user,
} from "../../db/schema.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import { emitNotification } from "../../features/notifications/emit.ts";
import { registerNotificationRoutes } from "./routes.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();

async function createApp(
  db: ReturnType<typeof createDenoDb>,
  runtime: "deno" | "workers",
) {
  const secretsConfig = parseTestSecretsConfig("deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("runtime", runtime);
    c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    return next();
  });
  registerNotificationRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride: undefined,
  });
  return { app, secrets, dataEncryptionSecrets };
}

async function cookieFor(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
    token,
    secrets,
  )}`;
}

type Ctx = {
  db: ReturnType<typeof createDenoDb>;
  app: Hono<AppEnv>;
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
  dataEncryptionSecrets: Awaited<
    ReturnType<typeof deriveEncryptionSecretsConfig>
  >;
  organizationId: string;
  managerId: string;
  memberId: string;
  managerCookie: string;
  memberCookie: string;
  memberEmail: string;
};

async function withFixtures(
  runtime: "deno" | "workers",
  fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping notification route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }
  const db = createDenoDb();
  const { app, secrets, dataEncryptionSecrets } = await createApp(db, runtime);
  const [org] = await db.insert(organization).values({
    name: "Notify Routes Org",
  }).returning({ id: organization.id });
  const organizationId = org!.id;
  const [manager] = await db
    .insert(user)
    .values({
      email: `nr-manager-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const memberEmail = `nr-member-${crypto.randomUUID()}@example.com`;
  const [member] = await db
    .insert(user)
    .values({
      email: memberEmail,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const [t] = await db.insert(team).values({
    name: "Notify Team",
    organizationId,
  }).returning({ id: team.id });
  await db.insert(teammate).values([
    { teamId: t!.id, userId: manager!.id },
    { teamId: t!.id, userId: member!.id },
  ]);
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: manager!.id,
    permission: "organization:manage",
  });
  try {
    await fn({
      db,
      app,
      secrets,
      dataEncryptionSecrets,
      organizationId,
      managerId: manager!.id,
      memberId: member!.id,
      managerCookie: await cookieFor(db, secrets, manager!.id),
      memberCookie: await cookieFor(db, secrets, member!.id),
      memberEmail,
    });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, manager!.id));
    await db.delete(user).where(eq(user.id, member!.id));
    await endDbConnection(db);
  }
}

function json(
  app: Hono<AppEnv>,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  org?: string,
) {
  return app.request(path, {
    method,
    headers: {
      Cookie: cookie,
      "content-type": "application/json",
      ...(org ? { [ORG_ID_HEADER]: org } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("the inbox is the user's own: list, unread count, mark read, dismiss", async () => {
  await withFixtures(
    "deno",
    async (
      {
        db,
        app,
        dataEncryptionSecrets,
        organizationId,
        memberCookie,
        managerCookie,
      },
    ) => {
      await emitNotification(db, dataEncryptionSecrets, {
        event: "server.offline",
        organizationId,
        context: { serverName: "db-1" },
      });
      const list = await json(app, memberCookie, "GET", "/notifications");
      assertEquals(list.status, 200);
      const body = await list.json() as {
        notifications: Array<
          { id: string; title: string; readAt: string | null }
        >;
        unread: number;
      };
      assertEquals(body.unread, 1);
      assertEquals(body.notifications[0]!.title, "Server db-1 went offline");
      assertEquals(body.notifications[0]!.readAt, null);

      // The manager got their own row; reading the member's changes nothing for them.
      const read = await json(
        app,
        memberCookie,
        "POST",
        "/notifications/read",
        { ids: [body.notifications[0]!.id] },
      );
      assertEquals((await read.json() as { unread: number }).unread, 0);
      const managerCount = await json(
        app,
        managerCookie,
        "GET",
        "/notifications/unread-count",
      );
      assertEquals(await managerCount.json(), { unread: 1 });

      const gone = await json(
        app,
        memberCookie,
        "DELETE",
        `/notifications/${body.notifications[0]!.id}`,
      );
      assertEquals(gone.status, 200);
      const after = await json(app, memberCookie, "GET", "/notifications");
      assertEquals(
        (await after.json() as { notifications: unknown[] }).notifications
          .length,
        0,
      );
      // Someone else's row is not found, not forbidden — nothing to learn.
      const foreign = await json(
        app,
        memberCookie,
        "DELETE",
        `/notifications/${crypto.randomUUID()}`,
      );
      assertEquals(foreign.status, 404);
    },
  );
});

test("a user channel is created sealed, described by origin, and never handed back whole", async () => {
  await withFixtures(
    "deno",
    async ({ db, app, memberCookie, managerCookie }) => {
      const created = await json(
        app,
        memberCookie,
        "POST",
        "/notification-channels",
        {
          kind: "slack",
          label: "My Slack",
          address: "https://hooks.slack.com/services/T0/B0/SECRETPATH",
          rules: [{ event: "*", minSeverity: "warning" }],
        },
      );
      assertEquals(created.status, 201);
      const { channel } = await created.json() as {
        channel: {
          id: string;
          address: string;
          scope: string;
          rules: unknown[];
        };
      };
      assertEquals(channel.scope, "user");
      assertEquals(channel.address, "https://hooks.slack.com");
      assertEquals(JSON.stringify(channel).includes("SECRETPATH"), false);
      assertEquals(channel.rules, [{ event: "*", minSeverity: "warning" }]);
      const [row] = await db.select({ address: notificationChannel.address })
        .from(notificationChannel).where(
          eq(notificationChannel.id, channel.id),
        );
      assertEquals(row!.address.startsWith("tpsecret."), true);

      // Only its owner sees or edits it.
      const others = await json(
        app,
        managerCookie,
        "GET",
        "/notification-channels?scope=user",
      );
      assertEquals(
        (await others.json() as { channels: unknown[] }).channels.length,
        0,
      );
      assertEquals(
        (await json(
          app,
          managerCookie,
          "PATCH",
          `/notification-channels/${channel.id}`,
          { label: "x" },
        )).status,
        404,
      );

      const patched = await json(
        app,
        memberCookie,
        "PATCH",
        `/notification-channels/${channel.id}`,
        {
          label: "Renamed",
          disabled: true,
          rules: [{ event: "server.offline" }],
        },
      );
      assertEquals(patched.status, 200);
      const p = (await patched.json() as {
        channel: {
          label: string;
          disabledAt: string | null;
          rules: unknown[];
        };
      }).channel;
      assertEquals(p.label, "Renamed");
      assertEquals(typeof p.disabledAt, "string");
      assertEquals(p.rules, [{ event: "server.offline", minSeverity: "info" }]);

      assertEquals(
        (await json(
          app,
          memberCookie,
          "DELETE",
          `/notification-channels/${channel.id}`,
        )).status,
        200,
      );
      assertEquals(
        (await json(
          app,
          memberCookie,
          "DELETE",
          `/notification-channels/${channel.id}`,
        )).status,
        404,
      );
    },
  );
});

test("an organization channel needs a manager and the organization header", async () => {
  await withFixtures(
    "deno",
    async (
      { app, organizationId, memberCookie, managerCookie, memberEmail },
    ) => {
      // An organization email channel may only name a member's account email.
      const stranger = {
        scope: "organization",
        kind: "email",
        label: "Ops mail",
        address: "ops@example.com",
        rules: [{ event: "*" }],
      };
      const refused = await json(
        app,
        managerCookie,
        "POST",
        "/notification-channels",
        stranger,
        organizationId,
      );
      assertEquals(refused.status, 422);
      assertEquals(
        (await refused.json() as { error: string }).error,
        "address_not_a_member",
      );
      const body = { ...stranger, address: memberEmail };
      assertEquals(
        (await json(
          app,
          memberCookie,
          "POST",
          "/notification-channels",
          body,
          organizationId,
        )).status,
        403,
      );
      const created = await json(
        app,
        managerCookie,
        "POST",
        "/notification-channels",
        body,
        organizationId,
      );
      assertEquals(created.status, 201);
      const { channel } = await created.json() as {
        channel: {
          id: string;
          address: string;
          scope: string;
          verifiedAt: string | null;
        };
      };
      assertEquals(channel.scope, "organization");
      // An email address is not a credential; it is shown as typed — and a
      // member's address is verified on the spot.
      assertEquals(channel.address, memberEmail);
      assertEquals(typeof channel.verifiedAt, "string");
      const listed = await json(
        app,
        managerCookie,
        "GET",
        "/notification-channels?scope=organization",
        undefined,
        organizationId,
      );
      assertEquals(
        (await listed.json() as { channels: Array<{ id: string }> }).channels
          .map((c) => c.id),
        [channel.id],
      );
      assertEquals(
        (await json(
          app,
          memberCookie,
          "DELETE",
          `/notification-channels/${channel.id}`,
        )).status,
        403,
      );
    },
  );
});
test("a LAN webhook is accepted on every runtime; scheme and credentials are still refused", async () => {
  // Decided 2026-09-18, "allow everywhere, no exceptions" — the rule used to
  // follow the runtime. A hosted instance cannot reach a private address
  // anyway, so the refusal there bought nothing but a second rule to explain.
  const body = {
    kind: "webhook",
    label: "Alertmanager",
    address: "https://10.0.0.5/alerts",
    signingSecret: "shh",
  };
  await withFixtures("workers", async ({ app, memberCookie }) => {
    const created = await json(
      app,
      memberCookie,
      "POST",
      "/notification-channels",
      body,
    );
    assertEquals(created.status, 201);
    const plain = await json(
      app,
      memberCookie,
      "POST",
      "/notification-channels",
      { ...body, address: "http://10.0.0.5/alerts" },
    );
    assertEquals(plain.status, 422);
    assertEquals(await plain.json(), {
      error: "address_rejected",
      reason: "scheme_not_https",
    });
  });
  await withFixtures("deno", async ({ app, memberCookie }) => {
    const created = await json(
      app,
      memberCookie,
      "POST",
      "/notification-channels",
      body,
    );
    assertEquals(created.status, 201);
    const { channel } = await created.json() as {
      channel: { signed: boolean; address: string };
    };
    assertEquals(channel.signed, true);
    assertEquals(channel.address, "https://10.0.0.5");
    // A signing secret on a kind that does not sign, and an unknown rule event, are 400s.
    const wrongKind = await json(
      app,
      memberCookie,
      "POST",
      "/notification-channels",
      { ...body, kind: "slack", address: "https://hooks.slack.com/x" },
    );
    assertEquals(wrongKind.status, 400);
    const unknownEvent = await json(
      app,
      memberCookie,
      "POST",
      "/notification-channels",
      {
        kind: "slack",
        label: "m",
        address: "https://hooks.slack.com/services/x",
        rules: [{ event: "deploy.succeeded" }],
      },
    );
    assertEquals(await unknownEvent.json(), {
      error: "rule_event_unknown",
      reason: "deploy.succeeded",
    });
  });
});

test("the catalogue lists every event with its severity and scope", async () => {
  await withFixtures("deno", async ({ app, memberCookie }) => {
    const res = await json(app, memberCookie, "GET", "/notification-events");
    const { events } = await res.json() as {
      events: Array<
        { event: string; severity: string; scope: string; example: string }
      >;
    };
    assertEquals(
      events.some((e) =>
        e.event === "server.offline" && e.severity === "critical" &&
        e.scope === "organization"
      ),
      true,
    );
    assertEquals(events.every((e) => e.example.length > 0), true);
  });
});
