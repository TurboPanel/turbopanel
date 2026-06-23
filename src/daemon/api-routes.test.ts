import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import { createLicense } from "../client/authn/license.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb } from "../db.ts";
import { organization, server } from "../lib/db/schema.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import { createRedisChallengeStore, createInMemoryChallengeStore, DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS } from "./cell/challenge-store.ts";
import { createRedisCellClient } from "./cell/redis/client.ts";
import { issueDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  parseServerDaemonState,
  type ServerDaemonState,
} from "./authn/daemon-state.ts";
import { revokeDaemonKey } from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
} from "./authn/server-key.ts";

const dbUrl = getDatabaseUrl();
const encoder = new TextEncoder();
const redisSocket =
  Deno.env.get("TURBOPANEL_REDIS_SOCKET") ?? "/run/turbopanel/redis.sock";

async function redisAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(redisSocket);
    return stat.isSocket === true;
  } catch {
    return false;
  }
}

type KeyMaterial = {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
};

type EnrollFixture = {
  db: ReturnType<typeof createDenoDb>;
  app: Hono<AppEnv>;
  organizationId: string;
  licenseId: string;
  licenseToken: string;
  serverId: string;
  keyId: string;
  enrollBody: { serverId: string; keyId: string };
  key: KeyMaterial;
  machineId: string;
  hostname: string;
};

async function createTestSecrets() {
  return await deriveSecretsConfig({
    versioned: [{ version: 1, value: "daemon_api_routes_test_secret_value" }],
  }, "daemon-jwt-signing");
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fingerprint = await computePublicKeyFingerprint(publicJwk);
  return {
    privateKey: pair.privateKey,
    publicJwk,
    fingerprint,
  };
}

function decodeJwtPayload(token: string): {
  sub: string;
  jti: string;
  kid: string;
  iat: number;
  exp: number;
  aud: string;
  typ: string;
} {
  const [, encodedPayload] = token.split(".");
  const padded = encodedPayload + "=".repeat((4 - (encodedPayload.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(base64)) as {
    sub: string;
    jti: string;
    kid: string;
    iat: number;
    exp: number;
    aud: string;
    typ: string;
  };
}

async function signPayload(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    encoder.encode(payload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function readDaemonState(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<ServerDaemonState | null> {
  const [row] = await db
    .select({ daemon: server.daemon })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);
  return parseServerDaemonState(row?.daemon);
}

async function readServerDaemonTimestamps(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<{ daemonKeyLastUsedAt: string | null; lastSeenAt: string | null } | null> {
  const [row] = await db
    .select({
      daemonKeyLastUsedAt: server.daemonKeyLastUsedAt,
      lastSeenAt: server.lastSeenAt,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);
  return row ?? null;
}

async function createTestApp(db: ReturnType<typeof createDenoDb>): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeStoreProvider = {
    enroll: createInMemoryChallengeStore(DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS),
    auth: createInMemoryChallengeStore(DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS),
  };
  registerDaemonApiRoutes(app, { secrets, challengeStoreProvider });
  return app;
}

async function createRedisBackedTestApp(
  db: ReturnType<typeof createDenoDb>,
  client: ReturnType<typeof createRedisCellClient>,
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  const secrets = await createTestSecrets();
  const authStore = createRedisChallengeStore(client);
  registerDaemonApiRoutes(app, {
    secrets,
    challengeStoreProvider: {
      enroll: authStore,
      auth: authStore,
    },
  });
  return app;
}

async function issueDaemonToken(serverId: string, keyId: string): Promise<string> {
  const secrets = await createTestSecrets();
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: keyId },
    secrets,
  );
  return issued.token;
}

async function issueAuthChallenge(
  app: Hono<AppEnv>,
  serverId: string,
  keyId: string,
): Promise<{ challengeId: string; nonce: string }> {
  const response = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, keyId }),
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { challengeId: string; nonce: string };
  return body;
}

async function withEnrollFixture(
  fn: (fixture: EnrollFixture) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping daemon API route tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const app = await createTestApp(db);
  const machineId = `machine-${crypto.randomUUID()}`;
  const hostname = `host-${crypto.randomUUID()}`;
  const [orgRow] = await db
    .insert(organization)
    .values({ displayName: "Daemon API Routes Test Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;
  const { licenseId, licenseToken } = await createLicense(db, {
    organizationId,
    displayName: "Daemon API Routes Test License",
  });

  const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(challengeResponse.status, 200);
  const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };

  const key = await generateKeyMaterial();
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId,
    machineId,
    hostname,
    publicKeyFingerprint: key.fingerprint,
  });
  const signature = await signPayload(key.privateKey, payload);

  const enrollResponse = await app.request("/api/daemon/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseId,
      licenseToken,
      machineId,
      hostname,
      publicJwk: key.publicJwk,
      challengeId: challenge.challengeId,
      signature,
    }),
  });
  assertEquals(enrollResponse.status, 200);
  const enrollBody = await enrollResponse.json() as { serverId: string; keyId: string };

  try {
    await fn({
      db,
      app,
      organizationId,
      licenseId,
      licenseToken,
      serverId: enrollBody.serverId,
      keyId: enrollBody.keyId,
      enrollBody,
      key,
      machineId,
      hostname,
    });
  } finally {
    await db.delete(server).where(eq(server.id, enrollBody.serverId));
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
}

