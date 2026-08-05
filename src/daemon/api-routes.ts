import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { isInstanceInstalled } from "../client/authn/install-state.ts";
import { lookupActiveLicense } from "../client/authn/license.ts";
import type {
  DerivedSecretsConfig,
  SecretsConfig,
} from "../client/authn/secrets.ts";
import type { DaemonJwtKeyring } from "./authn/daemon-jwt-keyring.ts";
import { buildJwksDocument } from "./authn/daemon-jwt-keyring.ts";
import {
  decryptSecretForDaemon,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
} from "../client/authn/data-encryption.ts";
import type { Db } from "../db.ts";
import { getDb, getServerMetricsStore } from "../db.ts";
import { license } from "../lib/db/schema.ts";
import {
  MAX_METRICS_PAYLOAD_BYTES,
  metricsPayloadByteLength,
  rateLimitedMetricsLog,
  validateHostMetricsSample,
} from "./metrics/validation.ts";
import {
  createStatelessChallengeStore,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
} from "./cell/stateless-challenge.ts";
import { getDaemonOpenApiSpec } from "./openapi/index.ts";
import { buildDaemonScalarHtml } from "../scalar-html.ts";
import { resolveInstanceTlsCaPath } from "../server-paths.ts";
import { DAEMON_API_PREFIX } from "../surfaces.ts";
import { normalizeMachineKey } from "../lib/machine-key.ts";
import { resolveServerId, touchServerMetadata } from "../server-registry.ts";
import { verifyDaemonLicense } from "./authn/license.ts";
import { issueDaemonJwt, verifyDaemonJwt } from "./authn/daemon-jwt.ts";
import type { ServerDaemonStateWithMetadata } from "./authn/server-identity-db.ts";
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
  daemonMetricsRateLimitKey,
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

/**
 * Read a request body while enforcing a hard byte budget, aborting the stream
 * as soon as the budget is exceeded so an oversized upload is never fully
 * buffered. Returns `{ ok: false }` when the limit is exceeded.
 */
async function readRequestBodyWithLimit(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const stream = c.req.raw.body;
  if (!stream) {
    return { ok: true, text: "" };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/** Maximum number of ciphertexts accepted per `/secrets/decrypt` request. */
export const MAX_SECRETS_DECRYPT_BATCH = 100;

/**
 * Per-ciphertext character budget. A daemon envelope carrying a single TLS
 * private key base64url-encodes to a few KiB; 16 KiB leaves generous headroom
 * while rejecting pathological inputs.
 */
export const MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS = 16 * 1024;

/**
 * Whole-request byte budget, read (and aborted) before JSON parsing. Sized as
 * the batch cap × per-ciphertext cap plus JSON array/quoting overhead.
 */
export const MAX_SECRETS_DECRYPT_BODY_BYTES = 2 * 1024 * 1024;

/** `POST /auth/challenge` — optional serverId/keyId only. */
export const MAX_AUTH_CHALLENGE_BODY_BYTES = 4 * 1024;

/** `POST /enroll` — includes publicJwk + license fields. */
export const MAX_ENROLL_BODY_BYTES = 32 * 1024;

/** `POST /auth/session` — signed session proof fields. */
export const MAX_AUTH_SESSION_BODY_BYTES = 8 * 1024;

/**
 * Reject when `Content-Length` declares a body larger than `maxBytes`.
 * Returns a 413 response, or `null` when the header is absent/ok.
 */
function rejectIfContentLengthTooLarge(
  c: Context,
  maxBytes: number,
): Response | null {
  const declaredLength = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return c.json({ ok: false, error: "request body too large" }, 413);
  }
  return null;
}

/**
 * Content-Length precheck + streaming byte budget. Returns the body text or a
 * 413 Response when the upload exceeds `maxBytes`.
 */
async function readBoundedJsonBody(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const tooLarge = rejectIfContentLengthTooLarge(c, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };
  const bodyRead = await readRequestBodyWithLimit(c, maxBytes);
  if (!bodyRead.ok) {
    return {
      ok: false,
      response: c.json({ ok: false, error: "request body too large" }, 413),
    };
  }
  return { ok: true, text: bodyRead.text };
}

/**
 * Decrypt a single recipient-bound daemon envelope. Returns the plaintext, or
 * `null` when the value is not a daemon envelope, is not addressed to this
 * recipient, or fails to decrypt. Never throws.
 */
async function decryptDaemonCiphertext(
  secretsConfig: SecretsConfig,
  recipient: { serverId: string; keyId: string },
  ciphertext: string,
): Promise<string | null> {
  try {
    if (!isDaemonSealedEnvelope(ciphertext)) {
      return null;
    }
    const parsed = parseDaemonSecretEnvelope(ciphertext);
    if (!parsed) {
      return null;
    }
    if (
      parsed.serverId !== recipient.serverId ||
      parsed.keyId !== recipient.keyId
    ) {
      return null;
    }
    return await decryptSecretForDaemon(secretsConfig, recipient, ciphertext);
  } catch {
    return null;
  }
}

function challengeExpiresAt(at: string, ttlMs: number): string {
  const atMs = new Date(at).getTime();
  if (!Number.isFinite(atMs)) {
    return new Date(Date.now() + ttlMs).toISOString();
  }
  return new Date(atMs + ttlMs).toISOString();
}

/** Shared shape for helpers that either succeed with a value or fail with an HTTP status + message. */
type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 401; error: string };

