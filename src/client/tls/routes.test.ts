import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { getDatabaseUrl } from "../../db-url.ts";
import { createDenoDb } from "../../db.ts";
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from "../authn/crypto.ts";
import { createSession } from "../authn/session-store.ts";
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from "../authn/secrets.ts";
import {
  command,
  environment,
  grant,
  managed,
  organization,
  project,
  changeover,
  server,
  tls,
  user,
  workspace,
} from "../../lib/db/schema.ts";
import { mintSelfSignedCertificate } from "../../lib/tls/index.ts";
import type { TlsMetadata } from "../../lib/tls/types.ts";
import { ORG_ID_HEADER } from "../org-context.ts";
import { registerTlsRoutes } from "./routes.ts";
import { ROTATION_FANOUT_BATCH_SIZE } from "./changeover-fanout.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import type { DaemonOutboundEnvelope } from "../../daemon/cell/protocol.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope);
      return Promise.resolve();
    },
  };
}

function createStubRegistry(): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) =>
        Promise.resolve({
          serverId: "stub",
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: "done" as const,
          createdAt: outbound.at,
          expiresAt: outbound.at,
          result: {},
        }),
    }),
  } as unknown as DaemonCellRegistry;
}

async function createTlsTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    "deno");
  const secrets = await deriveSecretsConfig(secretsConfig, "session-signing");
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    "data-encryption",
  );
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("secretsConfig", secretsConfig);
    c.set("dataEncryptionSecrets", dataEncryptionSecrets);
    c.set("daemonCellRegistry", createStubRegistry());
    c.set("commandQueue", createRecordingCommandQueue());
    return next();
  });
  registerTlsRoutes(app, { secrets, runtime: "deno", signupEnvOverride: undefined });
  return { app, secrets };
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {});
  const signed = await buildSignedCookie(token, secrets);
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`;
}

async function withTlsFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>;
    app: Hono<AppEnv>;
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>;
    userId: string;
    organizationId: string;
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn("Skipping tls route tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }

  const db = createDenoDb();
  const { app, secrets } = await createTlsTestApp(db);

  const [orgRow] = await db
    .insert(organization)
    .values({ name: "TLS Route Test Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;

  const [userRow] = await db
    .insert(user)
    .values({
      email: `tls-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: "user",
    })
    .returning({ id: user.id });
  const userId = userRow!.id;

  await db.insert(grant).values({
    entityType: "organization",
    entityId: organizationId,
    actorType: "user",
    actorId: userId,
    permission: "organization:own",
  });

  try {
    await fn({ db, app, secrets, userId, organizationId });
  } finally {
    await db.delete(changeover).where(
      eq(changeover.organizationId, organizationId),
    );
    await db.delete(tls).where(eq(tls.organizationId, organizationId));
    await db.delete(grant).where(eq(grant.actorId, userId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

async function seedManagedClusters(
  db: ReturnType<typeof createDenoDb>,
  params: {
    organizationId: string;
    count: number;
    serverId?: string;
  },
): Promise<{
  workspaceId: string;
  projectId: string;
  environmentIds: string[];
  managedIds: string[];
}> {
  const [workspaceRow] = await db
    .insert(workspace)
    .values({
      name: "TLS Rotation Workspace",
      organizationId: params.organizationId,
    })
    .returning({ id: workspace.id });
  const workspaceId = workspaceRow!.id;
  const [projectRow] = await db
    .insert(project)
    .values({ name: "TLS Rotation Project", workspaceId })
    .returning({ id: project.id });
  const projectId = projectRow!.id;
  const environmentIds: string[] = [];
  const managedIds: string[] = [];
  for (let i = 0; i < params.count; i++) {
    const [environmentRow] = await db
      .insert(environment)
      .values({
        name: `Cluster ${i + 1}`,
        projectId,
        serverId: params.serverId,
      })
      .returning({ id: environment.id });
    const environmentId = environmentRow!.id;
    environmentIds.push(environmentId);
    const [managedRow] = await db
      .insert(managed)
      .values({
        environmentId,
        serverId: params.serverId,
        name: `Cluster ${i + 1}`,
      })
      .returning({ id: managed.id });
    managedIds.push(managedRow!.id);
  }
  return { workspaceId, projectId, environmentIds, managedIds };
}

async function deleteSeededManagedClusters(
  db: ReturnType<typeof createDenoDb>,
  seeded: {
    workspaceId: string;
    projectId: string;
    environmentIds: string[];
    managedIds: string[];
  },
): Promise<void> {
  for (const managedId of seeded.managedIds) {
    await db.delete(managed).where(eq(managed.id, managedId));
  }
  for (const environmentId of seeded.environmentIds) {
    await db.delete(environment).where(eq(environment.id, environmentId));
  }
  await db.delete(project).where(eq(project.id, seeded.projectId));
  await db.delete(workspace).where(eq(workspace.id, seeded.workspaceId));
}

test("POST /tls lets_encrypt pending cert appears in list and detail with empty fingerprint", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const createRes = await app.request("/tls", {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "lets_encrypt",
          name: "Pending LE",
          hostnames: ["pending.example.com"],
          challengeType: "http-01",
        }),
      });
      assertEquals(createRes.status, 200);
      const created = await createRes.json() as { ok: true; id: string };
      assertEquals(created.ok, true);

      const [row] = await db
        .select({ fingerprintSha256: tls.fingerprintSha256 })
        .from(tls)
        .where(eq(tls.id, created.id))
        .limit(1);
      assertEquals(row?.fingerprintSha256, null);

      const listRes = await app.request("/tls", { headers });
      assertEquals(listRes.status, 200);
      const listBody = await listRes.json() as {
        tls: Array<{ id: string; metadata: TlsMetadata }>;
      };
      const listed = listBody.tls.find((entry) => entry.id === created.id);
      assertEquals(listed !== undefined, true);
      assertEquals(listed?.metadata.status, "pending");
      assertEquals(listed?.metadata.fingerprintSha256, "");
      assertEquals(listed?.metadata.dnsNames, ["pending.example.com"]);
      assertEquals(listed?.metadata.acme?.challengeType, "http-01");

      const detailRes = await app.request(`/tls/${created.id}`, { headers });
      assertEquals(detailRes.status, 200);
      const detailBody = await detailRes.json() as {
        tls: { metadata: TlsMetadata };
      };
      assertEquals(detailBody.tls.metadata.status, "pending");
      assertEquals(detailBody.tls.metadata.fingerprintSha256, "");
      assertEquals(detailBody.tls.metadata.dnsNames, ["pending.example.com"]);
    },
  );
});