Deno.test("POST /enroll rejects invalid license", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken: "invalid-token",
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /enroll rejects request without licenseToken", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(response.status, 401);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Invalid license");
  });
});

Deno.test("POST /enroll rejects invalid signature", async () => {
  await withEnrollFixture(async ({ app, licenseId, licenseToken, machineId, hostname }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const key = await generateKeyMaterial();

    const response = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken,
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature: "invalid-signature",
      }),
    });
    assertEquals(response.status, 403);
  });
});

Deno.test("POST /enroll stores public key only after proof-of-possession", async () => {
  await withEnrollFixture(async ({ db, serverId, keyId, key }) => {
    const daemonState = await readDaemonState(db, serverId);
    assertExists(daemonState);
    assertEquals(daemonState.key.id, keyId);
    assertEquals(daemonState.key.fingerprint, key.fingerprint);
    assertExists(daemonState.key.publicJwk);
    assertEquals(daemonState.key.algorithm, "Ed25519");
  });
});

Deno.test("POST /enroll returns serverId and server.daemon.key.id", async () => {
  await withEnrollFixture(async ({ enrollBody, db }) => {
    assertExists(enrollBody.serverId);
    assertExists(enrollBody.keyId);
    const daemonState = await readDaemonState(db, enrollBody.serverId);
    assertEquals(daemonState?.key.id, enrollBody.keyId);
  });
});

Deno.test("POST /enroll re-enrollment replaces daemon key on server row", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    licenseId,
    licenseToken,
    serverId,
    keyId,
    key,
    machineId,
    hostname,
  }) => {
    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const newKey = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: newKey.fingerprint,
    });
    const signature = await signPayload(newKey.privateKey, payload);

    const enrollResponse = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken,
        machineId,
        hostname,
        publicJwk: newKey.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(enrollResponse.status, 200);
    const body = await enrollResponse.json() as { serverId: string; keyId: string };
    assertEquals(body.serverId, serverId);
    assertEquals(body.keyId !== keyId, true);

    const daemonState = await readDaemonState(db, serverId);
    assertExists(daemonState);
    assertEquals(daemonState.key.id, body.keyId);
    assertEquals(daemonState.key.fingerprint, newKey.fingerprint);
    assertEquals(daemonState.key.fingerprint !== key.fingerprint, true);
  });
});

Deno.test("POST /enroll re-enrollment with recovery credential from same organization", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    organizationId,
    licenseId,
    licenseToken,
    serverId,
    keyId,
    key,
    machineId,
    hostname,
  }) => {
    const { licenseId: recoveryLicenseId, licenseToken: recoveryLicenseToken } =
      await createLicense(db, {
        organizationId,
        displayName: "Recovery Daemon API Routes Test License",
      });

    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const newKey = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId: recoveryLicenseId,
      machineId,
      hostname,
      publicKeyFingerprint: newKey.fingerprint,
    });
    const signature = await signPayload(newKey.privateKey, payload);

    const enrollResponse = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId: recoveryLicenseId,
        licenseToken: recoveryLicenseToken,
        machineId,
        hostname,
        publicJwk: newKey.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(enrollResponse.status, 200);
    const body = await enrollResponse.json() as { serverId: string; keyId: string };
    assertEquals(body.serverId, serverId);
    assertEquals(body.keyId !== keyId, true);

    const [row] = await db
      .select({
        licenseId: server.licenseId,
        daemon: server.daemon,
      })
      .from(server)
      .where(eq(server.id, serverId));
    const daemonState = parseServerDaemonState(row?.daemon);
    assertExists(daemonState);
    assertEquals(row?.licenseId, licenseId);
    assertEquals(daemonState.key.id, body.keyId);
    assertEquals(daemonState.key.fingerprint, newKey.fingerprint);
    assertEquals(daemonState.key.revokedAt, null);
    assertEquals(daemonState.key.fingerprint !== key.fingerprint, true);
  });
});