/** Normalizes `body.machineKey`, distinguishing "absent" from "present but invalid". */
function parseOptionalMachineKey(
  machineKeyRaw: string | null,
): FieldResult<string | undefined> {
  if (machineKeyRaw === null) {
    return { ok: true, value: undefined };
  }
  const machineKey = normalizeMachineKey(machineKeyRaw);
  if (machineKey === undefined) {
    return { ok: false, status: 400, error: "Invalid machineKey" };
  }
  return { ok: true, value: machineKey };
}

type EnrollFields = {
  licenseId: string;
  licenseToken: string;
  hostname: string;
  challengeId: string;
  signature: string;
  publicJwk: JsonWebKey;
  machineKey: string | undefined;
  serverIdBody: string | undefined;
};

/** Parses and validates the `POST /enroll` body, keeping every field check in one place. */
function parseEnrollFields(
  body: Record<string, unknown>,
): FieldResult<EnrollFields> {
  const licenseId = normalizeRequiredString(body.licenseId);
  const licenseToken = normalizeRequiredString(body.licenseToken);
  const machineKeyRaw = normalizeRequiredString(body.machineKey);
  const hostname = normalizeRequiredString(body.hostname);
  const challengeId = normalizeRequiredString(body.challengeId);
  const signature = normalizeRequiredString(body.signature);
  const publicJwk = isObjectRecord(body.publicJwk)
    ? body.publicJwk as JsonWebKey
    : null;

  // Keep malformed or omitted auth credentials on the same unauthorized path.
  if (!licenseId || !licenseToken) {
    return { ok: false, status: 401, error: "Invalid license" };
  }
  if (!hostname || !challengeId || !signature || !publicJwk) {
    return { ok: false, status: 400, error: "Missing required enroll fields" };
  }
  const machineKeyResult = parseOptionalMachineKey(machineKeyRaw);
  if (!machineKeyResult.ok) return machineKeyResult;

  return {
    ok: true,
    value: {
      licenseId,
      licenseToken,
      hostname,
      challengeId,
      signature,
      publicJwk,
      machineKey: machineKeyResult.value,
      serverIdBody: normalizeRequiredString(body.serverId) ?? undefined,
    },
  };
}

/**
 * Resolves the server row, guards against a fingerprint collision, and attaches
 * the daemon key — the final leg of `POST /enroll` once the signature is verified.
 */
