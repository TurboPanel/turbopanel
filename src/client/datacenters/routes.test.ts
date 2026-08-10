import { assertEquals } from "@std/assert";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import { deriveSecretsConfig, parseSecretsEnv } from "../authn/secrets.ts";
import {
  datacenter,
  grant,
  membership,
  network,
  organization,
  server,
  user,
} from "../../lib/db/schema.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerDatacenterRoutes } from "./routes.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function createDatacenterRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });
  return { app, secrets };
}

async function withDatacenterFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const { app, secrets } = await createDatacenterRoutesTestApp(db);

  const [org] = await db
    .insert(organization)
    .values({ name: "DC Route Fixture Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-fixture-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId, userId });
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  try {
    await fn({ db, app, secrets, userId, organizationId });
  } finally {
    await db.delete(server).where(eq(server.organizationId, organizationId));
    await db.delete(network).where(eq(network.organizationId, organizationId));
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId));
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ));
    await db.delete(membership).where(and(
      eq(membership.userId, userId),
      eq(membership.organizationId, organizationId),
    ));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

test("GET /datacenters/name-suggestions uses unassigned server geo and ASN", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });

  const [org] = await db
    .insert(organization)
    .values({ name: "DC Suggestions Org" })
    .returning({ id: organization.id });
  const organizationId = org!.id;
  const [u] = await db
    .insert(user)
    .values({
      email: `dc-suggestions-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId, userId });
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });
  const [assignedDatacenter] = await db
    .insert(datacenter)
    .values({ organizationId, name: "Existing DC" })
    .returning({ id: datacenter.id });
  const [unassignedServer] = await db
    .insert(server)
    .values({
      organizationId,
      metadata: {
        geo: {
          city: "Amsterdam",
          country: "NL",
          asn: 13335,
          asOrganization: "Cloudflare",
        },
      },
    })
    .returning({ id: server.id });
  const [assignedServer] = await db
    .insert(server)
    .values({
      organizationId,
      datacenterId: assignedDatacenter!.id,
      metadata: { geo: { city: "Dallas", regionCode: "TX", country: "US" } },
    })
    .returning({ id: server.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request("/datacenters/name-suggestions", {
    headers: { cookie, [ORG_ID_HEADER]: organizationId },
  });

  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    suggestions: [{
      name: "Amsterdam NL - Cloudflare AS13335",
      serverCount: 1,
      serverIds: [unassignedServer!.id],
      serverLabels: [unassignedServer!.id],
      geo: {
        city: "Amsterdam",
        country: "NL",
        asn: 13335,
        asOrganization: "Cloudflare",
      },
    }],
  });

  await db.delete(server).where(eq(server.id, unassignedServer!.id));
  await db.delete(server).where(eq(server.id, assignedServer!.id));
  await db.delete(datacenter).where(eq(datacenter.id, assignedDatacenter!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(membership).where(eq(membership.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("GET /datacenters/:id returns 404 for datacenter in another org", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Org A" })
    .returning({ id: organization.id });
  const [orgB] = await db
    .insert(organization)
    .values({ name: "DC Org B" })
    .returning({ id: organization.id });

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-test-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId: orgA!.id, userId });
  await db.insert(grant).values({
    entityType: "organization",
    entityId: orgA!.id,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dcB] = await db
    .insert(datacenter)
    .values({
      organizationId: orgB!.id,
      name: "OtherDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dcB!.id}`, {
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
    },
  });

  assertEquals(res.status, 404);

  await db.delete(datacenter).where(eq(datacenter.id, dcB!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(membership).where(eq(membership.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, orgA!.id));
  await db.delete(organization).where(eq(organization.id, orgB!.id));
});

