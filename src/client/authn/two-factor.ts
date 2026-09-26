import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { isExplicitDevelopmentMode } from "../../app/dev-mode.ts";
import {
  account,
  passkey,
  twoFactor,
  user,
  verification,
} from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../../lib/secrets/data-encryption.ts";
import {
  ENVELOPE_SCHEME_OTP,
  ENVELOPE_SCHEME_TWO_FACTOR,
  formatEnvelope,
  parseEnvelope,
} from "../../lib/secrets/envelope.ts";
import { type DerivedSecretsConfig, findKeyForVersion } from "../../lib/secrets/secrets.ts";
import {
  buildOtpAuthUri,
  decodeBase32,
  generateTotpSecret,
  matchTotpStep,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
} from "./totp.ts";
import { constantTimeEqual } from "../../lib/secrets/constant-time.ts";
import { base64urlDecode, base64urlEncode } from "../../lib/encoding/base64url.ts";

export const TWO_FACTOR_CHALLENGE_PURPOSE = "two-factor-challenge";
export const BACKUP_CODE_VERIFIER_PURPOSE = "backup-code-verifier";
export const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_2FA_ATTEMPTS = 5;
/**
 * Failed-attempt window per user. Five failures lock second-factor sign-in for
 * the rest of the window, however many new challenges the password mints.
 */
export const TWO_FACTOR_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;
/** 32-symbol alphabet (no I/L/O/U) so printed codes stay unambiguous. */
export const BACKUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const BACKUP_CODE_VERIFIER_CONTEXT = "turbopanel-backup-code-verifier-v1";
const TWO_FA_ATTEMPTS_PREFIX = "2fa-attempts:";
/** Last accepted TOTP step and last consumed challenge, one row per user. */
const TWO_FA_USED_PREFIX = "2fa-used:";
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

function attemptsIdentifier(userId: string): string {
  return `${TWO_FA_ATTEMPTS_PREFIX}${userId}`;
}

function usedIdentifier(userId: string): string {
  return `${TWO_FA_USED_PREFIX}${userId}`;
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

/** `iat` is milliseconds; a sign-in consumes every challenge issued at or before it. */
type ChallengePayload = { userId: string; exp: number; iat: number };

export async function signTwoFactorChallenge(
  secrets: DerivedSecretsConfig,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const keyring = requireTwoFactorChallengeSecrets(secrets);
  const payload: ChallengePayload = {
    userId,
    exp: Math.floor((nowMs + TWO_FACTOR_CHALLENGE_TTL_MS) / 1000),
    iat: nowMs,
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
): Promise<ChallengePayload | "invalid" | "expired"> {
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
  if (
    typeof decoded.payload.exp !== "number" ||
    !Number.isSafeInteger(decoded.payload.iat)
  ) {
    return "invalid";
  }
  if (decoded.payload.exp * 1000 <= nowMs) {
    return "expired";
  }
  return {
    userId: decoded.payload.userId,
    exp: decoded.payload.exp,
    iat: decoded.payload.iat,
  };
}

async function resetTwoFactorAttempts(db: Db, userId: string): Promise<void> {
  await db.delete(verification).where(
    eq(verification.identifier, attemptsIdentifier(userId)),
  );
}

/**
 * Mint a fresh 5-minute `tp2fa` challenge. It deliberately leaves the attempt
 * counter alone: whoever holds the password can mint challenges at will, so a
 * new one must not buy more guesses (see {@link TWO_FACTOR_LOCKOUT_WINDOW_MS}).
 */
export function issueTwoFactorChallenge(
  _db: Db,
  secrets: DerivedSecretsConfig,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string> {
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
    const nowMs = Date.now();
    const step = await matchTotpStep(
      decodeBase32(base32Secret),
      params.code,
      nowMs / 1000,
    );
    if (step === null) {
      throw new InvalidTotpError();
    }
    await writeUsedState(tx, params.userId, {
      totpStep: step,
      challengeIat: null,
    }, nowMs);

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
      inArray(verification.identifier, [
        attemptsIdentifier(userId),
        usedIdentifier(userId),
      ]),
    );
  });
}

export type VerifyTwoFactorSignInResult =
  | "ok"
  | "invalid"
  | "expired"
  | "too_many_attempts";

function isLive(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at > nowMs;
}

/**
 * Failures inside the current lockout window. A missing or lapsed row starts
 * a new window that closes {@link TWO_FACTOR_LOCKOUT_WINDOW_MS} from now.
 */
async function readAttemptCount(
  tx: Db,
  userId: string,
  nowMs: number,
): Promise<{ attempts: number; expiresAt: string }> {
  const attemptsRow = await lockAttemptsRow(tx, userId);
  if (!attemptsRow || !isLive(attemptsRow.expiresAt, nowMs)) {
    return {
      attempts: 0,
      expiresAt: new Date(nowMs + TWO_FACTOR_LOCKOUT_WINDOW_MS).toISOString(),
    };
  }
  return {
    attempts: Number.parseInt(attemptsRow.value ?? "0", 10) || 0,
    expiresAt: attemptsRow.expiresAt,
  };
}

type UsedState = { totpStep: number | null; challengeIat: number | null };

