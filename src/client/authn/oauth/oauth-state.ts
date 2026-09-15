/**
 * CSRF-safe `state` for GitHub / Google OAuth sign-in and account-link redirects.
 *
 * The provider round-trip leaves the instance and comes back on a URL the
 * provider controls, so `state` is the only thing tying the callback to the
 * flow that started it. Keys come from the same HKDF root as sessions
 * (`deriveSecretsConfig(config, purpose)`); the wire format uses the shared
 * envelope grammar (`tpoauth.v<version>.<payloadB64u>.<sigB64u>`).
 *
 * `redirectTo` is a same-origin path (leading `/`, no scheme/host) validated
 * both at sign time and again on verify so a tampered value cannot become an
 * open redirect.
 */

import {
  ENVELOPE_SCHEME_OAUTH_STATE,
  formatEnvelope,
  parseEnvelope,
} from "../envelope.ts";
import {
  deriveSecretsConfig,
  findKeyForVersion,
  type SecretsConfig,
} from "../secrets.ts";
import type { OAuthProviderId } from "./providers.ts";
import { isOAuthProviderId } from "./providers.ts";

/** Distinct from install / 2FA / WebAuthn purposes so states are not interchangeable. */
export const OAUTH_STATE_PURPOSE = "oauth-sign-in-state";

/** Short window: the operator is mid-redirect, not sitting on the link. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type OAuthStateClaims = {
  provider: OAuthProviderId;
  nonce: string;
  redirectTo: string;
  linkUserId?: string;
};

type OAuthStatePayload = OAuthStateClaims & { exp: number };

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

/**
 * Same-origin path only: leading `/`, no scheme/host, no protocol-relative
 * `//`, no backslash or CR/LF that could smuggle a Location header.
 */
export function isSafeRedirectPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("://") || value.includes("\\")) return false;
  if (value.includes("\r") || value.includes("\n")) return false;
  return true;
}

export function mintOAuthNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function signOAuthState(
  secretsConfig: SecretsConfig,
  claims: OAuthStateClaims,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!isSafeRedirectPath(claims.redirectTo)) {
    throw new TypeError("oauth state redirectTo must be a same-origin path");
  }
  const derived = await deriveSecretsConfig(
    secretsConfig,
    OAUTH_STATE_PURPOSE,
  );
  const payload: OAuthStatePayload = {
    provider: claims.provider,
    nonce: claims.nonce,
    redirectTo: claims.redirectTo,
    ...(claims.linkUserId ? { linkUserId: claims.linkUserId } : {}),
    exp: Math.floor((nowMs + OAUTH_STATE_TTL_MS) / 1000),
  };
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    derived.current.key,
    textEncoder.encode(encodedPayload),
  );
  return formatEnvelope(
    ENVELOPE_SCHEME_OAUTH_STATE,
    derived.current.version,
    encodedPayload,
    base64urlEncode(new Uint8Array(signature)),
  );
}

/**
 * Verify the signature, expiry, and redirect path. Returns the claims, or
 * `null` for any malformed / unsigned / expired / unsafe state — never a
 * partially trusted value.
 */
export async function verifyOAuthState(
  secretsConfig: SecretsConfig,
  state: string,
  nowMs: number = Date.now(),
): Promise<OAuthStateClaims | null> {
  const parsed = parseEnvelope(ENVELOPE_SCHEME_OAUTH_STATE, state, 2);
  if (!parsed) return null;

  const derived = await deriveSecretsConfig(
    secretsConfig,
    OAUTH_STATE_PURPOSE,
  );
  const key = findKeyForVersion(derived, parsed.version);
  if (!key) return null;

  const [encodedPayload, encodedSignature] = parsed.fields;
  let signature: Uint8Array;
  let payload: OAuthStatePayload;
  try {
    signature = base64urlDecode(encodedSignature!);
    payload = JSON.parse(
      textDecoder.decode(base64urlDecode(encodedPayload!)),
    ) as OAuthStatePayload;
  } catch {
    return null;
  }

  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    textEncoder.encode(encodedPayload!),
  );
  if (!verified) return null;

  if (!isOAuthProviderId(payload.provider)) return null;
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
    return null;
  }
  if (typeof payload.redirectTo !== "string") return null;
  if (!isSafeRedirectPath(payload.redirectTo)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
    return null;
  }
  if (
    payload.linkUserId !== undefined &&
    (typeof payload.linkUserId !== "string" || payload.linkUserId.length === 0)
  ) {
    return null;
  }

  return {
    provider: payload.provider,
    nonce: payload.nonce,
    redirectTo: payload.redirectTo,
    ...(payload.linkUserId ? { linkUserId: payload.linkUserId } : {}),
  };
}
