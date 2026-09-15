import { and, eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { isExplicitDevelopmentMode } from "../../dev-mode.ts";
import { passkey, user, verification } from "../../lib/db/schema.ts";
import {
  ENVELOPE_SCHEME_WEBAUTHN,
  formatEnvelope,
  parseEnvelope,
} from "./envelope.ts";
import { type DerivedSecretsConfig, findKeyForVersion } from "./secrets.ts";
import {
  aaguidToUuid,
  AUTH_DATA_FLAG_UP,
  AUTH_DATA_FLAG_UV,
  base64urlDecode,
  base64urlEncode,
  bytesToUuid,
  coseKeyToJwk,
  type CosePublicJwk,
  parseAttestationObject,
  parseAuthenticatorData,
  uuidToBytes,
  verifyAssertion,
  verifyRpIdHash,
} from "./webauthn.ts";

export const WEBAUTHN_CHALLENGE_PURPOSE = "webauthn-challenge";
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const WEBAUTHN_CHALLENGE_BYTES = 32;
const RP_NAME = "TurboPanel";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class PasskeyExistsError extends Error {
  readonly code = "passkey_exists";
  constructor() {
    super("passkey_exists");
    this.name = "PasskeyExistsError";
  }
}

export class InvalidPasskeyCeremonyError extends Error {
  constructor(message = "invalid_passkey") {
    super(message);
    this.name = "InvalidPasskeyCeremonyError";
  }
}

export function requireWebauthnChallengeSecrets(
  secrets: DerivedSecretsConfig | undefined,
): DerivedSecretsConfig {
  if (secrets) return secrets;
  if (isExplicitDevelopmentMode()) {
    throw new Error(
      "WebAuthn challenge secrets are required in development — deriveSecretsConfig with purpose webauthn-challenge",
    );
  }
  throw new Error(
    "WebAuthn challenge secrets are required (deriveSecretsConfig with purpose webauthn-challenge)",
  );
}

type WebauthnChallengePayload = {
  challenge: string;
  userId: string | null;
  exp: number;
};

function mintChallenge(): string {
  const bytes = new Uint8Array(WEBAUTHN_CHALLENGE_BYTES);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/**
 * Sign a WebAuthn ceremony challenge as `tpwebauthn.v<n>.<payload>.<sig>`.
 * `opts.challenge` reuses bytes already placed in PublicKeyCredential options;
 * omitted, 32 fresh random bytes are minted.
 */
export async function signWebauthnChallenge(
  secrets: DerivedSecretsConfig,
  opts: { userId?: string; challenge?: string } = {},
  nowMs: number = Date.now(),
): Promise<{ envelope: string; challenge: string }> {
  const keyring = requireWebauthnChallengeSecrets(secrets);
  const challenge = opts.challenge ?? mintChallenge();
  const payload: WebauthnChallengePayload = {
    challenge,
    userId: opts.userId ?? null,
    exp: Math.floor((nowMs + WEBAUTHN_CHALLENGE_TTL_MS) / 1000),
  };
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    keyring.current.key,
    textEncoder.encode(encodedPayload),
  );
  return {
    envelope: formatEnvelope(
      ENVELOPE_SCHEME_WEBAUTHN,
      keyring.current.version,
      encodedPayload,
      base64urlEncode(new Uint8Array(signature)),
    ),
    challenge,
  };
}

function decodeChallengePayload(
  encodedPayload: string,
  encodedSignature: string,
): { signature: Uint8Array; payload: WebauthnChallengePayload } | null {
  try {
    const payload = JSON.parse(
      textDecoder.decode(base64urlDecode(encodedPayload)),
    ) as WebauthnChallengePayload;
    return { signature: base64urlDecode(encodedSignature), payload };
  } catch {
    return null;
  }
}

function payloadUserId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  return value;
}

export async function verifyWebauthnChallenge(
  secrets: DerivedSecretsConfig,
  envelope: string,
  nowMs: number = Date.now(),
): Promise<
  { challenge: string; userId: string | null } | "invalid" | "expired"
> {
  const keyring = requireWebauthnChallengeSecrets(secrets);
  const parsed = parseEnvelope(ENVELOPE_SCHEME_WEBAUTHN, envelope, 2);
  if (!parsed) return "invalid";

  const key = findKeyForVersion(keyring, parsed.version);
  if (!key) return "invalid";

  const [encodedPayload, encodedSignature] = parsed.fields;
  const decoded = decodeChallengePayload(encodedPayload!, encodedSignature!);
  if (!decoded) return "invalid";

  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    decoded.signature as BufferSource,
    textEncoder.encode(encodedPayload!),
  );
  if (!verified) return "invalid";
  if (typeof decoded.payload.challenge !== "string") return "invalid";
  if (decoded.payload.challenge.length === 0) return "invalid";
  if (typeof decoded.payload.exp !== "number") return "invalid";
  const userId = payloadUserId(decoded.payload.userId);
  if (decoded.payload.userId !== null && decoded.payload.userId !== undefined) {
    if (userId === null || userId.length === 0) return "invalid";
  }
  if (decoded.payload.exp * 1000 <= nowMs) {
    return "expired";
  }
  return { challenge: decoded.payload.challenge, userId };
}