const NOTHING_USED: UsedState = { totpStep: null, challengeIat: null };

function parseUsedState(raw: string | null): UsedState {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (parsed === null || typeof parsed !== "object") return NOTHING_USED;
    const { totpStep, challengeIat } = parsed as Record<string, unknown>;
    return {
      totpStep: Number.isSafeInteger(totpStep) ? totpStep as number : null,
      challengeIat: Number.isSafeInteger(challengeIat)
        ? challengeIat as number
        : null,
    };
  } catch {
    return NOTHING_USED;
  }
}

/** FOR UPDATE the per-user used-state row. Must follow {@link lockAttemptsRow}. */
async function readUsedState(
  tx: Db,
  userId: string,
  nowMs: number,
): Promise<UsedState> {
  const rows = await tx
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, usedIdentifier(userId)))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row || !isLive(row.expiresAt, nowMs)) return NOTHING_USED;
  return parseUsedState(row.value);
}

/**
 * Persist what was just accepted. The row only has to outlive the window in
 * which what it records could still be presented: a challenge lives
 * {@link TWO_FACTOR_CHALLENGE_TTL_MS} and a TOTP step at most
 * `TOTP_WINDOW_STEPS + 1` steps past its own.
 */
async function writeUsedState(
  tx: Db,
  userId: string,
  state: UsedState,
  nowMs: number,
): Promise<void> {
  const stepHorizonMs = state.totpStep === null
    ? 0
    : (state.totpStep + TOTP_WINDOW_STEPS + 1) * TOTP_STEP_SECONDS * 1000;
  const expiresAt = new Date(
    Math.max(nowMs + TWO_FACTOR_CHALLENGE_TTL_MS, stepHorizonMs),
  ).toISOString();
  const value = JSON.stringify(state);
  await tx
    .insert(verification)
    .values({ identifier: usedIdentifier(userId), value, expiresAt })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: { value, expiresAt, updatedAt: nowTs() },
    });
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

/**
 * `false` on no match; otherwise the TOTP step that matched (`null` for a
 * backup code). A TOTP step at or before the last accepted one is a replay
 * and does not match.
 */
async function matchTotpOrBackupCode(
  tx: Db,
  row: TwoFactorAuthRow | undefined,
  params: {
    userId: string;
    code: string | undefined;
    backupCode: string | undefined;
    lastTotpStep: number | null;
    nowMs: number;
    dataEncryptionSecrets: DerivedSecretsConfig;
    backupCodeVerifierSecrets: DerivedSecretsConfig;
  },
): Promise<false | { totpStep: number | null }> {
  if (!row?.isVerified) return false;

  if (params.code !== undefined) {
    const base32Secret = await decryptSecret(
      params.dataEncryptionSecrets,
      row.secret,
    );
    const step = await matchTotpStep(
      decodeBase32(base32Secret),
      params.code,
      params.nowMs / 1000,
    );
    if (step === null) return false;
    if (params.lastTotpStep !== null && step <= params.lastTotpStep) {
      return false;
    }
    return { totpStep: step };
  }

  const submitted = normalizeBackupCode(params.backupCode ?? "");
  if (submitted.length !== BACKUP_CODE_LENGTH) return false;

  const consumed = await consumeMatchingBackupCode(tx, {
    userId: params.userId,
    rowId: row.id,
    submitted,
    envelopes: parseBackupCodeEnvelopes(row.backupCodes),
    backupCodeVerifierSecrets: params.backupCodeVerifierSecrets,
  });
  return consumed ? { totpStep: null } : false;
}

/**
 * Verify a TOTP or backup code against a signed `tp2fa` challenge.
 *
 * - Five failures inside {@link TWO_FACTOR_LOCKOUT_WINDOW_MS} (tracked in
 *   `verification` under `2fa-attempts:<userId>`) lock the user's second
 *   factor until the window closes; a new challenge does not reset them.
 * - A successful sign-in consumes its challenge and every earlier one, and
 *   records the TOTP step it accepted, so neither a captured challenge nor a
 *   seen code works twice (`2fa-used:<userId>`).
 * - A consumed backup code is removed in the same transaction.
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

  const { userId, iat } = claims;

  return await db.transaction(async (tx) => {
    const row = await lockTwoFactorRow(tx, userId);
    const { attempts, expiresAt } = await readAttemptCount(tx, userId, nowMs);
    if (attempts >= MAX_2FA_ATTEMPTS) {
      return { status: "too_many_attempts" as const, userId };
    }

    const used = await readUsedState(tx, userId, nowMs);
    if (used.challengeIat !== null && iat <= used.challengeIat) {
      // Already spent by an earlier sign-in. Not a code guess, so it does not
      // count against the user; it carries no userId, like an invalid token.
      return { status: "invalid" as const };
    }

    const matched = await matchTotpOrBackupCode(tx, row, {
      userId,
      code: params.code,
      backupCode: params.backupCode,
      lastTotpStep: used.totpStep,
      nowMs,
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
    await writeUsedState(tx, userId, {
      totpStep: matched.totpStep ?? used.totpStep,
      challengeIat: iat,
    }, nowMs);
    return { status: "ok" as const, userId };
  });
}
