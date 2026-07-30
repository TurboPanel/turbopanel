/**
 * Symmetric data encryption keyed off the root secret via HKDF (`info: "data-encryption"`).
 *
 * At-rest envelope: `enc.<keyVersion>.<payloadB64u>`
 * - `payload` = IV (12 bytes) ‖ ciphertext+tag (AES-GCM), single base64url blob.
 * - `keyVersion` embeds the secret version for direct key lookup (rotation fallbacks, no trial decrypt).
 * - All stored secret values must use this sealed envelope; non-envelope input is rejected at decrypt time.
 *
 * Daemon-recipient envelopes (`denc.<serverId>.<keyId>.<keyVersion>.<payloadB64u>`)
 * derive per-recipient AES-GCM keys via HKDF info `daemon-secret-encryption:<serverId>:<keyId>`.
 * Format version is implied by the magic (`enc` / `denc`); bump the magic if the layout changes.
 *
 * Boundary: client/UI code imports only `encryptSecret` / `generateSealedSecret` for at-rest
 * sealing. Delivery paths use `resealSecretForDaemon` (decrypt enc → encrypt denc).
 * Daemon decrypt remains solely via `POST /api/daemon/v1/secrets/decrypt` (JWT, recipient-scoped).
 */

import { generatePassword } from "../../generate-secret.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "./secrets.ts";
import { deriveEncryptionSecretsConfig } from "./secrets.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ENVELOPE_MAGIC = "enc";
export const DAEMON_ENVELOPE_MAGIC = "denc";
const GCM_IV_BYTES = 12;

export type DaemonSecretRecipient = {
  serverId: string;
  keyId: string;
};

export class DataEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataEncryptionError";
  }
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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

function packPayload(iv: Uint8Array, ciphertext: Uint8Array): string {
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return base64urlEncode(packed);
}

function unpackPayload(payloadB64u: string): { iv: Uint8Array; ciphertext: Uint8Array } {
  const packed = base64urlDecode(payloadB64u);
  if (packed.length <= GCM_IV_BYTES) {
    throw new DataEncryptionError("invalid payload length");
  }
  return {
    iv: packed.subarray(0, GCM_IV_BYTES),
    ciphertext: packed.subarray(GCM_IV_BYTES),
  };
}

function parseKeyVersion(keyVersionStr: string): number | null {
  const keyVersion = Number.parseInt(keyVersionStr, 10);
  if (!Number.isInteger(keyVersion) || keyVersionStr.length === 0) {
    return null;
  }
  return keyVersion;
}

function resolveKeyForVersion(
  secrets: DerivedSecretsConfig,
  version: number,
): CryptoKey | null {
  if (secrets.current.version === version) {
    return secrets.current.key;
  }
  const fallback = secrets.fallbacks.find((entry) => entry.version === version);
  return fallback?.key ?? null;
}