export type PasskeyCreationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ alg: number; type: "public-key" }>;
  authenticatorSelection: {
    residentKey: "required";
    userVerification: "required";
  };
  challenge: string;
  excludeCredentials: Array<{ id: string; type: "public-key" }>;
  timeout: number;
};

export type PasskeyRequestOptions = {
  challenge: string;
  rpId: string;
  userVerification: "required";
  timeout: number;
};

export async function buildPasskeyRegistrationOptions(
  db: Db,
  params: { userId: string; email: string; rpId: string; challenge: string },
): Promise<{ challenge: string; options: PasskeyCreationOptions }> {
  const existing = await db
    .select({ credentialId: passkey.credentialId })
    .from(passkey)
    .where(eq(passkey.userId, params.userId));

  const excludeCredentials = existing.map((row) => ({
    id: row.credentialId,
    type: "public-key" as const,
  }));

  const options: PasskeyCreationOptions = {
    rp: { id: params.rpId, name: RP_NAME },
    user: {
      id: base64urlEncode(uuidToBytes(params.userId)),
      name: params.email,
      displayName: params.email,
    },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" },
      { alg: -257, type: "public-key" },
    ],
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    challenge: params.challenge,
    excludeCredentials,
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  };
  return { challenge: params.challenge, options };
}

export async function buildPasskeyLoginOptions(
  webauthnChallengeSecrets: DerivedSecretsConfig,
  params: { rpId: string },
  nowMs?: number,
): Promise<{ challenge: string; options: PasskeyRequestOptions }> {
  const signed = await signWebauthnChallenge(
    webauthnChallengeSecrets,
    {},
    nowMs,
  );
  return {
    challenge: signed.envelope,
    options: {
      challenge: signed.challenge,
      rpId: params.rpId,
      userVerification: "required",
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    },
  };
}

type ClientData = {
  type: string;
  challenge: string;
  origin: string;
};

function parseClientDataJson(encoded: string): ClientData {
  const json = JSON.parse(textDecoder.decode(base64urlDecode(encoded)));
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new InvalidPasskeyCeremonyError();
  }
  const record = json as Record<string, unknown>;
  if (typeof record.type !== "string") throw new InvalidPasskeyCeremonyError();
  if (typeof record.challenge !== "string") {
    throw new InvalidPasskeyCeremonyError();
  }
  if (typeof record.origin !== "string") {
    throw new InvalidPasskeyCeremonyError();
  }
  return {
    type: record.type,
    challenge: record.challenge,
    origin: record.origin,
  };
}

function challengesEqual(left: string, right: string): boolean {
  const strip = (value: string) => value.replaceAll("=", "");
  return strip(left) === strip(right);
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    "code" in err && (err as { code: string }).code === "23505";
}

export type PasskeyCredentialAttestation = {
  id?: unknown;
  rawId?: unknown;
  response?: {
    clientDataJSON?: unknown;
    attestationObject?: unknown;
    transports?: unknown;
  };
  transports?: unknown;
};

function readEncodedBytes(
  value: unknown,
  fallback?: unknown,
): Uint8Array | null {
  let candidate: string | null = null;
  if (typeof value === "string") {
    candidate = value;
  } else if (typeof fallback === "string") {
    candidate = fallback;
  }
  if (candidate === null || candidate.length === 0) return null;
  try {
    return base64urlDecode(candidate);
  } catch {
    return null;
  }
}

function readEncodedString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function parseTransports(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const transports = value.filter((entry): entry is string =>
    typeof entry === "string"
  );
  if (transports.length === 0) return null;
  return JSON.stringify(transports);
}

function requireFlags(
  flags: number,
  mask: number,
): void {
  if ((flags & mask) !== mask) {
    throw new InvalidPasskeyCeremonyError();
  }
}

