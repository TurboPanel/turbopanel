import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { isInstanceInstalled } from "../client/authn/install-state.ts";
import { lookupActiveLicense } from "../client/authn/license.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "../client/authn/secrets.ts";
import type { DaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { buildJwksDocument } from "./authn/daemon-jwt-keyring.ts";
import {
  decryptSecretForDaemon,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
} from "../client/authn/data-encryption.ts";
import { getDb } from "../db.ts";
import { server } from "../lib/db/schema.ts";
import {
  createStatelessChallengeStore,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
} from "./cell/stateless-challenge.ts";
import { getDaemonOpenApiSpec } from "./openapi/index.ts";
import { buildDaemonScalarHtml } from "../scalar-html.ts";
import { resolveInstanceTlsCaPath } from "../server-paths.ts";
import { DAEMON_API_PREFIX } from "../surfaces.ts";
import { resolveServerId, touchServerMetadata } from "../server-registry.ts";
import { verifyDaemonLicense } from "./authn/license.ts";
import { issueDaemonJwt, verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import {
  attachDaemonStateToServer,
  getServerDaemonStateByFingerprint,
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
  touchDaemonKeyLastUsed,
} from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  verifyDaemonSignature,
} from "./authn/server-key.ts";
import type { RateLimiter } from "./rate-limit/contracts.ts";
import { createNoopRateLimiter } from "./rate-limit/contracts.ts";
import {
  daemonEnrollChallengeRateLimitKey,
  daemonRestRateLimitKey,
  type DaemonRestRateLimitRoute,
} from "./rate-limit/keys.ts";

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function challengeExpiresAt(at: string, ttlMs: number): string {
  const atMs = new Date(at).getTime();
  if (!Number.isFinite(atMs)) {
    return new Date(Date.now() + ttlMs).toISOString();
  }
  return new Date(atMs + ttlMs).toISOString();
}

/**
 * Daemon-facing surface: endpoints remote daemons and the node installer call.
 * Mounted under {@link DAEMON_API_PREFIX} (`/api/daemon/v1`).
 */
export function registerDaemonApiRoutes(
  app: Hono,
  options: {
    secrets?: DaemonJwtKeyring;
    challengeSigningSecrets?: DerivedSecretsConfig;
    secretsConfig?: SecretsConfig;
    restLimiter?: RateLimiter;
  } = {},
) {
  const daemon = new Hono();
  const { secrets, challengeSigningSecrets, secretsConfig } = options;
  const restLimiter = options.restLimiter ?? createNoopRateLimiter();
  const enrollStore = challengeSigningSecrets
    ? createStatelessChallengeStore(
      challengeSigningSecrets,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    )
    : null;
  const authStore = challengeSigningSecrets
    ? createStatelessChallengeStore(
      challengeSigningSecrets,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    )
    : null;

  async function enforceDaemonRestLimit(
    c: Context,
    key: string,
  ): Promise<Response | null> {
    const { success } = await restLimiter.limit({ key });
    if (!success) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    return null;
  }

  const requireDaemonJwt = async (c: Context, next: Next) => {
    if (!secrets) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    const payload = await verifyDaemonJwt(token, secrets);
    if (!payload) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    (c as Context<any>).set("daemonServerId", payload.sub);
    (c as Context<any>).set("daemonKeyId", payload.kid);
    (c as Context<any>).set("daemonTokenId", payload.jti);
    return next();
  };

  // Co-located self-hosted daemons poll this before opening the daemon WS.
  // Returns 503 until the install wizard has created org + superadmin.
  daemon.get("/readiness", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const installed = await isInstanceInstalled(db);
    if (!installed) {
      return c.json({ ok: true, ready: false, needsInstall: true }, 503);
    }

    return c.json({ ok: true, ready: true });
  });

  // Platform CA PEM — daemons add this to their trust store before dialing in.
  daemon.get("/instance/ca", async (c) => {
    // The Workers runtime has no `Deno` global and no filesystem, so it cannot
    // read the CA from disk. In co-located Workers dev the platform CA PEM is
    // injected (base64) into the Worker env; production Workers use publicly
    // trusted certs and have no platform CA to serve.
    if (typeof Deno === "undefined") {
      const env = c.env as
        | { TURBOPANEL_TLS_CA_PEM_B64?: string }
        | undefined;
      const b64 = env?.TURBOPANEL_TLS_CA_PEM_B64?.trim();
      if (!b64) {
        return c.json({ error: "platform CA not configured" }, 404);
      }
      try {
        const pem = atob(b64);
        return c.body(pem, 200, { "content-type": "application/x-pem-file" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    }
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaPath());
      return c.body(cert, 200, { "content-type": "application/x-pem-file" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  daemon.get("/jwks.json", (c) => {
    if (!secrets) {
      return c.json({ ok: false, error: "jwks unavailable" }, 503);
    }
    return c.json(buildJwksDocument(secrets), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  daemon.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(getDaemonOpenApiSpec(origin));
  });

  daemon.get("/reference", (c) => {
    return c.html(buildDaemonScalarHtml("/api/daemon/v1/openapi.json"));
  });

  daemon.post("/auth/challenge", async (c) => {
    const body = await c.req.json<{
      serverId?: string;
      keyId?: string;
    }>().catch(() => ({}));
    if (body.keyId || body.serverId) {
      const serverId = body.serverId?.trim();
      const keyId = body.keyId?.trim();
      if (!serverId || !keyId) {
        return c.json({ ok: false, error: "Missing serverId or keyId" }, 400);
      }

      const limited = await enforceDaemonRestLimit(
        c,
        daemonRestRateLimitKey(serverId, "auth-challenge"),
      );
      if (limited) return limited;

      const db = getDb(c);
      if (db === undefined) {
        return c.json({ ok: false, error: "Database unavailable" }, 503);
      }

      const daemonState = await getServerDaemonStateByServerId(db, serverId);
      if (!daemonState) {
        return c.json({ ok: false, error: "Server key not found" }, 404);
      }
      if (daemonState.key.id !== keyId) {
        return c.json({ ok: false, error: "Server key mismatch" }, 400);
      }
      if (!isDaemonKeyActive(daemonState.key)) {
        return c.json({ ok: false, error: "Server key is inactive" }, 400);
      }

      if (!authStore) {
        return c.json({ ok: false, error: "Challenge unavailable" }, 503);
      }
      const challenge = await authStore.issue({ serverId, keyId });
      return c.json({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
        expiresAt: challengeExpiresAt(challenge.at, authStore.ttlMs),
      }, 200);
    }

    const enrollChallengeLimited = await enforceDaemonRestLimit(
      c,
      daemonEnrollChallengeRateLimitKey(),
    );
    if (enrollChallengeLimited) return enrollChallengeLimited;

    if (!enrollStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await enrollStore.issue();
    return c.json({
      challengeId: challenge.id,
      nonce: challenge.nonce,
      at: challenge.at,
      expiresAt: challengeExpiresAt(challenge.at, enrollStore.ttlMs),
    }, 200);
  });

  daemon.post("/enroll", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>));
    const licenseId = normalizeRequiredString(body.licenseId);
    const licenseToken = normalizeRequiredString(body.licenseToken);
    const machineId = normalizeRequiredString(body.machineId) ?? undefined;
    const hostname = normalizeRequiredString(body.hostname);
    const challengeId = normalizeRequiredString(body.challengeId);
    const signature = normalizeRequiredString(body.signature);
    const publicJwk = isObjectRecord(body.publicJwk)
      ? body.publicJwk as JsonWebKey
      : null;

    // Keep malformed or omitted auth credentials on the same unauthorized path.
    if (!licenseId || !licenseToken) {
      return c.json({ ok: false, error: "Invalid license" }, 401);
    }
    if (!hostname || !challengeId || !signature || !publicJwk) {
      return c.json(
        { ok: false, error: "Missing required enroll fields" },
        400,
      );
    }

    const enrollLimited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(licenseId, "enroll"),
    );
    if (enrollLimited) return enrollLimited;

    if (!enrollStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await enrollStore.consume({ challengeId });
    if (!challenge) {
      return c.json({ ok: false, error: "Invalid or expired challenge" }, 400);
    }

    const verifiedLicense = await verifyDaemonLicense(
      db,
      licenseId,
      licenseToken,
    );
    if (!verifiedLicense) {
      return c.json({ ok: false, error: "Invalid license" }, 401);
    }

    const fingerprint = await computePublicKeyFingerprint(publicJwk);
    const payload = buildEnrollmentPayload({
      challengeId,
      nonce: challenge.nonce,
      licenseId,
      machineId: machineId ?? "",
      hostname,
      publicKeyFingerprint: fingerprint,
    });
    const verified = await verifyDaemonSignature(publicJwk, payload, signature);
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    const serverId = await resolveServerId(db, {
      machineId,
      hostname,
      licenseId,
      licenseToken,
    });
    if (!serverId) {
      return c.json({ ok: false, error: "Unable to resolve server" }, 400);
    }

    const existing = await getServerDaemonStateByFingerprint(db, fingerprint);
    if (existing && existing.serverId !== serverId) {
      return c.json({ ok: false, error: "Fingerprint already exists" }, 409);
    }

    let result: { keyId: string };
    try {
      result = await attachDaemonStateToServer(db, serverId, {
        publicJwk,
        fingerprint,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    }

    return c.json({ serverId, keyId: result.keyId }, 200);
  });

  daemon.post("/auth/session", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    if (!secrets) {
      return c.json({ ok: false, error: "Daemon auth unavailable" }, 503);
    }

    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>));
    const serverId = normalizeRequiredString(body.serverId);
    const keyId = normalizeRequiredString(body.keyId);
    const challengeId = normalizeRequiredString(body.challengeId);
    const signature = normalizeRequiredString(body.signature);
    const hostname = normalizeRequiredString(body.hostname);
    const machineId = normalizeRequiredString(body.machineId) ?? undefined;

    if (!serverId || !keyId || !challengeId || !signature || !hostname) {
      return c.json(
        { ok: false, error: "Missing required session fields" },
        400,
      );
    }

    const sessionLimited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(serverId, "auth-session"),
    );
    if (sessionLimited) return sessionLimited;

    const daemonState = await getServerDaemonStateByServerId(db, serverId);
    if (!daemonState) {
      return c.json({ ok: false, error: "Server key not found" }, 404);
    }
    if (daemonState.key.id !== keyId) {
      return c.json({ ok: false, error: "Server key mismatch" }, 400);
    }
    if (!isDaemonKeyActive(daemonState.key)) {
      return c.json({ ok: false, error: "Server key is inactive" }, 400);
    }

    const [licenseRow] = await db
      .select({ licenseId: server.licenseId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1);
    if (licenseRow?.licenseId) {
      const activeLicense = await lookupActiveLicense(db, licenseRow.licenseId);
      if (!activeLicense) {
        return c.json({ ok: false, error: "License is inactive" }, 400);
      }
    }

    if (!authStore) {
      return c.json({ ok: false, error: "Challenge unavailable" }, 503);
    }
    const challenge = await authStore.consume({
      challengeId,
      serverId,
      keyId,
    });
    if (!challenge) {
      return c.json({ ok: false, error: "Invalid or expired challenge" }, 400);
    }

    const payload = buildAuthPayload({
      challengeId,
      nonce: challenge.nonce,
      serverId,
      keyId,
      machineId: machineId ?? "",
      hostname,
    });
    const verified = await verifyDaemonSignature(
      daemonState.key.publicJwk,
      payload,
      signature,
    );
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    await touchDaemonKeyLastUsed(db, serverId);
    await touchServerMetadata(db, serverId, { machineId, hostname });

    const issued = await issueDaemonJwt(
      { sub: serverId, kid: keyId },
      secrets,
    );
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
    }, 200);
  });

  const enforceJwtRestLimit = (route: DaemonRestRateLimitRoute) =>
    async (c: Context, next: Next) => {
      const daemonServerId = c.get("daemonServerId") as string;
      const limited = await enforceDaemonRestLimit(
        c,
        daemonRestRateLimitKey(daemonServerId, route),
      );
      if (limited) return limited;
      return next();
    };

  daemon.post(
    "/commands/lease",
    requireDaemonJwt,
    enforceJwtRestLimit("commands-lease"),
    (c) => {
      return c.json({ commands: [] }, 200);
    },
  );

  const MAX_SECRETS_DECRYPT_BATCH = 100;

  // Recipient-bound daemon envelopes only — JWT sub/kid must match envelope metadata.
  daemon.post(
    "/secrets/decrypt",
    requireDaemonJwt,
    enforceJwtRestLimit("secrets-decrypt"),
    async (c) => {
      if (!secretsConfig) {
        return c.json({ ok: false, error: "decryption unavailable" }, 503);
      }

      const daemonServerId = c.get("daemonServerId") as string;
      const daemonKeyId = c.get("daemonKeyId") as string;

      const body = await c.req
        .json<{ ciphertexts?: unknown }>()
        .catch(() => ({} as { ciphertexts?: unknown }));
      if (!Array.isArray(body.ciphertexts)) {
        return c.json({ ok: false, error: "ciphertexts must be an array" }, 400);
      }
      if (
        body.ciphertexts.length === 0 ||
        body.ciphertexts.length > MAX_SECRETS_DECRYPT_BATCH
      ) {
        return c.json(
          { ok: false, error: `ciphertexts length must be 1-${MAX_SECRETS_DECRYPT_BATCH}` },
          400,
        );
      }
      if (!body.ciphertexts.every((entry) => typeof entry === "string")) {
        return c.json({ ok: false, error: "ciphertexts must be strings" }, 400);
      }

      const recipient = { serverId: daemonServerId, keyId: daemonKeyId };

      const plaintexts = await Promise.all(
        body.ciphertexts.map(async (ciphertext) => {
          try {
            if (!isDaemonSealedEnvelope(ciphertext)) {
              return null;
            }
            const parsed = parseDaemonSecretEnvelope(ciphertext);
            if (!parsed) {
              return null;
            }
            if (parsed.serverId !== daemonServerId || parsed.keyId !== daemonKeyId) {
              return null;
            }
            return await decryptSecretForDaemon(secretsConfig, recipient, ciphertext);
          } catch {
            return null;
          }
        }),
      );

      return c.json({ plaintexts }, 200);
    },
  );

  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
