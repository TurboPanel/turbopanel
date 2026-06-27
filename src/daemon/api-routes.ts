import { Hono } from "hono";
import type { Context, Next } from "hono";
import { isInstanceInstalled } from "../client/authn/install-state.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import { getDaemonCellRegistry, getDb } from "../db.ts";
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
} from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  verifyDaemonSignature,
} from "./authn/server-key.ts";
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
    secrets?: DerivedSecretsConfig;
    challengeSigningSecrets?: DerivedSecretsConfig;
  } = {},
) {
  const daemon = new Hono();
  const { secrets, challengeSigningSecrets } = options;
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
      const db = getDb(c);
      if (db === undefined) {
        return c.json({ ok: false, error: "Database unavailable" }, 503);
      }
      const serverId = body.serverId?.trim();
      const keyId = body.keyId?.trim();
      if (!serverId || !keyId) {
        return c.json({ ok: false, error: "Missing serverId or keyId" }, 400);
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

    const result = await attachDaemonStateToServer(db, serverId, {
      publicJwk,
      fingerprint,
    });

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

    const now = new Date().toISOString();
    const registry = getDaemonCellRegistry(c);
    if (registry) {
      void registry.getCell(serverId).putSnapshot({
        keyLastUsedAt: now,
        lastSeenAt: now,
      }).catch((err) => {
        console.warn("failed to touch daemon cell timestamps", err);
      });
    }
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

  daemon.post("/commands/lease", requireDaemonJwt, (c) => {
    return c.json({ commands: [] }, 200);
  });

  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