export async function verifyPasskeyRegistration(
  db: Db,
  params: {
    userId: string;
    challengeEnvelope: string;
    name: string;
    credential: PasskeyCredentialAttestation;
    webauthnChallengeSecrets: DerivedSecretsConfig;
    expectedRpId: string;
    expectedOrigin: string;
  },
): Promise<{ id: string }> {
  const claims = await verifyWebauthnChallenge(
    params.webauthnChallengeSecrets,
    params.challengeEnvelope,
  );
  if (claims === "invalid" || claims === "expired") {
    throw new InvalidPasskeyCeremonyError();
  }
  if (claims.userId !== params.userId) {
    throw new InvalidPasskeyCeremonyError();
  }

  const clientDataJSON = readEncodedString(
    params.credential.response?.clientDataJSON,
  );
  const attestationObject = readEncodedString(
    params.credential.response?.attestationObject,
  );
  if (!clientDataJSON || !attestationObject) {
    throw new InvalidPasskeyCeremonyError();
  }

  const clientData = parseClientDataJson(clientDataJSON);
  if (clientData.type !== "webauthn.create") {
    throw new InvalidPasskeyCeremonyError();
  }
  if (!challengesEqual(clientData.challenge, claims.challenge)) {
    throw new InvalidPasskeyCeremonyError();
  }
  if (clientData.origin !== params.expectedOrigin) {
    throw new InvalidPasskeyCeremonyError();
  }

  const attestation = parseAttestationObject(
    base64urlDecode(attestationObject),
  );
  const authData = parseAuthenticatorData(attestation.authData);
  if (!await verifyRpIdHash(attestation.authData, params.expectedRpId)) {
    throw new InvalidPasskeyCeremonyError();
  }
  requireFlags(authData.flags, AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV);
  if (!authData.attested) {
    throw new InvalidPasskeyCeremonyError();
  }

  const jwk = coseKeyToJwk(authData.attested.coseKeyBytes);
  const credentialId = base64urlEncode(authData.attested.credentialId);
  const deviceType = authData.backupEligible ? "multiDevice" : "singleDevice";
  const transports = parseTransports(
    params.credential.response?.transports ?? params.credential.transports,
  );

  try {
    const inserted = await db
      .insert(passkey)
      .values({
        userId: params.userId,
        aaguid: aaguidToUuid(authData.attested.aaguid),
        name: params.name,
        publicKey: JSON.stringify(jwk),
        credentialId,
        counter: authData.counter,
        deviceType,
        isBackedUp: authData.backupState,
        transports,
      })
      .returning({ id: passkey.id });
    const id = inserted[0]?.id;
    if (!id) {
      throw new Error("Passkey insert failed");
    }
    return { id };
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      throw new PasskeyExistsError();
    }
    throw err;
  }
}

export type PasskeySummary = {
  id: string;
  name: string | null;
  createdAt: string;
  deviceType: string;
  isBackedUp: boolean;
};

export async function listPasskeys(
  db: Db,
  userId: string,
): Promise<{ passkeys: PasskeySummary[] }> {
  const rows = await db
    .select({
      id: passkey.id,
      name: passkey.name,
      createdAt: passkey.createdAt,
      deviceType: passkey.deviceType,
      isBackedUp: passkey.isBackedUp,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId));

  const passkeys = rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      deviceType: row.deviceType,
      isBackedUp: row.isBackedUp,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { passkeys };
}

export async function deletePasskey(
  db: Db,
  userId: string,
  passkeyId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(passkey)
    .where(and(eq(passkey.id, passkeyId), eq(passkey.userId, userId)))
    .returning({ id: passkey.id });
  return deleted.length > 0;
}

export type PasskeyCredentialAssertion = {
  id?: unknown;
  rawId?: unknown;
  response?: {
    clientDataJSON?: unknown;
    authenticatorData?: unknown;
    signature?: unknown;
    userHandle?: unknown;
  };
};

function parseStoredJwk(raw: string): CosePublicJwk | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kty === "EC" && record.crv === "P-256") {
      if (typeof record.x !== "string" || typeof record.y !== "string") {
        return null;
      }
      return { kty: "EC", crv: "P-256", x: record.x, y: record.y };
    }
    if (record.kty === "RSA") {
      if (typeof record.n !== "string" || typeof record.e !== "string") {
        return null;
      }
      return { kty: "RSA", n: record.n, e: record.e, alg: "RS256" };
    }
    return null;
  } catch {
    return null;
  }
}

function userHandleMatches(
  userHandle: string | null,
  userId: string,
): boolean {
  if (!userHandle) return false;
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(userHandle);
  } catch {
    return false;
  }
  const asUuid = bytesToUuid(bytes);
  if (asUuid === userId) return true;
  return textDecoder.decode(bytes) === userId;
}

function credentialIdFromAssertion(
  credential: PasskeyCredentialAssertion,
): string | null {
  const bytes = readEncodedBytes(credential.rawId, credential.id);
  if (!bytes) {
    const asString = readEncodedString(credential.id);
    return asString;
  }
  return base64urlEncode(bytes);
}

function counterRegressed(storedCounter: number, newCounter: number): boolean {
  return storedCounter !== 0 && newCounter <= storedCounter;
}