Deno.test("POST /enroll re-enrollment with same key clears revocation", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    licenseId,
    licenseToken,
    serverId,
    keyId,
    key,
    machineId,
    hostname,
  }) => {
    await revokeDaemonKey(db, serverId);

    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string };
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: key.fingerprint,
    });
    const signature = await signPayload(key.privateKey, payload);

    const enrollResponse = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken,
        machineId,
        hostname,
        publicJwk: key.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(enrollResponse.status, 200);
    const body = await enrollResponse.json() as { serverId: string; keyId: string };
    assertEquals(body.serverId, serverId);
    assertEquals(body.keyId !== keyId, true);

    const daemonState = await readDaemonState(db, serverId);
    assertExists(daemonState);
    assertEquals(daemonState.key.fingerprint, key.fingerprint);
    assertEquals(daemonState.key.revokedAt, null);

    const authChallengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId: body.keyId }),
    });
    assertEquals(authChallengeResponse.status, 200);
  });
});

Deno.test("POST /auth/session rejects malformed JSON", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Missing required session fields");
  });
});

Deno.test("POST /auth/session rejects missing required fields", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
      }),
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Missing required session fields");
  });
});

Deno.test("POST /enroll rejects re-enrollment from a different license with matching machineId", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    machineId,
    hostname,
    serverId,
    licenseId,
    organizationId,
  }) => {
    const [otherOrgRow] = await db
      .insert(organization)
      .values({ displayName: "Other Daemon API Routes Test Org" })
      .returning({ id: organization.id });
    const otherOrganizationId = otherOrgRow!.id;
    const { licenseId: otherLicenseId, licenseToken: otherLicenseToken } =
      await createLicense(db, {
        organizationId: otherOrganizationId,
        displayName: "Other Daemon API Routes Test License",
      });

    try {
      const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assertEquals(challengeResponse.status, 200);
      const challenge = await challengeResponse.json() as {
        challengeId: string;
        nonce: string;
      };
      const otherKey = await generateKeyMaterial();
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId: otherLicenseId,
        machineId,
        hostname,
        publicKeyFingerprint: otherKey.fingerprint,
      });
      const signature = await signPayload(otherKey.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId: otherLicenseId,
          licenseToken: otherLicenseToken,
          machineId,
          hostname,
          publicJwk: otherKey.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 400);
      const body = await enrollResponse.json() as { error?: string };
      assertEquals(body.error, "Unable to resolve server");

      const rows = await db
        .select({
          id: server.id,
          licenseId: server.licenseId,
          organizationId: server.organizationId,
        })
        .from(server)
        .where(eq(server.id, serverId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0]?.licenseId, licenseId);
      assertEquals(rows[0]?.organizationId, organizationId);
    } finally {
      await db.delete(organization).where(eq(organization.id, otherOrganizationId));
    }
  });
});

Deno.test("POST /enroll rejects re-enrollment from a different organization with matching hostname", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    machineId,
    hostname,
    serverId,
    licenseId,
    organizationId,
  }) => {
    const [otherOrgRow] = await db
      .insert(organization)
      .values({ displayName: "Cross Org Daemon API Routes Test Org" })
      .returning({ id: organization.id });
    const otherOrganizationId = otherOrgRow!.id;
    const { licenseId: otherLicenseId, licenseToken: otherLicenseToken } =
      await createLicense(db, {
        organizationId: otherOrganizationId,
        displayName: "Cross Org Daemon API Routes Test License",
      });

    try {
      const otherMachineId = `other-${crypto.randomUUID()}`;
      const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assertEquals(challengeResponse.status, 200);
      const challenge = await challengeResponse.json() as {
        challengeId: string;
        nonce: string;
      };
      const otherKey = await generateKeyMaterial();
      const payload = buildEnrollmentPayload({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        licenseId: otherLicenseId,
        machineId: otherMachineId,
        hostname,
        publicKeyFingerprint: otherKey.fingerprint,
      });
      const signature = await signPayload(otherKey.privateKey, payload);

      const enrollResponse = await app.request("/api/daemon/v1/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId: otherLicenseId,
          licenseToken: otherLicenseToken,
          machineId: otherMachineId,
          hostname,
          publicJwk: otherKey.publicJwk,
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      assertEquals(enrollResponse.status, 400);
      const body = await enrollResponse.json() as { error?: string };
      assertEquals(body.error, "Unable to resolve server");

      const rows = await db
        .select({
          id: server.id,
          licenseId: server.licenseId,
          organizationId: server.organizationId,
        })
        .from(server)
        .where(eq(server.id, serverId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0]?.licenseId, licenseId);
      assertEquals(rows[0]?.organizationId, organizationId);
    } finally {
      await db.delete(organization).where(eq(organization.id, otherOrganizationId));
    }
  });
});