test("POST /tls returns 409 tls_fingerprint_conflict for duplicate fingerprint", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const material = await mintSelfSignedCertificate(["dup.example.com"]);
      const body = JSON.stringify({
        source: "upload",
        name: "Dup fingerprint",
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
      });

      const first = await app.request("/tls", {
        method: "POST",
        headers,
        body,
      });
      assertEquals(first.status, 200);

      const second = await app.request("/tls", {
        method: "POST",
        headers,
        body,
      });
      assertEquals(second.status, 409);
      const conflict = await second.json() as { error: string };
      assertEquals(conflict.error, "tls_fingerprint_conflict");
    },
  );
});

test("POST /tls organization_ca succeeds once and second attempt returns 409", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const first = await app.request("/tls", {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "organization_ca",
          name: "Org CA",
        }),
      });
      assertEquals(first.status, 200);

      const second = await app.request("/tls", {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "organization_ca",
          name: "Org CA 2",
        }),
      });
      assertEquals(second.status, 409);
      const conflict = await second.json() as { error: string };
      assertEquals(conflict.error, "organization_ca_exists");
    },
  );
});

test("GET /tls/ca ensure-or-create is idempotent", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
      };

      const first = await app.request("/tls/ca", { headers });
      assertEquals(first.status, 200);
      const firstBody = await first.json() as {
        tls: {
          id: string;
          source: string;
          certificatePem: string | null;
          trustBundlePem?: string;
          notAfter: string | null;
          caGeneration: number | null;
          metadata: { subject: string };
        };
        trustBundlePem: string;
        leafHealth: {
          dueCount: number;
          caGeneration: number;
          caNotAfter: string | null;
        };
      };
      assertEquals(firstBody.tls.source, "organization_ca");
      assertEquals(typeof firstBody.tls.certificatePem, "string");
      assertEquals(
        firstBody.tls.metadata.subject,
        `O=TurboPanel, OU=Organization CA, CN=${organizationId}`,
      );
      assertEquals(typeof firstBody.trustBundlePem, "string");
      assertEquals(
        firstBody.trustBundlePem.includes("BEGIN CERTIFICATE"),
        true,
      );
      assertEquals(firstBody.tls.trustBundlePem, firstBody.trustBundlePem);
      assertEquals(firstBody.tls.caGeneration, 1);
      assertEquals(typeof firstBody.leafHealth.dueCount, "number");
      assertEquals(firstBody.leafHealth.dueCount, 0);
      assertEquals(firstBody.leafHealth.caGeneration, 1);
      assertEquals(firstBody.leafHealth.caGeneration, firstBody.tls.caGeneration);
      assertEquals(typeof firstBody.leafHealth.caNotAfter, "string");

      const second = await app.request("/tls/ca", { headers });
      assertEquals(second.status, 200);
      const secondBody = await second.json() as {
        tls: { id: string };
        trustBundlePem: string;
      };
      assertEquals(secondBody.tls.id, firstBody.tls.id);
      assertEquals(secondBody.trustBundlePem, firstBody.trustBundlePem);
    },
  );
});

