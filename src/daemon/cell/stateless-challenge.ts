import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import {
  DAEMON_CHALLENGE_TTL_MS,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  type DaemonChallenge,
} from "../authn/challenge.ts";

export {
  DAEMON_CHALLENGE_TTL_MS,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
} from "../authn/challenge.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Stateless challenges are not single-use — a valid token can be replayed
 * within its TTL window. Security relies on the short TTL (60s) plus the
 * daemon's Ed25519 private key being required to produce a valid signature
 * over the challenge nonce.
 */
type ChallengePayload = {
  nonce: string;
  issuedAtMs: number;
  ttlMs: number;
  serverId: string;
  keyId: string;
};

export interface DaemonChallengeStore {
  issue(
    params?: { serverId?: string; keyId?: string },
  ): Promise<DaemonChallenge>;
  consume(params: {
    challengeId: string;
    serverId?: string;
    keyId?: string;
  }): Promise<DaemonChallenge | null>;
  readonly ttlMs: number;
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

function parsePayload(encoded: string): ChallengePayload | null {
  try {
    const bytes = base64urlDecode(encoded);
    return JSON.parse(textDecoder.decode(bytes)) as ChallengePayload;
  } catch {
    return null;
  }
}

async function verifySignature(
  secrets: DerivedSecretsConfig,
  encodedPayload: string,
  encodedSig: string,
): Promise<boolean> {
  const signatureBytes = base64urlDecode(encodedSig);
  const data = textEncoder.encode(encodedPayload);

  const keys = [
    secrets.current.key,
    ...secrets.fallbacks.map((entry) => entry.key),
  ];
  for (const key of keys) {
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      data,
    );
    if (verified) return true;
  }
  return false;
}

export async function issueChallenge(
  secrets: DerivedSecretsConfig,
  params: { serverId?: string; keyId?: string } = {},
  ttlMs: number,
  nowMs = Date.now(),
): Promise<DaemonChallenge> {
  const nonce = crypto.randomUUID();
  const payload: ChallengePayload = {
    nonce,
    issuedAtMs: nowMs,
    ttlMs,
    serverId: params.serverId ?? "",
    keyId: params.keyId ?? "",
  };
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    secrets.current.key,
    textEncoder.encode(encodedPayload),
  );
  const encodedSig = base64urlEncode(new Uint8Array(signature));
  const challengeId = `${encodedPayload}.${encodedSig}`;

  return {
    id: challengeId,
    nonce,
    at: new Date(nowMs).toISOString(),
  };
}

export async function consumeChallenge(
  secrets: DerivedSecretsConfig,
  params: {
    challengeId: string;
    serverId?: string;
    keyId?: string;
  },
  ttlMs: number,
  nowMs = Date.now(),
): Promise<DaemonChallenge | null> {
  const parts = params.challengeId.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  const verified = await verifySignature(secrets, encodedPayload, encodedSig);
  if (!verified) return null;

  const payload = parsePayload(encodedPayload);
  if (!payload) return null;

  const effectiveTtlMs = payload.ttlMs > 0 ? payload.ttlMs : ttlMs;
  if (nowMs - payload.issuedAtMs > effectiveTtlMs) return null;

  const expectedServerId = params.serverId ?? "";
  const expectedKeyId = params.keyId ?? "";
  if (payload.serverId !== expectedServerId) return null;
  if (payload.keyId !== expectedKeyId) return null;

  return {
    id: params.challengeId,
    nonce: payload.nonce,
    at: new Date(payload.issuedAtMs).toISOString(),
  };
}

export function createStatelessChallengeStore(
  secrets: DerivedSecretsConfig,
  ttlMs: number,
): DaemonChallengeStore {
  return {
    ttlMs,

    issue(params = {}) {
      return issueChallenge(secrets, params, ttlMs);
    },

    consume(params) {
      return consumeChallenge(secrets, params, ttlMs);
    },
  };
}