Deno.test("POST /heartbeat succeeds with valid JWT after daemon key is revoked", async () => {
  await withEnrollFixture(async ({ db, app, serverId, keyId }) => {
    await revokeDaemonKey(db, serverId);

    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("POST /heartbeat succeeds with valid JWT after daemon key is replaced", async () => {
  await withEnrollFixture(async ({
    db,
    app,
    licenseId,
    licenseToken,
    serverId,
    keyId,
    machineId,
    hostname,
  }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as {
      challengeId: string;
      nonce: string;
    };
    const newKey = await generateKeyMaterial();
    const payload = buildEnrollmentPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId,
      hostname,
      publicKeyFingerprint: newKey.fingerprint,
    });
    const signature = await signPayload(newKey.privateKey, payload);
    const enrollResponse = await app.request("/api/daemon/v1/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseId,
        licenseToken,
        machineId,
        hostname,
        publicJwk: newKey.publicJwk,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    assertEquals(enrollResponse.status, 200);

    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("POST /auth/challenge rejects unknown keyId", async () => {
  await withEnrollFixture(async ({ app, keyId }) => {
    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: crypto.randomUUID(), keyId }),
    });
    assertEquals(response.status, 404);
  });
});

Deno.test("POST /auth/challenge rejects mismatched keyId", async () => {
  await withEnrollFixture(async ({ app, serverId }) => {
    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId: crypto.randomUUID() }),
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Server key mismatch");
  });
});

Deno.test("POST /auth/challenge rejects revoked daemon key", async () => {
  await withEnrollFixture(async ({ db, app, serverId, keyId }) => {
    await revokeDaemonKey(db, serverId);

    const response = await app.request("/api/daemon/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, keyId }),
    });
    assertEquals(response.status, 400);
    const body = await response.json() as { error?: string };
    assertEquals(body.error, "Server key is inactive");
  });
});

Deno.test("POST /auth/session rejects expired or used challenge", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, key, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);

    const first = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(first.status, 200);

    const second = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(second.status, 400);
  });
});

Deno.test("POST /auth/session rejects invalid signature", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature: "invalid-signature",
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 403);
  });
});

Deno.test("POST /auth/session returns a 15-minute JWT", async () => {
  await withEnrollFixture(async ({ app, db, serverId, keyId, key, machineId, hostname }) => {
    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { token: string };
    assertExists(body.token);
    const jwtPayload = decodeJwtPayload(body.token);
    assertEquals(jwtPayload.kid, keyId);
    assertEquals(jwtPayload.exp - jwtPayload.iat, 900);
    assert(typeof jwtPayload.jti === "string" && jwtPayload.jti.length > 0);
    assertEquals("sid" in jwtPayload, false);

    const timestamps = await readServerDaemonTimestamps(db, serverId);
    assertExists(timestamps?.daemonKeyLastUsedAt);
    assertExists(timestamps?.lastSeenAt);
  });
});

Deno.test("Protected route rejects missing JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /heartbeat returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "daemon-host" }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /heartbeat returns 200 with valid JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const jwtPayload = decodeJwtPayload(daemonToken);
    assertEquals("sid" in jwtPayload, false);
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      },
      body: JSON.stringify({ hostname: "daemon-host" }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { ok: boolean };
    assertEquals(body, { ok: true });
  });
});

Deno.test("POST /heartbeat returns 401 with expired JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secrets = await createTestSecrets();
    const issued = await issueDaemonJwt(
      { sub: serverId, kid: keyId },
      secrets,
      Date.now() - (16 * 60 * 1000),
    );
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
      },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /commands/lease returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /commands/lease returns 200 with valid JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { commands: unknown[] };
    assertEquals(body, { commands: [] });
  });
});

