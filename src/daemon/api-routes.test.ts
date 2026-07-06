import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import {
  decodeBase64Url,
  encodeBase64Url,
} from "@std/encoding/base64url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { deriveSecretsConfig } from "../client/authn/secrets.ts";
import { deriveDaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { encryptSecretForDaemon } from "../client/authn/data-encryption.ts";
import { createLicense } from "../client/authn/license.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb } from "../db.ts";
import { organization, server } from "../lib/db/schema.ts";
import { registerDaemonApiRoutes } from "./api-routes.ts";
import type { DaemonCell, DaemonCellRegistry, DaemonCellSnapshot } from "./cell/contracts.ts";
import {
  consumeChallenge,
  createStatelessChallengeStore,
  issueChallenge,
} from "./cell/stateless-challenge.ts";
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
  return await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: "daemon_api_routes_test_secret_value" }],
  });
}

async function createTestChallengeSecrets() {
  return await deriveSecretsConfig({
    versioned: [{ version: 1, value: "daemon_api_routes_test_challenge_secret" }],
  }, "daemon-challenge-signing");
}

function createTestSecretsConfig() {
  return {
    versioned: [{ version: 1, value: "daemon_api_routes_test_data_encryption_secret" }],
  };
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
  const padded = encodedPayload +
    "=".repeat((4 - (encodedPayload.length % 4)) % 4);
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

async function createTestApp(
  db: ReturnType<typeof createDenoDb>,
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, { secrets, challengeSigningSecrets, secretsConfig });
  return app;
}

function createSnapshotTrackingCell(
  serverId: string,
): {
  cell: DaemonCell;
  putSnapshotPatches: Partial<DaemonCellSnapshot>[];
} {
  const putSnapshotPatches: Partial<DaemonCellSnapshot>[] = [];
  const noopAsync = async () => {};
  const cell: DaemonCell = {
    attachDaemonSocket: async () => ({
      connectionId: "conn",
      lease: {
        holder: "conn",
        token: "conn",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => {
      putSnapshotPatches.push(patch);
      return {
        serverId,
        version: putSnapshotPatches.length,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      };
    },
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "queued" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: "expired" as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => false,
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: noopAsync,
  };
  return { cell, putSnapshotPatches };
}

function wrapDbWithUpdateSpy(db: ReturnType<typeof createDenoDb>): {
  db: ReturnType<typeof createDenoDb>;
  updateCalls: number;
} {
  let updateCalls = 0;
  const originalUpdate = db.update.bind(db);
  const spiedDb = Object.assign(db, {
    update: (...args: Parameters<typeof db.update>) => {
      updateCalls += 1;
      return originalUpdate(...args);
    },
  });
  return {
    db: spiedDb,
    get updateCalls() {
      return updateCalls;
    },
  };
}

async function createTestAppWithRegistry(
  db: ReturnType<typeof createDenoDb>,
  registry: DaemonCellRegistry,
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("daemonCellRegistry", registry);
    return next();
  });
  const secrets = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, { secrets, challengeSigningSecrets, secretsConfig });
  return app;
}

