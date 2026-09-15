import { eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { isExplicitDevelopmentMode } from "../../dev-mode.ts";
import {
  account,
  passkey,
  twoFactor,
  user,
  verification,
} from "../../lib/db/schema.ts";
import { decryptSecret, encryptSecret } from "./data-encryption.ts";
import {
  ENVELOPE_SCHEME_OTP,
  ENVELOPE_SCHEME_TWO_FACTOR,
  formatEnvelope,
  parseEnvelope,
} from "./envelope.ts";
import { type DerivedSecretsConfig, findKeyForVersion } from "./secrets.ts";
import {
  buildOtpAuthUri,
  decodeBase32,
  generateTotpSecret,
  verifyTotp,
} from "./totp.ts";

export const TWO_FACTOR_CHALLENGE_PURPOSE = "two-factor-challenge";
export const BACKUP_CODE_VERIFIER_PURPOSE = "backup-code-verifier";
export const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_2FA_ATTEMPTS = 5;
export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;
/** 32-symbol alphabet (no I/L/O/U) so printed codes stay unambiguous. */
export const BACKUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const BACKUP_CODE_VERIFIER_CONTEXT = "turbopanel-backup-code-verifier-v1";
const TWO_FA_ATTEMPTS_PREFIX = "2fa-attempts:";
const BACKUP_CODE_ALPHABET_BOUND =
  Math.floor(256 / BACKUP_CODE_ALPHABET.length) * BACKUP_CODE_ALPHABET.length;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class TwoFactorEnabledError extends Error {
  readonly code = "two_factor_enabled";
  constructor() {
    super("two_factor_enabled");
    this.name = "TwoFactorEnabledError";
  }
}

export class TwoFactorNotEnrolledError extends Error {
  constructor() {
    super("two-factor is not enrolled");
    this.name = "TwoFactorNotEnrolledError";
  }
}

export class InvalidTotpError extends Error {
  constructor() {
    super("invalid_totp");
    this.name = "InvalidTotpError";
  }
}

function nowTs(): string {
  return new Date().toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

function attemptsIdentifier(userId: string): string {
  return `${TWO_FA_ATTEMPTS_PREFIX}${userId}`;
}

export function requireBackupCodeVerifierSecrets(
  secrets: DerivedSecretsConfig | undefined,
): DerivedSecretsConfig {
  if (secrets) return secrets;
  if (isExplicitDevelopmentMode()) {
    throw new Error(
      "Backup-code verifier secrets are required in development — deriveSecretsConfig with purpose backup-code-verifier",
    );
  }
  throw new Error(
    "Backup-code verifier secrets are required (deriveSecretsConfig with purpose backup-code-verifier)",
  );
}

export function requireTwoFactorChallengeSecrets(
  secrets: DerivedSecretsConfig | undefined,
): DerivedSecretsConfig {
  if (secrets) return secrets;
  if (isExplicitDevelopmentMode()) {
    throw new Error(
      "Two-factor challenge secrets are required in development — deriveSecretsConfig with purpose two-factor-challenge",
    );
  }
  throw new Error(
    "Two-factor challenge secrets are required (deriveSecretsConfig with purpose two-factor-challenge)",
  );
}

function randomAlphabetChar(): string {
  const bytes = new Uint8Array(1);
  while (true) {
    crypto.getRandomValues(bytes);
    if (bytes[0]! < BACKUP_CODE_ALPHABET_BOUND) {
      return BACKUP_CODE_ALPHABET[bytes[0]! % BACKUP_CODE_ALPHABET.length]!;
    }
  }
}

export function generateBackupCode(): string {
  let code = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) {
    code += randomAlphabetChar();
  }
  return code;
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(generateBackupCode());
  }
  return codes;
}

export function normalizeBackupCode(code: string): string {
  return code.trim().replaceAll(" ", "").replaceAll("-", "").toUpperCase();
}

async function deriveBackupCodeVerifier(
  userId: string,
  code: string,
  secrets: DerivedSecretsConfig,
): Promise<string> {
  const keyring = requireBackupCodeVerifierSecrets(secrets);
  const material = `${BACKUP_CODE_VERIFIER_CONTEXT}:${userId}:${code}`;
  const mac = await crypto.subtle.sign(
    "HMAC",
    keyring.current.key,
    textEncoder.encode(material),
  );
  return formatEnvelope(
    ENVELOPE_SCHEME_OTP,
    keyring.current.version,
    bytesToHex(new Uint8Array(mac)),
  );
}