test("GET /datacenters returns 403 for org member without organization:manage", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC List Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-list-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId, userId });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request("/datacenters", {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 403);

  await db.delete(membership).where(eq(membership.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("DELETE /datacenters/:id succeeds when no scoped networks exist", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Delete Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-del-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId, userId });
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dc] = await db
    .insert(datacenter)
    .values({
      organizationId,
      name: "EmptyDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dc!.id}`, {
    method: "DELETE",
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 200);
  const body = await res.json() as { ok: boolean };
  assertEquals(body.ok, true);

  const [remaining] = await db
    .select({ id: datacenter.id })
    .from(datacenter)
    .where(eq(datacenter.id, dc!.id))
    .limit(1);
  assertEquals(remaining, undefined);

  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(membership).where(eq(membership.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("DELETE /datacenters/:id returns 409 when scoped networks exist", async () => {
  if (!dbUrl) {
    console.warn(
      "Skipping datacenter route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    "deno",
  );
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  registerDatacenterRoutes(app, { secrets, runtime: "deno" });

  const [orgA] = await db
    .insert(organization)
    .values({ name: "DC Network Org" })
    .returning({ id: organization.id });
  const organizationId = orgA!.id;

  const [u] = await db
    .insert(user)
    .values({
      email: `dc-net-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id });
  const userId = u!.id;

  await db.insert(membership).values({ organizationId, userId });
  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:manage",
  });

  const now = new Date().toISOString();
  const [dc] = await db
    .insert(datacenter)
    .values({
      organizationId,
      name: "NetworkedDC",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id });

  const [net] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      name: "DC Net",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: network.id });

  const cookie = await sessionCookie(db, secrets, userId);
  const res = await app.request(`/datacenters/${dc!.id}`, {
    method: "DELETE",
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  });

  assertEquals(res.status, 409);
  const body = await res.json() as { error: string };
  assertEquals(body.error, "datacenter_has_networks");

  const [stillThere] = await db
    .select({ id: datacenter.id })
    .from(datacenter)
    .where(eq(datacenter.id, dc!.id))
    .limit(1);
  assertEquals(stillThere?.id, dc!.id);

  await db.delete(network).where(eq(network.id, net!.id));
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id));
  await db.delete(grant).where(eq(grant.actorId, userId));
  await db.delete(membership).where(eq(membership.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("GET /datacenters lists datacenters with privateCidrs", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Listed DC",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.10.0.0/24",
      name: "Site LAN",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenters: Array<{ id: string; displayName: string; privateCidrs: string[] }>;
    };
    assertEquals(body.datacenters.length, 1);
    assertEquals(body.datacenters[0]?.id, dc!.id);
    assertEquals(body.datacenters[0]?.displayName, "Listed DC");
    assertEquals(body.datacenters[0]?.privateCidrs, ["10.10.0.0/24"]);
  });
});

test("GET /datacenters returns empty list when org has no datacenters", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { datacenters: [] });
  });
});

test("GET /datacenters/name-suggestions returns 400 for invalid limit", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters/name-suggestions?limit=-1", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 400);
  });
});

test("GET /datacenters/name-suggestions returns empty when no servers exist", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters/name-suggestions", {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { suggestions: [] });
  });
});

test("GET /datacenters/:id returns datacenter detail with privateCidrs", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Detail DC",
        description: "Edge site",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    await db.insert(network).values({
      organizationId,
      datacenterId: dc!.id,
      kind: "datacenter",
      cidr: "10.20.0.0/24",
      name: "Detail LAN",
      createdAt: now,
      updatedAt: now,
    });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    });

    assertEquals(res.status, 200);
    const body = await res.json() as {
      datacenter: { id: string; displayName: string; privateCidrs: string[] };
    };
    assertEquals(body.datacenter.id, dc!.id);
    assertEquals(body.datacenter.displayName, "Detail DC");
    assertEquals(body.datacenter.privateCidrs, ["10.20.0.0/24"]);
  });
});

test("POST /datacenters creates datacenter and assigns unassigned servers", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        metadata: {
          geo: {
            city: "Frankfurt",
            country: "DE",
            asn: 24940,
            asOrganization: "Hetzner",
          },
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceServerId: srv!.id,
        assignServerIds: [srv!.id],
      }),
    });

    assertEquals(res.status, 200);
    const body = await res.json() as { ok: true; id: string };
    assertEquals(body.ok, true);

    const [row] = await db
      .select({
        name: datacenter.name,
        datacenterId: server.datacenterId,
      })
      .from(server)
      .innerJoin(datacenter, eq(server.datacenterId, datacenter.id))
      .where(eq(server.id, srv!.id))
      .limit(1);
    assertEquals(row?.datacenterId, body.id);
    assertEquals(row?.name, "Frankfurt DE - Hetzner AS24940");
  });
});

test("POST /datacenters returns 409 when server is already assigned", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [existingDc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Existing",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        datacenterId: existingDc!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "New DC",
        assignServerIds: [srv!.id],
      }),
    });

    assertEquals(res.status, 409);
    const body = await res.json() as { error: string; serverId: string };
    assertEquals(body.error, "server_already_assigned");
    assertEquals(body.serverId, srv!.id);
  });
});

test("POST /datacenters returns 404 for server in another org", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: "Other DC Org" })
      .returning({ id: organization.id });
    const now = new Date().toISOString();
    const [otherSrv] = await db
      .insert(server)
      .values({
        organizationId: otherOrg!.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Cross Org DC",
        assignServerIds: [otherSrv!.id],
      }),
    });

    assertEquals(res.status, 404);

    await db.delete(server).where(eq(server.id, otherSrv!.id));
    await db.delete(organization).where(eq(organization.id, otherOrg!.id));
  });
});

test("POST /datacenters returns 400 for invalid assignServerIds", async () => {
  await withDatacenterFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request("/datacenters", {
      method: "POST",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad DC",
        assignServerIds: ["not-a-uuid"],
      }),
    });
    assertEquals(res.status, 400);
  });
});

test("PATCH /datacenters/:id updates name and description", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId,
        name: "Before",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "After",
        description: "Updated site",
        metadata: { region: "eu-west" },
      }),
    });

    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });

    const [row] = await db
      .select({
        name: datacenter.name,
        description: datacenter.description,
        metadata: datacenter.metadata,
      })
      .from(datacenter)
      .where(eq(datacenter.id, dc!.id))
      .limit(1);
    assertEquals(row?.name, "After");
    assertEquals(row?.description, "Updated site");
    assertEquals(row?.metadata, { region: "eu-west" });
  });
});

test("PATCH /datacenters/:id returns 404 for datacenter in another org", async () => {
  await withDatacenterFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: "Patch Other Org" })
      .returning({ id: organization.id });
    const now = new Date().toISOString();
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: "Foreign",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id });

    const cookie = await sessionCookie(db, secrets, userId);
    const res = await app.request(`/datacenters/${dc!.id}`, {
      method: "PATCH",
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Nope" }),
    });

    assertEquals(res.status, 404);

    await db.delete(datacenter).where(eq(datacenter.id, dc!.id));
    await db.delete(organization).where(eq(organization.id, otherOrg!.id));
  });
});