async function consumeZeroCounterLoginChallenge(
  db: Db,
  challenge: string,
): Promise<boolean> {
  const inserted = await db
    .insert(verification)
    .values({
      identifier: `webauthn-used:${challenge}`,
      value: "consumed",
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS).toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: verification.id });
  return inserted.length > 0;
}

function loginClientDataOk(
  clientDataJSON: string,
  expectedChallenge: string,
  expectedOrigin: string,
): boolean {
  try {
    const clientData = parseClientDataJson(clientDataJSON);
    if (clientData.type !== "webauthn.get") return false;
    if (!challengesEqual(clientData.challenge, expectedChallenge)) return false;
    return clientData.origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function parseLoginAuthenticatorData(
  authenticatorData: string,
  expectedRpId: string,
): Promise<
  { authDataBytes: Uint8Array; counter: number } | null
> {
  const authDataBytes = base64urlDecode(authenticatorData);
  let authData;
  try {
    authData = parseAuthenticatorData(authDataBytes);
  } catch {
    return null;
  }
  if (!await verifyRpIdHash(authDataBytes, expectedRpId)) return null;
  if (!authData.userVerified) return null;
  return { authDataBytes, counter: authData.counter };
}

async function loginSignatureOk(params: {
  publicKey: string;
  authDataBytes: Uint8Array;
  clientDataJSON: string;
  signature: string;
}): Promise<boolean> {
  const jwk = parseStoredJwk(params.publicKey);
  if (!jwk) return false;
  try {
    return await verifyAssertion({
      jwk,
      authData: params.authDataBytes,
      clientDataJSON: base64urlDecode(params.clientDataJSON),
      signature: base64urlDecode(params.signature),
    });
  } catch {
    return false;
  }
}

export type VerifyPasskeyLoginResult =
  | { status: "ok"; userId: string }
  | { status: "invalid" };

export async function verifyPasskeyLogin(
  db: Db,
  params: {
    challengeEnvelope: string;
    credential: PasskeyCredentialAssertion;
    webauthnChallengeSecrets: DerivedSecretsConfig;
    expectedRpId: string;
    expectedOrigin: string;
  },
): Promise<VerifyPasskeyLoginResult> {
  const claims = await verifyWebauthnChallenge(
    params.webauthnChallengeSecrets,
    params.challengeEnvelope,
  );
  if (claims === "invalid" || claims === "expired") {
    return { status: "invalid" };
  }

  const clientDataJSON = readEncodedString(
    params.credential.response?.clientDataJSON,
  );
  const authenticatorData = readEncodedString(
    params.credential.response?.authenticatorData,
  );
  const signature = readEncodedString(params.credential.response?.signature);
  if (!clientDataJSON || !authenticatorData || !signature) {
    return { status: "invalid" };
  }
  if (
    !loginClientDataOk(clientDataJSON, claims.challenge, params.expectedOrigin)
  ) {
    return { status: "invalid" };
  }

  const credentialId = credentialIdFromAssertion(params.credential);
  if (!credentialId) return { status: "invalid" };

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: passkey.id,
        userId: passkey.userId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
      })
      .from(passkey)
      .where(eq(passkey.credentialId, credentialId))
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) return { status: "invalid" as const };

    const parsed = await parseLoginAuthenticatorData(
      authenticatorData,
      params.expectedRpId,
    );
    if (!parsed) return { status: "invalid" };

    const userHandle = readEncodedString(
      params.credential.response?.userHandle,
    );
    if (!userHandleMatches(userHandle, row.userId)) {
      return { status: "invalid" };
    }

    const signatureOk = await loginSignatureOk({
      publicKey: row.publicKey,
      authDataBytes: parsed.authDataBytes,
      clientDataJSON,
      signature,
    });
    if (!signatureOk) return { status: "invalid" };
    if (counterRegressed(row.counter, parsed.counter)) {
      return { status: "invalid" };
    }

    const userRows = await tx
      .select({ isDisabled: user.isDisabled })
      .from(user)
      .where(eq(user.id, row.userId))
      .limit(1);
    if (!userRows[0] || userRows[0].isDisabled) {
      return { status: "invalid" };
    }

    if (row.counter === 0 && parsed.counter === 0) {
      const consumed = await consumeZeroCounterLoginChallenge(
        tx,
        claims.challenge,
      );
      if (!consumed) return { status: "invalid" };
    }

    const updated = await tx
      .update(passkey)
      .set({ counter: parsed.counter })
      .where(and(eq(passkey.id, row.id), eq(passkey.counter, row.counter)))
      .returning({ id: passkey.id });
    if (updated.length === 0) return { status: "invalid" };

    return { status: "ok" as const, userId: row.userId };
  });
}