test("POST /tls/ca/rotate retires prior CA and mints a new active generation", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const ensure = await app.request("/tls/ca", { headers });
      assertEquals(ensure.status, 200);
      const ensureBody = await ensure.json() as {
        tls: { id: string; certificatePem: string };
        trustBundlePem: string;
      };
      const priorId = ensureBody.tls.id;
      const priorPem = ensureBody.tls.certificatePem;

      const rotate = await app.request("/tls/ca/rotate", {
        method: "POST",
        headers,
      });
      assertEquals(rotate.status, 200);
      const rotateBody = await rotate.json() as {
        ok: true;
        id: string;
        rotationId: string;
        generation: number;
        results: unknown[];
      };
      assertEquals(rotateBody.ok, true);
      assertEquals(rotateBody.id === priorId, false);
      assertEquals(typeof rotateBody.rotationId, "string");
      assertEquals(rotateBody.generation, 2);
      assertEquals(Array.isArray(rotateBody.results), true);

      const [journal] = await db
        .select({
          id: changeover.id,
          state: changeover.state,
          fromCaGeneration: changeover.fromCaGeneration,
          toCaGeneration: changeover.toCaGeneration,
        })
        .from(changeover)
        .where(eq(changeover.organizationId, organizationId))
        .limit(1);
      assertEquals(journal?.id, rotateBody.rotationId);
      assertEquals(journal?.state, "awaiting_retire");
      assertEquals(journal?.fromCaGeneration, 1);
      assertEquals(journal?.toCaGeneration, 2);

      const statusRes = await app.request("/tls/ca/rotation", { headers });
      assertEquals(statusRes.status, 200);
      const statusBody = await statusRes.json() as {
        rotationId: string;
        state: string;
        retiredCaStillRequired: boolean;
      };
      assertEquals(statusBody.rotationId, rotateBody.rotationId);
      assertEquals(statusBody.state, "awaiting_retire");
      assertEquals(statusBody.retiredCaStillRequired, true);

      const [prior] = await db
        .select({
          status: tls.status,
          caState: tls.caState,
          caGeneration: tls.caGeneration,
        })
        .from(tls)
        .where(eq(tls.id, priorId))
        .limit(1);
      assertEquals(prior?.status, "ready");
      assertEquals(prior?.caState, "retired");
      assertEquals(prior?.caGeneration, 1);

      const [active] = await db
        .select({
          id: tls.id,
          status: tls.status,
          caState: tls.caState,
          caGeneration: tls.caGeneration,
        })
        .from(tls)
        .where(eq(tls.id, rotateBody.id))
        .limit(1);
      assertEquals(active?.status, "ready");
      assertEquals(active?.caState, "active");
      assertEquals(active?.caGeneration, 2);

      const after = await app.request("/tls/ca", { headers });
      assertEquals(after.status, 200);
      const afterBody = await after.json() as {
        tls: { id: string; certificatePem: string };
        trustBundlePem: string;
      };
      assertEquals(afterBody.tls.id, rotateBody.id);
      assertEquals(
        afterBody.trustBundlePem.includes(afterBody.tls.certificatePem.trim()),
        true,
      );
      assertEquals(afterBody.trustBundlePem.includes(priorPem.trim()), true);

      const download = await app.request("/tls/ca/download", { headers });
      assertEquals(download.status, 200);
      const downloadBody = await download.text();
      assertEquals(downloadBody, afterBody.trustBundlePem);
      assertEquals(downloadBody.split("BEGIN CERTIFICATE").length - 1, 2);
    },
  );
});

