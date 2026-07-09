/**
 * Symmetric data encryption keyed off the root secret via HKDF (`info: "data-encryption"`).
 *
 * Envelope format: `tpsecret.v1.<keyVersion>.<ivB64u>.<ciphertextWithTagB64u>`
 * - `keyVersion` embeds the secret version for direct key lookup (rotation fallbacks, no trial decrypt).
 * - All stored secret values must use this sealed envelope; non-envelope input is rejected at decrypt time.
 *
 * Daemon-recipient envelopes (`tpdaemon.v1.<serverId>.<keyId>.<keyVersion>.<iv>.<ciphertext>`)
 * derive per-recipient AES-GCM keys via HKDF info `daemon-secret-encryption:<serverId>:<keyId>`.
 *
 * Boundary: client/UI code imports only `encryptSecret` / `encryptSecretForDaemon`. Decryption is
 * exposed solely through `POST /api/daemon/v1/secrets/decrypt` (daemon JWT, recipient-scoped).
 */

import type { DerivedSecretsConfig, SecretsConfig } from "./secrets.ts";
import { deriveEncryptionSecretsConfig } from "./secrets.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ENVELOPE_MAGIC = "tpsecret";
export const DAEMON_ENVELOPE_MAGIC = "tpdaemon";
export const ENVELOPE_FORMAT_VERSION = "v1";
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
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

export function parseDaemonSecretEnvelope(envelope: string): ParsedDaemonSecretEnvelope | null {
  if (!isDaemonSealedEnvelope(envelope)) {
    return null;
  }

  const parts = envelope.split(".");
  if (parts.length !== 7) {
    return null;
  }

  const [magic, formatVersion, serverId, keyId, keyVersionStr] = parts;
  if (magic !== DAEMON_ENVELOPE_MAGIC || formatVersion !== ENVELOPE_FORMAT_VERSION) {
    return null;
  }
  if (!serverId || !keyId) {
    return null;
  }

  const keyVersion = Number.parseInt(keyVersionStr, 10);
  if (!Number.isInteger(keyVersion) || keyVersionStr.length === 0) {
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
    ENVELOPE_FORMAT_VERSION,
    String(secrets.current.version),
    base64urlEncode(iv),
    base64urlEncode(new Uint8Array(ciphertext)),
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
  if (parts.length !== 5) {
    throw new DataEncryptionError("malformed envelope");
  }

  const [magic, formatVersion, keyVersionStr, ivB64u, ciphertextB64u] = parts;
  if (magic !== ENVELOPE_MAGIC) {
    throw new DataEncryptionError("invalid envelope magic");
  }
  if (formatVersion !== ENVELOPE_FORMAT_VERSION) {
    throw new DataEncryptionError("unsupported envelope format version");
  }

  const keyVersion = Number.parseInt(keyVersionStr, 10);
  if (!Number.isInteger(keyVersion) || keyVersionStr.length === 0) {
    throw new DataEncryptionError("invalid key version");
  }

  const key = resolveKeyForVersion(secrets, keyVersion);
  if (!key) {
    throw new DataEncryptionError("unknown key version");
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64urlDecode(ivB64u);
    ciphertext = base64urlDecode(ciphertextB64u);
  } catch {
    throw new DataEncryptionError("malformed envelope encoding");
  }

  if (iv.length !== GCM_IV_BYTES) {
    throw new DataEncryptionError("invalid IV length");
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
    ENVELOPE_FORMAT_VERSION,
    recipient.serverId,
    recipient.keyId,
    String(derived.current.version),
    base64urlEncode(iv),
    base64urlEncode(new Uint8Array(ciphertext)),
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
  const [, , , , , ivB64u, ciphertextB64u] = parts;

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64urlDecode(ivB64u);
    ciphertext = base64urlDecode(ciphertextB64u);
  } catch {
    throw new DataEncryptionError("malformed envelope encoding");
  }

  if (iv.length !== GCM_IV_BYTES) {
    throw new DataEncryptionError("invalid IV length");
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