async function hmacMatchesStored(
  key: CryptoKey,
  materialBytes: Uint8Array,
  providedMac: string,
): Promise<boolean> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    materialBytes as BufferSource,
  );
  return constantTimeEqual(providedMac, bytesToHex(new Uint8Array(mac)));
}

async function verifyBackupCodeVerifier(
  userId: string,
  code: string,
  storedVerifier: string,
  secrets: DerivedSecretsConfig,
): Promise<boolean> {
  const keyring = requireBackupCodeVerifierSecrets(secrets);
  const parsed = parseEnvelope(ENVELOPE_SCHEME_OTP, storedVerifier, 1);
  if (parsed === null) return false;
  const hmacHex = parsed.fields[0]!;
  if (!/^[0-9a-f]+$/i.test(hmacHex)) return false;
  const providedMac = hmacHex.toLowerCase();
  const material = `${BACKUP_CODE_VERIFIER_CONTEXT}:${userId}:${code}`;
  const materialBytes = textEncoder.encode(material);

  const versionedKey = findKeyForVersion(keyring, parsed.version);
  if (
    versionedKey &&
    await hmacMatchesStored(versionedKey, materialBytes, providedMac)
  ) {
    return true;
  }

  const keysToTry: CryptoKey[] = [
    keyring.current.key,
    ...keyring.fallbacks.map((fallback) => fallback.key),
  ];
  for (const key of keysToTry) {
    if (key === versionedKey) continue;
    if (await hmacMatchesStored(key, materialBytes, providedMac)) {
      return true;
    }
  }
  return false;
}

async function sealBackupCodes(
  userId: string,
  codes: string[],
  secrets: DerivedSecretsConfig,
): Promise<string> {
  const envelopes: string[] = [];
  for (const code of codes) {
    envelopes.push(await deriveBackupCodeVerifier(userId, code, secrets));
  }
  return JSON.stringify(envelopes);
}

function parseBackupCodeEnvelopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

type ChallengePayload = { userId: string; exp: number };

export async function signTwoFactorChallenge(
  secrets: DerivedSecretsConfig,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const keyring = requireTwoFactorChallengeSecrets(secrets);
  const payload: ChallengePayload = {
    userId,
    exp: Math.floor((nowMs + TWO_FACTOR_CHALLENGE_TTL_MS) / 1000),
  };
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    keyring.current.key,
    textEncoder.encode(encodedPayload),
  );
  return formatEnvelope(
    ENVELOPE_SCHEME_TWO_FACTOR,
    keyring.current.version,
    encodedPayload,
    base64urlEncode(new Uint8Array(signature)),
  );
}

function decodeChallengePayload(
  encodedPayload: string,
  encodedSignature: string,
): { signature: Uint8Array; payload: ChallengePayload } | null {
  try {
    const payload = JSON.parse(
      textDecoder.decode(base64urlDecode(encodedPayload)),
    ) as ChallengePayload;
    return { signature: base64urlDecode(encodedSignature), payload };
  } catch {
    return null;
  }
}

export async function verifyTwoFactorChallenge(
  secrets: DerivedSecretsConfig,
  challenge: string,
  nowMs: number = Date.now(),
): Promise<{ userId: string; exp: number } | "invalid" | "expired"> {
  const keyring = requireTwoFactorChallengeSecrets(secrets);
  const parsed = parseEnvelope(ENVELOPE_SCHEME_TWO_FACTOR, challenge, 2);
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
  if (
    typeof decoded.payload.userId !== "string" ||
    decoded.payload.userId.length === 0
  ) {
    return "invalid";
  }
  if (typeof decoded.payload.exp !== "number") {
    return "invalid";
  }
  if (decoded.payload.exp * 1000 <= nowMs) {
    return "expired";
  }
  return { userId: decoded.payload.userId, exp: decoded.payload.exp };
}

async function resetTwoFactorAttempts(db: Db, userId: string): Promise<void> {
  await db.delete(verification).where(
    eq(verification.identifier, attemptsIdentifier(userId)),
  );
}

