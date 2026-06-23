import { Hono } from "hono";
import type { Context, Next } from "hono";
import { isInstanceInstalled } from "../client/authn/install-state.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import {
  getChallengeStoreProvider,
  getDaemonCellRegistry,
  getDb,
} from "../db.ts";
import {
  onMonitorMessageApplied,
  projectIdentityIfChanged,
} from "./cell/control-plane-monitor.ts";
import { parseMonitorMessage } from "./cell/monitor-contracts.ts";
import { wireMessageToInboundEnvelope } from "./cell/protocol.ts";
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
  touchDaemonKeyLastUsedAndLastSeen,
} from "./authn/server-identity-db.ts";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  verifyDaemonSignature,
} from "./authn/server-key.ts";
import { type DaemonChallengeStore } from "./cell/challenge-store.ts";

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
    challengeStoreProvider?: {
      enroll: DaemonChallengeStore;
      auth: DaemonChallengeStore;
    };
  } = {},
) {
  const daemon = new Hono();
  const { secrets } = options;
  const fallbackChallengeStores = options.challengeStoreProvider;

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

      const { auth: authChallengeStore } = getChallengeStoreProvider(
        c,
        fallbackChallengeStores,
      );
      const challenge = await authChallengeStore.issue({ serverId, keyId });
      return c.json({
        challengeId: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
        expiresAt: challengeExpiresAt(challenge.at, authChallengeStore.ttlMs),
      }, 200);
    }

    const { enroll: enrollChallengeStore } = getChallengeStoreProvider(
      c,
      fallbackChallengeStores,
    );
    const challenge = await enrollChallengeStore.issue();
    return c.json({
      challengeId: challenge.id,
      nonce: challenge.nonce,
      at: challenge.at,
      expiresAt: challengeExpiresAt(challenge.at, enrollChallengeStore.ttlMs),
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

    const { enroll: enrollChallengeStore } = getChallengeStoreProvider(
      c,
      fallbackChallengeStores,
    );
    const challenge = await enrollChallengeStore.consume({ challengeId });
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

    const { auth: authChallengeStore } = getChallengeStoreProvider(
      c,
      fallbackChallengeStores,
    );
    const challenge = await authChallengeStore.consume({
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

    void touchDaemonKeyLastUsedAndLastSeen(db, serverId).catch((err) => {
      console.warn("failed to touch daemon server key", err);
    });
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

  daemon.post("/heartbeat", requireDaemonJwt, async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }

    const serverId = (c as Context<any>).get("daemonServerId") as
      | string
      | undefined;
    if (!serverId) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    const body = await c.req
      .json<{ hostname?: string; monitor?: unknown }>()
      .catch(() => ({} as { hostname?: string; monitor?: unknown }));
    const hostname = typeof body.hostname === "string"
      ? body.hostname.trim()
      : undefined;
    const at = new Date().toISOString();

    const registry = getDaemonCellRegistry(c);
    let acceptedSequence = 0;
    let resyncNeeded = false;

    if (registry) {
      const cell = registry.getCell(serverId);
      await cell.heartbeat({ hostname, at });

      if (hostname) {
        await projectIdentityIfChanged(db, serverId, cell);
      }

      const monitorMessage = body.monitor != null
        ? parseMonitorMessage(body.monitor)
        : null;
      if (monitorMessage?.from === "daemon") {
        const envelope = wireMessageToInboundEnvelope(monitorMessage);
        if (envelope?.kind === "monitor-sync") {
          const result = await cell.applyMonitorSync(envelope);
          acceptedSequence = result.acceptedSequence;
          resyncNeeded = result.resyncNeeded;
          if (!result.resyncNeeded) {
            await onMonitorMessageApplied(
              db,
              serverId,
              cell,
              "monitor-sync",
              envelope,
            );
          }
        } else if (envelope?.kind === "monitor-heartbeat") {
          const result = await cell.applyMonitorHeartbeat(envelope);
          acceptedSequence = result.acceptedSequence;
          resyncNeeded = result.resyncNeeded;
          if (!result.resyncNeeded) {
            await onMonitorMessageApplied(
              db,
              serverId,
              cell,
              "monitor-heartbeat",
              envelope,
            );
          }
        }
      }
    }

    return c.json({
      acceptedSequence,
      resyncNeeded: resyncNeeded || undefined,
    });
  });

  daemon.post("/commands/lease", requireDaemonJwt, (c) => {
    return c.json({ commands: [] }, 200);
  });

  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