Deno.test("Enrolled daemon can auto-refresh JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId, key, machineId, hostname }) => {
    const secrets = await createTestSecrets();
    const nearExpiryIssued = await issueDaemonJwt(
      { sub: serverId, kid: keyId },
      secrets,
      Date.now() - ((15 * 60 * 1000) - 30_000),
    );
    const nearExpiryPayload = decodeJwtPayload(nearExpiryIssued.token);
    const nowBeforeRefresh = Math.floor(Date.now() / 1000);
    const nearExpiryRemaining = nearExpiryPayload.exp - nowBeforeRefresh;
    assert(
      nearExpiryRemaining <= 60,
      `expected near-expiry token to have <= 60s left, got ${nearExpiryRemaining}s`,
    );

    const challenge = await issueAuthChallenge(app, serverId, keyId);
    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId,
      hostname,
    });
    const signature = await signPayload(key.privateKey, payload);
    const response = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        keyId,
        challengeId: challenge.challengeId,
        signature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { token: string };
    const refreshedPayload = decodeJwtPayload(body.token);
    const nowAfterRefresh = Math.floor(Date.now() / 1000);
    const refreshedRemaining = refreshedPayload.exp - nowAfterRefresh;
    assert(
      refreshedRemaining > 14 * 60,
      `expected refreshed token to have > 14 minutes left, got ${refreshedRemaining}s`,
    );
    assert(
      refreshedPayload.exp > nearExpiryPayload.exp + (10 * 60),
      "expected refresh token to meaningfully extend expiry over near-expiry token",
    );
    assert(
      refreshedPayload.iat >= nearExpiryPayload.iat,
      "expected refreshed token to be newly issued",
    );
  });
});

Deno.test("JWT verification uses stateless token without sid claim", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secrets = await createTestSecrets();
    const issued = await issueDaemonJwt({ sub: serverId, kid: keyId }, secrets);
    const jwtPayload = decodeJwtPayload(issued.token);
    assertEquals("sid" in jwtPayload, false);
    assert(typeof jwtPayload.jti === "string" && jwtPayload.jti.length > 0);

    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
      },
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("POST /heartbeat accepts stateless JWT without sid claim", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const jwtPayload = decodeJwtPayload(daemonToken);
    assertEquals("sid" in jwtPayload, false);

    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
      },
    });
    assertEquals(response.status, 200);
  });
});

Deno.test("Protected route rejects invalid JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-jwt",
      },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("Protected route rejects expired JWT", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secrets = await createTestSecrets();
    const issued = await issueDaemonJwt(
      { sub: serverId, kid: keyId },
      secrets,
      Date.now() - (16 * 60 * 1000),
    );
    const response = await app.request("/api/daemon/v1/heartbeat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
      },
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /auth/session with Redis challenge store enforces single-use consume", async () => {
  if (!(await redisAvailable())) {
    console.warn(
      `Skipping Redis-backed auth challenge test: socket not found at ${redisSocket}`,
    );
    return;
  }
  if (!dbUrl) {
    console.warn(
      "Skipping Redis-backed auth challenge test: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const client = createRedisCellClient();
  const db = createDenoDb();
  const app = await createRedisBackedTestApp(db, client);
  const machineId = `machine-${crypto.randomUUID()}`;
  const hostname = `host-${crypto.randomUUID()}`;
  const [orgRow] = await db
    .insert(organization)
    .values({ displayName: "Redis Challenge Store Test Org" })
    .returning({ id: organization.id });
  const organizationId = orgRow!.id;
  const { licenseId, licenseToken } = await createLicense(db, {
    organizationId,
    displayName: "Redis Challenge Store Test License",
  });

  const challengeResponse = await app.request("/api/daemon/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(challengeResponse.status, 200);
  const challenge = await challengeResponse.json() as {
    challengeId: string;
    nonce: string;
  };

  const key = await generateKeyMaterial();
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId,
    machineId,
    hostname,
    publicKeyFingerprint: key.fingerprint,
  });
  const signature = await signPayload(key.privateKey, payload);

  const enrollResponse = await app.request("/api/daemon/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseId,
      licenseToken,
      machineId,
      hostname,
      publicJwk: key.publicJwk,
      challengeId: challenge.challengeId,
      signature,
    }),
  });
  assertEquals(enrollResponse.status, 200);
  const enrollBody = await enrollResponse.json() as { serverId: string; keyId: string };

  try {
    const authChallenge = await issueAuthChallenge(
      app,
      enrollBody.serverId,
      enrollBody.keyId,
    );
    const authPayload = buildAuthPayload({
      challengeId: authChallenge.challengeId,
      nonce: authChallenge.nonce,
      serverId: enrollBody.serverId,
      keyId: enrollBody.keyId,
      machineId,
      hostname,
    });
    const authSignature = await signPayload(key.privateKey, authPayload);

    const first = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: enrollBody.serverId,
        keyId: enrollBody.keyId,
        challengeId: authChallenge.challengeId,
        signature: authSignature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(first.status, 200);

    const second = await app.request("/api/daemon/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: enrollBody.serverId,
        keyId: enrollBody.keyId,
        challengeId: authChallenge.challengeId,
        signature: authSignature,
        machineId,
        hostname,
        at: new Date().toISOString(),
      }),
    });
    assertEquals(second.status, 400);
  } finally {
    await db.delete(server).where(eq(server.id, enrollBody.serverId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await client.close();
  }
});