/**
 * Mint a fresh 5-minute `tp2fa` challenge and reset that user's attempt
 * counter so a new sign-in is not blocked by a prior failed challenge.
 */
export async function issueTwoFactorChallenge(
  db: Db,
  secrets: DerivedSecretsConfig,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  await resetTwoFactorAttempts(db, userId);
  return signTwoFactorChallenge(secrets, userId, nowMs);
}

export type TwoFactorPasskeySummary = {
  id: string;
  name: string | null;
  createdAt: string;
  deviceType: string;
  isBackedUp: boolean;
};

export type TwoFactorStatus = {
  enabled: boolean;
  method: "totp" | null;
  backupCodesRemaining: number;
  passkeys: TwoFactorPasskeySummary[];
  /** OAuth provider ids linked to this user — excludes the password (`credential`) row. */
  linkedProviders: string[];
};

export async function getTwoFactorStatus(
  db: Db,
  userId: string,
): Promise<TwoFactorStatus> {
  const [factorRows, userRows, passkeyRows, accountRows] = await Promise.all([
    db
      .select({
        isVerified: twoFactor.isVerified,
        backupCodes: twoFactor.backupCodes,
      })
      .from(twoFactor)
      .where(eq(twoFactor.userId, userId))
      .limit(1),
    db
      .select({ is2FaEnabled: user.is2FaEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    db
      .select({
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        deviceType: passkey.deviceType,
        isBackedUp: passkey.isBackedUp,
      })
      .from(passkey)
      .where(eq(passkey.userId, userId)),
    db
      .select({ providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, userId)),
  ]);

  const factor = factorRows[0];
  const enabled = userRows[0]?.is2FaEnabled === true &&
    factor?.isVerified === true;
  const passkeys = passkeyRows
    .map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      deviceType: row.deviceType,
      isBackedUp: row.isBackedUp,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const linkedProviders = [
    ...new Set(
      accountRows
        .map((row) => row.providerId)
        .filter((id) => id !== "credential"),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return {
    enabled,
    method: enabled ? "totp" : null,
    backupCodesRemaining: enabled
      ? parseBackupCodeEnvelopes(factor!.backupCodes).length
      : 0,
    passkeys,
    linkedProviders,
  };
}

export async function enrollTotp(
  db: Db,
  params: {
    userId: string;
    email: string;
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret();
  const sealed = await encryptSecret(params.dataEncryptionSecrets, secret);
  const otpauthUri = buildOtpAuthUri(params.email, secret);

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: twoFactor.id, isVerified: twoFactor.isVerified })
      .from(twoFactor)
      .where(eq(twoFactor.userId, params.userId))
      .for("update")
      .limit(1);

    const current = existing[0];
    if (current?.isVerified) {
      throw new TwoFactorEnabledError();
    }

    if (current) {
      await tx
        .update(twoFactor)
        .set({ secret: sealed, isVerified: false, backupCodes: "[]" })
        .where(eq(twoFactor.id, current.id));
      return;
    }

    await tx.insert(twoFactor).values({
      userId: params.userId,
      secret: sealed,
      isVerified: false,
      backupCodes: "[]",
    });
  });

  return { secret, otpauthUri };
}

export async function verifyTotpEnrollment(
  db: Db,
  params: {
    userId: string;
    code: string;
    dataEncryptionSecrets: DerivedSecretsConfig;
    backupCodeVerifierSecrets: DerivedSecretsConfig;
  },
): Promise<{ backupCodes: string[] }> {
  const backupSecrets = requireBackupCodeVerifierSecrets(
    params.backupCodeVerifierSecrets,
  );

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: twoFactor.id,
        secret: twoFactor.secret,
        isVerified: twoFactor.isVerified,
      })
      .from(twoFactor)
      .where(eq(twoFactor.userId, params.userId))
      .for("update")
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new TwoFactorNotEnrolledError();
    }
    if (row.isVerified) {
      throw new TwoFactorEnabledError();
    }

    const base32Secret = await decryptSecret(
      params.dataEncryptionSecrets,
      row.secret,
    );
    const matched = await verifyTotp(decodeBase32(base32Secret), params.code);
    if (!matched) {
      throw new InvalidTotpError();
    }

    const backupCodes = generateBackupCodes();
    const sealedCodes = await sealBackupCodes(
      params.userId,
      backupCodes,
      backupSecrets,
    );
    const stamp = nowTs();
    await tx
      .update(twoFactor)
      .set({ isVerified: true, backupCodes: sealedCodes })
      .where(eq(twoFactor.id, row.id));
    await tx
      .update(user)
      .set({ is2FaEnabled: true, updatedAt: stamp })
      .where(eq(user.id, params.userId));

    return { backupCodes };
  });
}