async function issueDaemonToken(
  serverId: string,
  keyId: string,
): Promise<string> {
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
  const enrollBody = await enrollResponse.json() as {
    serverId: string;
    keyId: string;
  };

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

Deno.test("GET /jwks.json returns public OKP keys only", async () => {
  const app = new Hono<AppEnv>();
  const keyring = await createTestSecrets();
  const challengeSigningSecrets = await createTestChallengeSecrets();
  const secretsConfig = createTestSecretsConfig();
  registerDaemonApiRoutes(app, {
    secrets: keyring,
    challengeSigningSecrets,
    secretsConfig,
  });

  const response = await app.request("/api/daemon/v1/jwks.json");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "public, max-age=300");

  const bodyText = await response.text();
  assertEquals(bodyText.includes("daemon_api_routes_test_secret_value"), false);
  assertEquals(bodyText.includes("daemon_api_routes_test_challenge_secret"), false);
  assertEquals(bodyText.includes("daemon_api_routes_test_data_encryption_secret"), false);

  const body = JSON.parse(bodyText) as { keys: JsonWebKey[] };
  assert(body.keys.length > 0);
  for (const key of body.keys) {
    assertEquals(key.kty, "OKP");
    assertEquals(key.crv, "Ed25519");
    assertEquals(key.alg, "EdDSA");
    assertEquals(key.use, "sig");
    assertEquals(typeof key.kid, "string");
    assertEquals(typeof key.x, "string");
    assertEquals("d" in key, false);
  }

  const issued = await issueDaemonJwt(
    { sub: crypto.randomUUID(), kid: crypto.randomUUID() },
    keyring,
  );
  const [encodedHeader, encodedPayload, encodedSig] = issued.token.split(".");
  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(encodedHeader)),
  ) as { kid?: string };
  assertEquals(typeof header.kid, "string");

  const jwksEntry = body.keys.find((entry) => entry.kid === header.kid);
  assertExists(jwksEntry);

  const verifyKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwksEntry.kty,
      crv: jwksEntry.crv,
      x: jwksEntry.x,
    },
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    verifyKey,
    decodeBase64Url(encodedSig),
    encoder.encode(signingInput),
  );
  assertEquals(verified, true);
});

Deno.test("POST /enroll rejects invalid license", async () => {
  await withEnrollFixture(async ({ app, licenseId, machineId, hostname }) => {
    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
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
    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
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
  await withEnrollFixture(
    async ({ app, licenseId, licenseToken, machineId, hostname }) => {
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assertEquals(challengeResponse.status, 200);
      const challenge = await challengeResponse.json() as {
        challengeId: string;
        nonce: string;
      };
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
    },
  );
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
    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
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
    const body = await enrollResponse.json() as {
      serverId: string;
      keyId: string;
    };
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

    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as {
      challengeId: string;
      nonce: string;
    };
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
    const body = await enrollResponse.json() as {
      serverId: string;
      keyId: string;
    };
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

    const challengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assertEquals(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as {
      challengeId: string;
      nonce: string;
    };
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
    const body = await enrollResponse.json() as {
      serverId: string;
      keyId: string;
    };
    assertEquals(body.serverId, serverId);
    assertEquals(body.keyId !== keyId, true);

    const daemonState = await readDaemonState(db, serverId);
    assertExists(daemonState);
    assertEquals(daemonState.key.fingerprint, key.fingerprint);
    assertEquals(daemonState.key.revokedAt, null);

    const authChallengeResponse = await app.request(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, keyId: body.keyId }),
      },
    );
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
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
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
      await db.delete(organization).where(
        eq(organization.id, otherOrganizationId),
      );
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
      const challengeResponse = await app.request(
        "/api/daemon/v1/auth/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
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
      await db.delete(organization).where(
        eq(organization.id, otherOrganizationId),
      );
    }
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

Deno.test("POST /auth/session rejects expired challenge", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, key, machineId, hostname }) => {
      const challengeSecrets = await createTestChallengeSecrets();
      const challenge = await issueChallenge(
        challengeSecrets,
        { serverId, keyId },
        60_000,
        Date.now() - 120_000,
      );
      const payload = buildAuthPayload({
        challengeId: challenge.id,
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
          challengeId: challenge.id,
          signature,
          machineId,
          hostname,
          at: new Date().toISOString(),
        }),
      });
      assertEquals(response.status, 400);
    },
  );
});

Deno.test("POST /auth/session rejects invalid signature", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, machineId, hostname }) => {
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
    },
  );
});

Deno.test("POST /auth/session returns a 15-minute JWT", async () => {
  await withEnrollFixture(
    async ({ db, serverId, keyId, key, machineId, hostname }) => {
      const tracking = createSnapshotTrackingCell(serverId);
      const registry: DaemonCellRegistry = {
        getCell: () => tracking.cell,
        listOnlineServerIds: async () => [],
        getSnapshots: async () => new Map(),
        purge: async () => {},
      };
      const app = await createTestAppWithRegistry(db, registry);

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

      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(tracking.putSnapshotPatches.length, 1);
      assertExists(tracking.putSnapshotPatches[0]?.keyLastUsedAt);
      assertExists(tracking.putSnapshotPatches[0]?.lastSeenAt);
    },
  );
});