async function finalizeDaemonEnrollment(
  db: Db,
  params: {
    serverIdBody: string | undefined;
    machineKey: string | undefined;
    hostname: string;
    licenseId: string;
    licenseToken: string;
    fingerprint: string;
    publicJwk: JsonWebKey;
  },
): Promise<
  | { ok: true; serverId: string; keyId: string }
  | { ok: false; status: 400 | 409 | 500; error: string }
> {
  const {
    serverIdBody,
    machineKey,
    hostname,
    licenseId,
    licenseToken,
    fingerprint,
    publicJwk,
  } = params;

  const serverId = await resolveServerId(db, {
    serverId: serverIdBody,
    machineKey,
    hostname,
    licenseId,
    licenseToken,
  });
  if (!serverId) {
    return {
      ok: false,
      status: 400,
      error: "License already consumed or invalid",
    };
  }

  const existing = await getServerDaemonStateByFingerprint(db, fingerprint);
  if (existing && existing.serverId !== serverId) {
    return { ok: false, status: 409, error: "Fingerprint already exists" };
  }

  try {
    const result = await attachDaemonStateToServer(db, serverId, {
      publicJwk,
      fingerprint,
      hostname,
      machineKey,
    });
    return { ok: true, serverId, keyId: result.keyId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
}

type AuthSessionFields = {
  serverId: string;
  keyId: string;
  challengeId: string;
  signature: string;
  hostname: string;
  machineKey: string | undefined;
};

/** Parses and validates the `POST /auth/session` body, keeping every field check in one place. */
function parseAuthSessionFields(
  body: Record<string, unknown>,
): FieldResult<AuthSessionFields> {
  const serverId = normalizeRequiredString(body.serverId);
  const keyId = normalizeRequiredString(body.keyId);
  const challengeId = normalizeRequiredString(body.challengeId);
  const signature = normalizeRequiredString(body.signature);
  const hostname = normalizeRequiredString(body.hostname);
  const machineKeyRaw = normalizeRequiredString(body.machineKey);

  if (!serverId || !keyId || !challengeId || !signature || !hostname) {
    return {
      ok: false,
      status: 400,
      error: "Missing required session fields",
    };
  }
  const machineKeyResult = parseOptionalMachineKey(machineKeyRaw);
  if (!machineKeyResult.ok) return machineKeyResult;

  return {
    ok: true,
    value: {
      serverId,
      keyId,
      challengeId,
      signature,
      hostname,
      machineKey: machineKeyResult.value,
    },
  };
}

/** Loads the server's daemon key and confirms it matches `keyId` and is active. */
async function loadActiveDaemonKeyState(
  db: Db,
  serverId: string,
  keyId: string,
): Promise<
  | { ok: true; daemonState: ServerDaemonStateWithMetadata }
  | { ok: false; status: 400 | 404; error: string }
> {
  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState) {
    return { ok: false, status: 404, error: "Server key not found" };
  }
  if (daemonState.key.id !== keyId) {
    return { ok: false, status: 400, error: "Server key mismatch" };
  }
  if (!isDaemonKeyActive(daemonState.key)) {
    return { ok: false, status: 400, error: "Server key is inactive" };
  }
  return { ok: true, daemonState };
}

/** Confirms the server's license (if any) is still active. */
async function checkServerLicenseActive(
  db: Db,
  serverId: string,
): Promise<{ ok: true } | { ok: false; status: 400; error: string }> {
  const [licenseRow] = await db
    .select({ licenseId: license.id })
    .from(license)
    .where(eq(license.serverId, serverId))
    .limit(1);
  if (licenseRow?.licenseId) {
    const activeLicense = await lookupActiveLicense(db, licenseRow.licenseId);
    if (!activeLicense) {
      return { ok: false, status: 400, error: "License is inactive" };
    }
  }
  return { ok: true };
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
    metricsLimiter?: RateLimiter;
  } = {},
) {
  const daemon = new Hono();
  const { secrets, challengeSigningSecrets, secretsConfig } = options;
  const restLimiter = options.restLimiter ?? createNoopRateLimiter();
  const metricsLimiter = options.metricsLimiter ?? createNoopRateLimiter();
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

  async function enforceDaemonMetricsLimit(
    c: Context,
    serverId: string,
  ): Promise<Response | null> {
    const { success } = await metricsLimiter.limit({
      key: daemonMetricsRateLimitKey(serverId),
    });
    if (!success) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    return null;
  }

  /** Auth-challenge path when the daemon already has serverId + keyId. */
  async function issueServerKeyAuthChallenge(
    c: Context,
    serverIdRaw: string | undefined,
    keyIdRaw: string | undefined,
  ): Promise<Response> {
    const serverId = serverIdRaw?.trim();
    const keyId = keyIdRaw?.trim();
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

    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: keyState.error }, keyState.status);
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

  /**
   * Reject JWTs whose sub/kid no longer match an active daemon key (e.g. after
   * license invalidation). Applied to cost-sensitive routes after JWT verify
   * and rate limiting so limiter tests can still exercise 429 without a DB.
   * When no DB is bound (unit tests), JWT signature/expiry alone gate the route.
   */
  const requireActiveDaemonKey = async (c: Context, next: Next) => {
    const db = getDb(c);
    if (db === undefined) {
      return next();
    }
    const serverId = c.get("daemonServerId") as string;
    const keyId = c.get("daemonKeyId") as string;
    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
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
    const lengthReject = rejectIfContentLengthTooLarge(
      c,
      MAX_AUTH_CHALLENGE_BODY_BYTES,
    );
    if (lengthReject) return lengthReject;

    // Anonymous enrollment challenges have empty/near-empty bodies — rate-limit
    // before reading so an oversized flood still hits the enroll-challenge bucket.
    const declaredLength = Number(c.req.header("content-length") ?? "");
    const bodyAbsent = !c.req.raw.body;
    const looksAnonymous = bodyAbsent ||
      (Number.isFinite(declaredLength) && declaredLength <= 2);
    if (looksAnonymous) {
      const enrollChallengeLimited = await enforceDaemonRestLimit(
        c,
        daemonEnrollChallengeRateLimitKey(),
      );
      if (enrollChallengeLimited) return enrollChallengeLimited;
    }

    const bodyRead = await readBoundedJsonBody(c, MAX_AUTH_CHALLENGE_BODY_BYTES);
    if (!bodyRead.ok) return bodyRead.response;

    let body: { serverId?: string; keyId?: string } = {};
    if (bodyRead.text.trim()) {
      try {
        body = JSON.parse(bodyRead.text) as {
          serverId?: string;
          keyId?: string;
        };
      } catch {
        body = {};
      }
    }

    if (body.keyId || body.serverId) {
      return issueServerKeyAuthChallenge(c, body.serverId, body.keyId);
    }

    if (!looksAnonymous) {
      const enrollChallengeLimited = await enforceDaemonRestLimit(
        c,
        daemonEnrollChallengeRateLimitKey(),
      );
      if (enrollChallengeLimited) return enrollChallengeLimited;
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

    const bodyRead = await readBoundedJsonBody(c, MAX_ENROLL_BODY_BYTES);
    if (!bodyRead.ok) return bodyRead.response;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyRead.text || "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const parsedFields = parseEnrollFields(body);
    if (!parsedFields.ok) {
      return c.json(
        { ok: false, error: parsedFields.error },
        parsedFields.status,
      );
    }
    const {
      licenseId,
      licenseToken,
      hostname,
      challengeId,
      signature,
      publicJwk,
      machineKey,
      serverIdBody,
    } = parsedFields.value;

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
      machineKey: machineKey ?? "",
      hostname,
      publicKeyFingerprint: fingerprint,
    });
    const verified = await verifyDaemonSignature(publicJwk, payload, signature);
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    const enrolled = await finalizeDaemonEnrollment(db, {
      serverIdBody,
      machineKey,
      hostname,
      licenseId,
      licenseToken,
      fingerprint,
      publicJwk,
    });
    if (!enrolled.ok) {
      return c.json({ ok: false, error: enrolled.error }, enrolled.status);
    }

    return c.json({ serverId: enrolled.serverId, keyId: enrolled.keyId }, 200);
  });

  daemon.post("/auth/session", async (c) => {
    const db = getDb(c);
    if (db === undefined) {
      return c.json({ ok: false, error: "Database unavailable" }, 503);
    }
    if (!secrets) {
      return c.json({ ok: false, error: "Daemon auth unavailable" }, 503);
    }

    const bodyRead = await readBoundedJsonBody(c, MAX_AUTH_SESSION_BODY_BYTES);
    if (!bodyRead.ok) return bodyRead.response;

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyRead.text || "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    const parsedFields = parseAuthSessionFields(body);
    if (!parsedFields.ok) {
      return c.json(
        { ok: false, error: parsedFields.error },
        parsedFields.status,
      );
    }
    const { serverId, keyId, challengeId, signature, hostname, machineKey } =
      parsedFields.value;

    const sessionLimited = await enforceDaemonRestLimit(
      c,
      daemonRestRateLimitKey(serverId, "auth-session"),
    );
    if (sessionLimited) return sessionLimited;

    const keyState = await loadActiveDaemonKeyState(db, serverId, keyId);
    if (!keyState.ok) {
      return c.json({ ok: false, error: keyState.error }, keyState.status);
    }

    const licenseState = await checkServerLicenseActive(db, serverId);
    if (!licenseState.ok) {
      return c.json(
        { ok: false, error: licenseState.error },
        licenseState.status,
      );
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
      machineKey: machineKey ?? "",
      hostname,
    });
    const verified = await verifyDaemonSignature(
      keyState.daemonState.key.publicJwk,
      payload,
      signature,
    );
    if (!verified) {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    await touchDaemonKeyLastUsed(db, serverId);
    await touchServerMetadata(db, serverId, { machineKey, hostname });

    const issued = await issueDaemonJwt(
      { sub: serverId, kid: keyId },
      secrets,
    );
    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
    }, 200);
  });

  const enforceJwtRestLimit =
    (route: DaemonRestRateLimitRoute) => async (c: Context, next: Next) => {
      const daemonServerId = c.get("daemonServerId") as string;
      const limited = await enforceDaemonRestLimit(
        c,
        daemonRestRateLimitKey(daemonServerId, route),
      );
      if (limited) return limited;
      return next();
    };

  const enforceJwtMetricsLimit = async (c: Context, next: Next) => {
    const daemonServerId = c.get("daemonServerId") as string;
    const limited = await enforceDaemonMetricsLimit(c, daemonServerId);
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

  // Must never call env.DAEMON_CELL.getByName or touch the Durable Object —
  // metrics writes go straight to the Analytics Engine / ClickHouse store.
  daemon.post(
    "/metrics",
    requireDaemonJwt,
    enforceJwtMetricsLimit,
    requireActiveDaemonKey,
    async (c) => {
      const serverId = c.get("daemonServerId") as string;

      const lengthReject = rejectIfContentLengthTooLarge(
        c,
        MAX_METRICS_PAYLOAD_BYTES,
      );
      if (lengthReject) return lengthReject;

      const bodyRead = await readRequestBodyWithLimit(
        c,
        MAX_METRICS_PAYLOAD_BYTES,
      );
      if (!bodyRead.ok) {
        return c.json({ ok: false, error: "request body too large" }, 413);
      }
      const raw = bodyRead.text;
      const payloadBytes = metricsPayloadByteLength(raw);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rateLimitedMetricsLog(serverId, "invalid metrics payload", (reason) => {
          console.warn(
            `metrics ignored invalid sample from ${serverId}: ${reason}`,
          );
        });
        return c.json({ ok: false, error: "invalid metrics payload" }, 400);
      }

      const result = validateHostMetricsSample(parsed, {
        serverId,
        receivedAt: new Date().toISOString(),
        payloadBytes,
      });
      if (!result.ok) {
        rateLimitedMetricsLog(serverId, result.reason, (reason) => {
          console.warn(
            `metrics ignored invalid sample from ${serverId}: ${reason}`,
          );
        });
        return c.json({ ok: false, error: result.reason }, 400);
      }

      const store = getServerMetricsStore(c);
      const logWriteFailed = (err: unknown) => {
        rateLimitedMetricsLog(serverId, "write_failed", () => {
          console.warn(
            `metrics write failed for ${serverId}: ${String(err)}`,
          );
        });
      };
      try {
        // Await queueing so chart queries that flush pending rows can see
        // this sample; still return 202 without waiting on ClickHouse I/O
        // beyond schema/batch thresholds inside writeHostSample.
        if (store) {
          await store.writeHostSample(result.sample);
        }
      } catch (err) {
        logWriteFailed(err);
      }

      return c.json({ ok: true }, 202);
    },
  );

  // Recipient-bound daemon envelopes only — JWT sub/kid must match envelope metadata.
  daemon.post(
    "/secrets/decrypt",
    requireDaemonJwt,
    enforceJwtRestLimit("secrets-decrypt"),
    requireActiveDaemonKey,
    async (c) => {
      if (!secretsConfig) {
        return c.json({ ok: false, error: "decryption unavailable" }, 503);
      }

      const daemonServerId = c.get("daemonServerId") as string;
      const daemonKeyId = c.get("daemonKeyId") as string;

      const bodyRead = await readBoundedJsonBody(
        c,
        MAX_SECRETS_DECRYPT_BODY_BYTES,
      );
      if (!bodyRead.ok) return bodyRead.response;

      let body: { ciphertexts?: unknown };
      try {
        body = JSON.parse(bodyRead.text) as { ciphertexts?: unknown };
      } catch {
        return c.json({ ok: false, error: "invalid json" }, 400);
      }

      if (!Array.isArray(body.ciphertexts)) {
        return c.json(
          { ok: false, error: "ciphertexts must be an array" },
          400,
        );
      }
      if (
        body.ciphertexts.length === 0 ||
        body.ciphertexts.length > MAX_SECRETS_DECRYPT_BATCH
      ) {
        return c.json(
          {
            ok: false,
            error: `ciphertexts length must be 1-${MAX_SECRETS_DECRYPT_BATCH}`,
          },
          400,
        );
      }
      for (const entry of body.ciphertexts) {
        if (typeof entry !== "string") {
          return c.json(
            { ok: false, error: "ciphertexts must be strings" },
            400,
          );
        }
        if (entry.length > MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS) {
          return c.json(
            {
              ok: false,
              error:
                `ciphertext exceeds ${MAX_SECRETS_DECRYPT_CIPHERTEXT_CHARS} chars`,
            },
            400,
          );
        }
      }

      const recipient = { serverId: daemonServerId, keyId: daemonKeyId };

      // Sequential decryption — bounded work, no unbounded parallelism over the
      // whole batch (each entry does an AES-GCM decrypt of daemon key material).
      const plaintexts: (string | null)[] = [];
      for (const ciphertext of body.ciphertexts as string[]) {
        plaintexts.push(
          await decryptDaemonCiphertext(
            secretsConfig,
            recipient,
            ciphertext,
          ),
        );
      }

      return c.json({ plaintexts }, 200);
    },
  );

  app.route(DAEMON_API_PREFIX, daemon);
  return app;
}