export async function regenerateBackupCodes(
  db: Db,
  params: {
    userId: string;
    backupCodeVerifierSecrets: DerivedSecretsConfig;
  },
): Promise<{ backupCodes: string[] }> {
  const backupSecrets = requireBackupCodeVerifierSecrets(
    params.backupCodeVerifierSecrets,
  );

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: twoFactor.id, isVerified: twoFactor.isVerified })
      .from(twoFactor)
      .where(eq(twoFactor.userId, params.userId))
      .for("update")
      .limit(1);

    const row = rows[0];
    if (!row?.isVerified) {
      throw new TwoFactorNotEnrolledError();
    }

    const backupCodes = generateBackupCodes();
    const sealedCodes = await sealBackupCodes(
      params.userId,
      backupCodes,
      backupSecrets,
    );
    await tx
      .update(twoFactor)
      .set({ backupCodes: sealedCodes })
      .where(eq(twoFactor.id, row.id));
    return { backupCodes };
  });
}

type TwoFactorAuthRow = {
  id: string;
  secret: string;
  isVerified: boolean;
  backupCodes: string;
};

/**
 * FOR UPDATE the `2fa` row. Pair with {@link lockAttemptsRow} — always this
 * table first so concurrent sign-in and disable cannot deadlock.
 */
async function lockTwoFactorRow(
  tx: Db,
  userId: string,
): Promise<TwoFactorAuthRow | undefined> {
  const rows = await tx
    .select({
      id: twoFactor.id,
      secret: twoFactor.secret,
      isVerified: twoFactor.isVerified,
      backupCodes: twoFactor.backupCodes,
    })
    .from(twoFactor)
    .where(eq(twoFactor.userId, userId))
    .for("update")
    .limit(1);
  return rows[0];
}

/** FOR UPDATE the `verification` attempts row. Must follow {@link lockTwoFactorRow}. */
async function lockAttemptsRow(
  tx: Db,
  userId: string,
): Promise<{ id: string; value: string; expiresAt: string } | undefined> {
  const attemptsRows = await tx
    .select({
      id: verification.id,
      value: verification.value,
      expiresAt: verification.expiresAt,
    })
    .from(verification)
    .where(eq(verification.identifier, attemptsIdentifier(userId)))
    .for("update")
    .limit(1);
  return attemptsRows[0];
}

export async function disableTwoFactor(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTwoFactorRow(tx, userId);
    await lockAttemptsRow(tx, userId);
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await tx
      .update(user)
      .set({ is2FaEnabled: false, updatedAt: nowTs() })
      .where(eq(user.id, userId));
    await tx.delete(verification).where(
      eq(verification.identifier, attemptsIdentifier(userId)),
    );
  });
}

export type VerifyTwoFactorSignInResult =
  | "ok"
  | "invalid"
  | "expired"
  | "too_many_attempts";

async function readAttemptCount(
  tx: Db,
  userId: string,
  expiresAt: string,
): Promise<{ attempts: number; expiresAt: string }> {
  const attemptsRow = await lockAttemptsRow(tx, userId);
  if (!attemptsRow) {
    return { attempts: 0, expiresAt };
  }
  return {
    attempts: Number.parseInt(attemptsRow.value ?? "0", 10) || 0,
    expiresAt: attemptsRow.expiresAt,
  };
}

async function recordFailedAttempt(
  tx: Db,
  userId: string,
  nextAttempts: number,
  expiresAt: string,
): Promise<void> {
  const attemptsId = attemptsIdentifier(userId);
  const stamp = nowTs();
  await tx
    .insert(verification)
    .values({
      identifier: attemptsId,
      value: String(nextAttempts),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: {
        value: String(nextAttempts),
        expiresAt,
        updatedAt: stamp,
      },
    });
}

