/**
 * Symmetric data encryption keyed off the root secret via HKDF (`info: "data-encryption"`).
 *
 * At-rest envelope: `tpsecret.v<version>.<payloadB64u>`
 * - `payload` = IV (12 bytes) ‖ ciphertext+tag (AES-GCM), single base64url blob.
 * - `version` (after the `v` token) embeds the secret version for direct key lookup
 *   (rotation fallbacks, no trial decrypt).
 * - All stored secret values must use this sealed envelope; non-envelope input is
 *   rejected at decrypt time.
 *
 * Daemon-recipient envelopes
 * (`tpdaemon.v<version>.<serverId>.<keyId>.<payloadB64u>`) derive per-recipient
 * AES-GCM keys via HKDF info `daemon-secret-encryption:<serverId>:<keyId>`.
 *
 * Grammar is `<scheme>.v<version>.<fields…>` — scheme is `tpsecret` (at rest) or
 * `tpdaemon` (daemon delivery). Wire helpers live in `./envelope.ts`.
 *
 * Boundary: client/UI code imports only `encryptSecret` / `generateSealedSecret` for at-rest
 * sealing. Delivery paths use `resealSecretForDaemon` (decrypt tpsecret → encrypt tpdaemon).
 * Daemon decrypt remains solely via `POST /api/daemon/v1/secrets/decrypt` (JWT, recipient-scoped).
 */

import { generatePassword } from "../../generate-secret.ts";
import {
  deriveEncryptionSecretsConfig,
  findKeyForVersion,
  type DerivedSecretsConfig,
  type SecretsConfig,
} from "./secrets.ts";
import {
  ENVELOPE_SCHEME_DAEMON,
  ENVELOPE_SCHEME_SECRET,
  formatEnvelope,
  hasEnvelopeScheme,
  parseEnvelope,
} from "./envelope.ts";

/** At-rest scheme identifier (`tpsecret`). Prefer {@link ENVELOPE_PREFIX_SECRET} for prefix checks. */
export { ENVELOPE_SCHEME_SECRET as ENVELOPE_MAGIC } from "./envelope.ts";
/** Daemon-recipient scheme identifier (`tpdaemon`). Prefer {@link ENVELOPE_PREFIX_DAEMON} for prefix checks. */
export { ENVELOPE_SCHEME_DAEMON as DAEMON_ENVELOPE_MAGIC } from "./envelope.ts";
export {
  ENVELOPE_PREFIX_DAEMON,
  ENVELOPE_PREFIX_SECRET,
} from "./envelope.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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


export function isSealedEnvelope(value: string): boolean {
  return (
    hasEnvelopeScheme(ENVELOPE_SCHEME_SECRET, value) ||
    hasEnvelopeScheme(ENVELOPE_SCHEME_DAEMON, value)
  );
}

export function isDaemonSealedEnvelope(value: string): boolean {
  return hasEnvelopeScheme(ENVELOPE_SCHEME_DAEMON, value);
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
 * Cheap structural parse of an at-rest `tpsecret` envelope (version only).
 * Returns `null` for `tpdaemon`, plaintext, or malformed values — never trial-decrypts.
 */
export function parseSecretEnvelope(envelope: string): ParsedSecretEnvelope | null {
  const parsed = parseEnvelope(ENVELOPE_SCHEME_SECRET, envelope, 1);
  if (!parsed) {
    return null;
  }
  return { keyVersion: parsed.version };
}

export function parseDaemonSecretEnvelope(envelope: string): ParsedDaemonSecretEnvelope | null {
  const parsed = parseEnvelope(ENVELOPE_SCHEME_DAEMON, envelope, 3);
  if (!parsed) {
    return null;
  }
  const [serverId, keyId] = parsed.fields;
  return { serverId: serverId!, keyId: keyId!, keyVersion: parsed.version };
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
  return formatEnvelope(
    ENVELOPE_SCHEME_SECRET,
    secrets.current.version,
    packPayload(iv, new Uint8Array(ciphertext)),
  );
}

export async function decryptSecret(
  secrets: DerivedSecretsConfig,
  envelope: string,
): Promise<string> {
  if (!isSealedEnvelope(envelope)) {
    throw new DataEncryptionError("not a sealed envelope");
  }

  const parsed = parseEnvelope(ENVELOPE_SCHEME_SECRET, envelope, 1);
  if (!parsed) {
    throw new DataEncryptionError("malformed envelope");
  }

  const key = findKeyForVersion(secrets, parsed.version);
  if (!key) {
    throw new DataEncryptionError("unknown key version");
  }

  const payloadB64u = parsed.fields[0]!;

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
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
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
  return formatEnvelope(
    ENVELOPE_SCHEME_DAEMON,
    derived.current.version,
    recipient.serverId,
    recipient.keyId,
    packPayload(iv, new Uint8Array(ciphertext)),
  );
}

export async function decryptSecretForDaemon(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  envelope: string,
): Promise<string> {
  if (!isDaemonSealedEnvelope(envelope)) {
    throw new DataEncryptionError("not a sealed envelope");
  }

  const parsed = parseEnvelope(ENVELOPE_SCHEME_DAEMON, envelope, 3);
  if (!parsed) {
    throw new DataEncryptionError("malformed envelope");
  }

  const [serverId, keyId, payloadB64u] = parsed.fields;
  if (serverId !== recipient.serverId || keyId !== recipient.keyId) {
    throw new DataEncryptionError("recipient mismatch");
  }

  const derived = await deriveDaemonEncryptionSecrets(secretsConfig, recipient);
  const key = findKeyForVersion(derived, parsed.version);
  if (!key) {
    throw new DataEncryptionError("unknown key version");
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    ({ iv, ciphertext } = unpackPayload(payloadB64u!));
  } catch (error) {
    if (error instanceof DataEncryptionError) {
      throw error;
    }
    throw new DataEncryptionError("malformed envelope encoding");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return textDecoder.decode(plaintext);
  } catch {
    throw new DataEncryptionError("decryption failed");
  }
}

/**
 * Decrypt an at-rest `tpsecret` envelope and re-seal it as a recipient-bound
 * `tpdaemon` envelope for daemon delivery.
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
 * Generate a random password, seal it as `tpsecret`, and return the plaintext
 * once for show-once UX. The helper never persists either value.
 */
export async function generateSealedSecret(
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<{ plaintext: string; sealed: string }> {
  const plaintext = generatePassword();
  const sealed = await encryptSecret(dataEncryptionSecrets, plaintext);
  return { plaintext, sealed };
}