test("PATCH /tls/:id revoke:true on an Organization CA is rejected", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const ensure = await app.request("/tls/ca", { headers });
      assertEquals(ensure.status, 200);
      const ensureBody = await ensure.json() as {
        tls: { id: string };
      };

      const revoke = await app.request(`/tls/${ensureBody.tls.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ revoke: true }),
      });
      assertEquals(revoke.status, 409);
      const body = await revoke.json() as { error: string };
      assertEquals(body.error, "organization_ca_retire_required");

      const [row] = await db
        .select({ status: tls.status, caState: tls.caState })
        .from(tls)
        .where(eq(tls.id, ensureBody.tls.id))
        .limit(1);
      assertEquals(row?.status, "ready");
      assertEquals(row?.caState, "active");
    },
  );
});

test("GET /tls/ca/download returns the Organization CA trust-bundle PEM", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
      };

      const first = await app.request("/tls/ca", { headers });
      assertEquals(first.status, 200);
      const firstBody = await first.json() as { trustBundlePem: string };

      const download = await app.request("/tls/ca/download", { headers });
      assertEquals(download.status, 200);
      assertEquals(
        download.headers.get("content-type")?.includes(
          "application/x-pem-file",
        ),
        true,
      );
      const body = await download.text();
      assertEquals(body, firstBody.trustBundlePem);
      assertEquals(body.includes("BEGIN CERTIFICATE"), true);
      assertEquals(body.includes("privateKeyPem"), false);
      assertEquals(body.includes("BEGIN PRIVATE KEY"), false);

      const asJson = (() => {
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      assertEquals(asJson, null);
    },
  );
});

test("POST /tls/ca/rotate returns 409 while a changeover is in flight", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const ensure = await app.request("/tls/ca", { headers });
      assertEquals(ensure.status, 200);

      const first = await app.request("/tls/ca/rotate", {
        method: "POST",
        headers,
      });
      assertEquals(first.status, 200);

      const second = await app.request("/tls/ca/rotate", {
        method: "POST",
        headers,
      });
      assertEquals(second.status, 409);
      const body = await second.json() as { error: string };
      assertEquals(body.error, "ca_rotation_in_progress");
    },
  );
});

test("POST /tls/ca/retire waits for tracked command success then revokes the retired CA", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const ensure = await app.request("/tls/ca", { headers });
      assertEquals(ensure.status, 200);
      const ensureBody = await ensure.json() as {
        tls: { id: string; certificatePem: string };
      };
      const priorId = ensureBody.tls.id;
      const priorPem = ensureBody.tls.certificatePem;

      const rotate = await app.request("/tls/ca/rotate", {
        method: "POST",
        headers,
      });
      assertEquals(rotate.status, 200);
      const rotateBody = await rotate.json() as { rotationId: string };

      const [serverRow] = await db
        .insert(server)
        .values({ organizationId, name: "CA changeover host" })
        .returning({ id: server.id });
      const serverId = serverRow!.id;

      const [commandRow] = await db
        .insert(command)
        .values({
          serverId,
          actorType: "user",
          actorId: userId,
          name: "managed.ingress.reconcile",
          status: "queued",
        })
        .returning({ id: command.id });
      const commandId = commandRow!.id;

      try {
        await db
          .update(changeover)
          .set({
            results: [{
              serverId,
              kind: "ingress",
              commandId,
              status: "queued",
            }],
          })
          .where(eq(changeover.id, rotateBody.rotationId));

        const earlyRetire = await app.request("/tls/ca/retire", {
          method: "POST",
          headers,
        });
        assertEquals(earlyRetire.status, 409);
        const earlyBody = await earlyRetire.json() as { error: string };
        assertEquals(earlyBody.error, "ca_rotation_not_converged");

        await db
          .update(command)
          .set({ status: "succeeded" })
          .where(eq(command.id, commandId));

        const retire = await app.request("/tls/ca/retire", {
          method: "POST",
          headers,
        });
        assertEquals(retire.status, 200);
        const retireBody = await retire.json() as {
          ok: true;
          rotationId: string;
        };
        assertEquals(retireBody.ok, true);
        assertEquals(retireBody.rotationId, rotateBody.rotationId);

        const [prior] = await db
          .select({ caState: tls.caState, status: tls.status })
          .from(tls)
          .where(eq(tls.id, priorId))
          .limit(1);
        assertEquals(prior?.caState, "revoked");
        assertEquals(prior?.status, "revoked");

        const after = await app.request("/tls/ca", { headers });
        assertEquals(after.status, 200);
        const afterBody = await after.json() as { trustBundlePem: string };
        assertEquals(afterBody.trustBundlePem.includes(priorPem.trim()), false);

        const statusRes = await app.request("/tls/ca/rotation", { headers });
        assertEquals(statusRes.status, 200);
        const statusBody = await statusRes.json() as {
          state: string;
          retiredCaStillRequired: boolean;
        };
        assertEquals(statusBody.state, "completed");
        assertEquals(statusBody.retiredCaStillRequired, false);
      } finally {
        await db.delete(command).where(eq(command.id, commandId));
        await db.delete(server).where(eq(server.id, serverId));
      }
    },
  );
});

test("POST /tls/ca/rotate resumes fan-out across batches until awaiting_retire", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };
      const seeded = await seedManagedClusters(db, {
        organizationId,
        count: ROTATION_FANOUT_BATCH_SIZE + 1,
      });
      try {
        const ensure = await app.request("/tls/ca", { headers });
        assertEquals(ensure.status, 200);

        const first = await app.request("/tls/ca/rotate", {
          method: "POST",
          headers,
        });
        assertEquals(first.status, 200);
        const firstBody = await first.json() as {
          id: string;
          rotationId: string;
          generation: number;
          results: Array<{ managedId?: string; kind?: string }>;
        };
        assertEquals(firstBody.generation, 2);
        assertEquals(
          firstBody.results.filter((row) => row.kind === "apply").length,
          ROTATION_FANOUT_BATCH_SIZE,
        );

        const [afterFirst] = await db
          .select({
            state: changeover.state,
            toCaGeneration: changeover.toCaGeneration,
          })
          .from(changeover)
          .where(eq(changeover.id, firstBody.rotationId))
          .limit(1);
        assertEquals(afterFirst?.state, "in_progress");
        assertEquals(afterFirst?.toCaGeneration, 2);

        const second = await app.request("/tls/ca/rotate", {
          method: "POST",
          headers,
        });
        assertEquals(second.status, 200);
        const secondBody = await second.json() as {
          id: string;
          rotationId: string;
          generation: number;
          results: Array<{ managedId?: string; kind?: string }>;
        };
        assertEquals(secondBody.id, firstBody.id);
        assertEquals(secondBody.rotationId, firstBody.rotationId);
        assertEquals(secondBody.generation, 2);

        const [afterSecond] = await db
          .select({ state: changeover.state })
          .from(changeover)
          .where(eq(changeover.id, firstBody.rotationId))
          .limit(1);
        assertEquals(afterSecond?.state, "awaiting_retire");

        const applyManagedIds = secondBody.results
          .filter((row) => row.kind === "apply" && row.managedId)
          .map((row) => row.managedId as string)
          .sort((a, b) => a.localeCompare(b));
        assertEquals(
          applyManagedIds,
          [...seeded.managedIds].sort((a, b) => a.localeCompare(b)),
        );
      } finally {
        await deleteSeededManagedClusters(db, seeded);
      }
    },
  );
});

test("POST /tls/ca/rotate keeps kind and managedId when one server hosts two clusters", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };
      const [serverRow] = await db
        .insert(server)
        .values({ organizationId, name: "Shared changeover host" })
        .returning({ id: server.id });
      const serverId = serverRow!.id;
      const seeded = await seedManagedClusters(db, {
        organizationId,
        count: 2,
        serverId,
      });
      try {
        const ensure = await app.request("/tls/ca", { headers });
        assertEquals(ensure.status, 200);

        const rotate = await app.request("/tls/ca/rotate", {
          method: "POST",
          headers,
        });
        assertEquals(rotate.status, 200);
        const body = await rotate.json() as {
          results: Array<{
            serverId: string;
            kind?: string;
            managedId?: string;
            status: string;
          }>;
        };
        const applyRows = body.results.filter((row) => row.kind === "apply");
        assertEquals(applyRows.length, 2);
        assertEquals(applyRows[0]?.serverId, serverId);
        assertEquals(applyRows[1]?.serverId, serverId);
        assertEquals(
          applyRows[0]?.managedId === applyRows[1]?.managedId,
          false,
        );
        const managedIds = applyRows
          .map((row) => row.managedId)
          .sort((a, b) => (a ?? "").localeCompare(b ?? ""));
        assertEquals(
          managedIds,
          [...seeded.managedIds].sort((a, b) => a.localeCompare(b)),
        );

        const statusRes = await app.request("/tls/ca/rotation", { headers });
        assertEquals(statusRes.status, 200);
        const statusBody = await statusRes.json() as {
          results: Array<{
            serverId: string;
            kind?: string;
            managedId?: string;
          }>;
        };
        const statusApply = statusBody.results.filter((row) =>
          row.kind === "apply"
        );
        assertEquals(statusApply.length, 2);
        assertEquals(
          statusApply[0]?.managedId === statusApply[1]?.managedId,
          false,
        );
      } finally {
        await deleteSeededManagedClusters(db, seeded);
        await db.delete(command).where(eq(command.serverId, serverId));
        await db.delete(server).where(eq(server.id, serverId));
      }
    },
  );
});

test("POST /tls/ca/retire stays blocked when binding rematerialize failed", async () => {
  await withTlsFixtures(
    async ({ db, app, secrets, userId, organizationId }) => {
      const cookie = await sessionCookie(db, secrets, userId);
      const headers = {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        "content-type": "application/json",
      };

      const ensure = await app.request("/tls/ca", { headers });
      assertEquals(ensure.status, 200);

      const rotate = await app.request("/tls/ca/rotate", {
        method: "POST",
        headers,
      });
      assertEquals(rotate.status, 200);
      const rotateBody = await rotate.json() as { rotationId: string };

      await db
        .update(changeover)
        .set({
          state: "awaiting_retire",
          results: [{
            serverId: organizationId,
            kind: "binding",
            managedId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "failed",
            error: "binding_ca_unavailable",
          }],
        })
        .where(eq(changeover.id, rotateBody.rotationId));

      const retire = await app.request("/tls/ca/retire", {
        method: "POST",
        headers,
      });
      assertEquals(retire.status, 409);
      const body = await retire.json() as { error: string };
      assertEquals(body.error, "ca_rotation_not_converged");
    },
  );
});