async function consumeMatchingBackupCode(
  tx: Db,
  params: {
    userId: string;
    rowId: string;
    submitted: string;
    envelopes: string[];
    backupCodeVerifierSecrets: DerivedSecretsConfig;
  },
): Promise<boolean> {
  let matchedIndex = -1;
  for (let i = 0; i < params.envelopes.length; i += 1) {
    const matched = await verifyBackupCodeVerifier(
      params.userId,
      params.submitted,
      params.envelopes[i]!,
      params.backupCodeVerifierSecrets,
    );
    if (matched && matchedIndex < 0) {
      matchedIndex = i;
    }
  }
  if (matchedIndex < 0) return false;

  const remaining = params.envelopes.filter((_, index) =>
    index !== matchedIndex
  );
  await tx
    .update(twoFactor)
    .set({ backupCodes: JSON.stringify(remaining) })
    .where(eq(twoFactor.id, params.rowId));
  return true;
}

async function matchTotpOrBackupCode(
  tx: Db,
  row: TwoFactorAuthRow | undefined,
  params: {
    userId: string;
    code: string | undefined;
    backupCode: string | undefined;
    dataEncryptionSecrets: DerivedSecretsConfig;
    backupCodeVerifierSecrets: DerivedSecretsConfig;
  },
): Promise<boolean> {
  if (!row?.isVerified) return false;

  if (params.code !== undefined) {
    const base32Secret = await decryptSecret(
      params.dataEncryptionSecrets,
      row.secret,
    );
    return verifyTotp(decodeBase32(base32Secret), params.code);
  }

  const submitted = normalizeBackupCode(params.backupCode ?? "");
  if (submitted.length !== BACKUP_CODE_LENGTH) return false;

  return consumeMatchingBackupCode(tx, {
    userId: params.userId,
    rowId: row.id,
    submitted,
    envelopes: parseBackupCodeEnvelopes(row.backupCodes),
    backupCodeVerifierSecrets: params.backupCodeVerifierSecrets,
  });
}

/**
 * Verify a TOTP or backup code against a signed `tp2fa` challenge. Five
 * failures (tracked in `verification` under `2fa-attempts:<userId>`) kill the
 * challenge. A consumed backup code is removed in the same transaction.
 */
export async function verifyTwoFactorSignIn(
  db: Db,
  params: {
    challenge: string;
    code?: string;
    backupCode?: string;
    twoFactorChallengeSecrets: DerivedSecretsConfig;
    dataEncryptionSecrets: DerivedSecretsConfig;
    backupCodeVerifierSecrets: DerivedSecretsConfig;
    nowMs?: number;
  },
): Promise<{ status: VerifyTwoFactorSignInResult; userId?: string }> {
  const nowMs = params.nowMs ?? Date.now();
  const claims = await verifyTwoFactorChallenge(
    params.twoFactorChallengeSecrets,
    params.challenge,
    nowMs,
  );
  if (claims === "invalid" || claims === "expired") {
    return { status: claims };
  }

  const { userId, exp } = claims;
  const challengeExpIso = new Date(exp * 1000).toISOString();

  return await db.transaction(async (tx) => {
    const row = await lockTwoFactorRow(tx, userId);
    const { attempts, expiresAt } = await readAttemptCount(
      tx,
      userId,
      challengeExpIso,
    );
    if (attempts >= MAX_2FA_ATTEMPTS) {
      return { status: "too_many_attempts" as const, userId };
    }

    const matched = await matchTotpOrBackupCode(tx, row, {
      userId,
      code: params.code,
      backupCode: params.backupCode,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
      backupCodeVerifierSecrets: params.backupCodeVerifierSecrets,
    });
    if (!matched) {
      const nextAttempts = attempts + 1;
      await recordFailedAttempt(tx, userId, nextAttempts, expiresAt);
      if (nextAttempts >= MAX_2FA_ATTEMPTS) {
        return { status: "too_many_attempts" as const, userId };
      }
      return { status: "invalid" as const, userId };
    }

    await resetTwoFactorAttempts(tx, userId);
    return { status: "ok" as const, userId };
  });
}