export function isSealedEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_MAGIC}.`) || value.startsWith(`${DAEMON_ENVELOPE_MAGIC}.`);
}

export function isDaemonSealedEnvelope(value: string): boolean {
  return value.startsWith(`${DAEMON_ENVELOPE_MAGIC}.`);
}

function buildDaemonEncryptionPurpose(recipient: DaemonSecretRecipient): string {
  return `daemon-secret-encryption:${recipient.serverId}:${recipient.keyId}`;
}

export type ParsedDaemonSecretEnvelope = DaemonSecretRecipient & {
  keyVersion: number;
};

export type ParsedSecretEnvelope = {
  keyVersion: number;
};

/**
 * Cheap structural parse of an at-rest `enc` envelope (version only).
 * Returns `null` for `denc`, plaintext, or malformed values — never trial-decrypts.
 */
export function parseSecretEnvelope(envelope: string): ParsedSecretEnvelope | null {
  if (!envelope.startsWith(`${ENVELOPE_MAGIC}.`)) {
    return null;
  }

  const parts = envelope.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [magic, keyVersionStr, payloadB64u] = parts;
  if (magic !== ENVELOPE_MAGIC || !payloadB64u) {
    return null;
  }

  const keyVersion = parseKeyVersion(keyVersionStr);
  if (keyVersion === null) {
    return null;
  }

  return { keyVersion };
}

export function parseDaemonSecretEnvelope(envelope: string): ParsedDaemonSecretEnvelope | null {
  if (!isDaemonSealedEnvelope(envelope)) {
    return null;
  }

  const parts = envelope.split(".");
  if (parts.length !== 5) {
    return null;
  }

  const [magic, serverId, keyId, keyVersionStr, payloadB64u] = parts;
  if (magic !== DAEMON_ENVELOPE_MAGIC || !serverId || !keyId || !payloadB64u) {
    return null;
  }

  const keyVersion = parseKeyVersion(keyVersionStr);
  if (keyVersion === null) {
    return null;
  }

  return { serverId, keyId, keyVersion };
}

async function deriveDaemonEncryptionSecrets(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
): Promise<DerivedSecretsConfig> {
  return deriveEncryptionSecretsConfig(
    secretsConfig,
    buildDaemonEncryptionPurpose(recipient),
  );
}

export async function encryptSecret(
  secrets: DerivedSecretsConfig,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    secrets.current.key,
    textEncoder.encode(plaintext),
  );
  return [
    ENVELOPE_MAGIC,
    String(secrets.current.version),
    packPayload(iv, new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptSecret(
  secrets: DerivedSecretsConfig,
  envelope: string,
): Promise<string> {
  if (!isSealedEnvelope(envelope)) {
    throw new DataEncryptionError("not a sealed envelope");
  }

  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new DataEncryptionError("malformed envelope");
  }

  const [magic, keyVersionStr, payloadB64u] = parts;
  if (magic !== ENVELOPE_MAGIC) {
    throw new DataEncryptionError("invalid envelope magic");
  }

  const keyVersion = parseKeyVersion(keyVersionStr);
  if (keyVersion === null) {
    throw new DataEncryptionError("invalid key version");
  }

  const key = resolveKeyForVersion(secrets, keyVersion);
  if (!key) {
    throw new DataEncryptionError("unknown key version");
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    ({ iv, ciphertext } = unpackPayload(payloadB64u));
  } catch (error) {
    if (error instanceof DataEncryptionError) {
      throw error;
    }
    throw new DataEncryptionError("malformed envelope encoding");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return textDecoder.decode(plaintext);
  } catch {
    throw new DataEncryptionError("decryption failed");
  }
}

export async function encryptSecretForDaemon(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  plaintext: string,
): Promise<string> {
  const derived = await deriveDaemonEncryptionSecrets(secretsConfig, recipient);
  const iv = new Uint8Array(GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    derived.current.key,
    textEncoder.encode(plaintext),
  );
  return [
    DAEMON_ENVELOPE_MAGIC,
    recipient.serverId,
    recipient.keyId,
    String(derived.current.version),
    packPayload(iv, new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptSecretForDaemon(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  envelope: string,
): Promise<string> {
  const parsed = parseDaemonSecretEnvelope(envelope);
  if (!parsed) {
    throw new DataEncryptionError("not a daemon sealed envelope");
  }
  if (parsed.serverId !== recipient.serverId || parsed.keyId !== recipient.keyId) {
    throw new DataEncryptionError("recipient mismatch");
  }

  const derived = await deriveDaemonEncryptionSecrets(secretsConfig, recipient);
  const key = resolveKeyForVersion(derived, parsed.keyVersion);
  if (!key) {
    throw new DataEncryptionError("unknown key version");
  }

  const parts = envelope.split(".");
  const payloadB64u = parts[4]!;

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    ({ iv, ciphertext } = unpackPayload(payloadB64u));
  } catch (error) {
    if (error instanceof DataEncryptionError) {
      throw error;
    }
    throw new DataEncryptionError("malformed envelope encoding");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return textDecoder.decode(plaintext);
  } catch {
    throw new DataEncryptionError("decryption failed");
  }
}

/**
 * Decrypt an at-rest `enc` envelope and re-seal it as a recipient-bound
 * `denc` envelope for daemon delivery.
 */
export async function resealSecretForDaemon(
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  recipient: DaemonSecretRecipient,
  sealedEnvelope: string,
): Promise<string> {
  const plaintext = await decryptSecret(dataEncryptionSecrets, sealedEnvelope);
  return encryptSecretForDaemon(secretsConfig, recipient, plaintext);
}

/**
 * Generate a random password, seal it as `enc`, and return the plaintext
 * once for show-once UX. The helper never persists either value.
 */
export async function generateSealedSecret(
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<{ plaintext: string; sealed: string }> {
  const plaintext = generatePassword();
  const sealed = await encryptSecret(dataEncryptionSecrets, plaintext);
  return { plaintext, sealed };
}