Deno.test("Protected route rejects missing JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
    });
    assertEquals(response.status, 401);
  });
});


Deno.test("Protected route rejects invalid JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/commands/lease", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-valid-jwt",
      },
    });
    assertEquals(response.status, 401);
  });
});


Deno.test("stateless challenge issue and consume round-trip", async () => {
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const consumed = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  assertExists(consumed);
  assertEquals(consumed?.nonce, issued.nonce);
});

Deno.test("stateless challenge consume rejects wrong serverId", async () => {
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const consumed = await store.consume({
    challengeId: issued.id,
    serverId: "other-server",
    keyId: "key-1",
  });
  assertEquals(consumed, null);
});

Deno.test("stateless challenge consume rejects expired token", async () => {
  const secrets = await createTestChallengeSecrets();
  const issued = await issueChallenge(
    secrets,
    { serverId: "server-1", keyId: "key-1" },
    60_000,
    Date.now() - 120_000,
  );
  const consumed = await consumeChallenge(
    secrets,
    { challengeId: issued.id, serverId: "server-1", keyId: "key-1" },
    60_000,
  );
  assertEquals(consumed, null);
});

Deno.test("stateless challenge allows replay within TTL", async () => {
  // Not single-use: a valid token can be consumed repeatedly until it expires.
  // Security relies on the short TTL plus Ed25519 proof-of-possession at session time.
  const secrets = await createTestChallengeSecrets();
  const store = createStatelessChallengeStore(secrets, 60_000);
  const issued = await store.issue({ serverId: "server-1", keyId: "key-1" });
  const first = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  const second = await store.consume({
    challengeId: issued.id,
    serverId: "server-1",
    keyId: "key-1",
  });
  assertExists(first);
  assertExists(second);
  assertEquals(second?.nonce, issued.nonce);
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
Deno.test("POST /secrets/decrypt returns 401 without JWT", async () => {
  await withEnrollFixture(async ({ app }) => {
    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertexts: ["tpsecret.v1.1.x.y"] }),
    });
    assertEquals(response.status, 401);
  });
});

Deno.test("POST /secrets/decrypt returns 400 on malformed body", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const missingArray = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assertEquals(missingArray.status, 400);

    const emptyArray = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: [] }),
    });
    assertEquals(emptyArray.status, 400);
  });
});

Deno.test("POST /secrets/decrypt round-trips batch with mixed valid/invalid", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secretsConfig = createTestSecretsConfig();
    const sealed = await encryptSecretForDaemon(
      secretsConfig,
      { serverId, keyId },
      "daemon-secret-value",
    );
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ciphertexts: [sealed, "not-a-valid-envelope", sealed],
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts.length, 3);
    assertEquals(body.plaintexts[0], "daemon-secret-value");
    assertEquals(body.plaintexts[1], null);
    assertEquals(body.plaintexts[2], "daemon-secret-value");
  });
});

Deno.test("POST /secrets/decrypt rejects envelopes sealed for another daemon", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const secretsConfig = createTestSecretsConfig();
    const sealed = await encryptSecretForDaemon(
      secretsConfig,
      { serverId: "00000000-0000-4000-8000-000000000099", keyId: "other-key" },
      "other-daemon-secret",
    );
    const daemonToken = await issueDaemonToken(serverId, keyId);

    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: [sealed] }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts, [null]);
  });
});

Deno.test("POST /secrets/decrypt rejects legacy global tpsecret envelopes", async () => {
  await withEnrollFixture(async ({ app, serverId, keyId }) => {
    const daemonToken = await issueDaemonToken(serverId, keyId);
    const response = await app.request("/api/daemon/v1/secrets/decrypt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ciphertexts: ["tpsecret.v1.1.x.y"] }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { plaintexts: (string | null)[] };
    assertEquals(body.plaintexts, [null]);
  });
});


Deno.test("Enrolled daemon can auto-refresh JWT", async () => {
  await withEnrollFixture(
    async ({ app, serverId, keyId, key, machineId, hostname }) => {
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
    },
  );
});






