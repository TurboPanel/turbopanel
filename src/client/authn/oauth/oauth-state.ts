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
 *
 * A signed state alone proves the instance minted it, not that the browser
 * presenting it started the flow — an attacker can start a flow and hand the
 * victim the callback link (login CSRF). So `/start` also mints a PKCE
 * verifier, keeps it in an HttpOnly cookie on the starting browser, and signs
 * its S256 challenge into the state as the `nonce`. The callback recomputes
 * the challenge from the cookie and requires it to equal the signed nonce,
 * then proves the same verifier to the provider at the token exchange.
 */


import {
  ENVELOPE_SCHEME_OAUTH_STATE,
  formatEnvelope,
  parseEnvelope,
} from "../../../lib/secrets/envelope.ts";
import {
  deriveSecretsConfig,
  findKeyForVersion,
  type SecretsConfig,
} from "../../../lib/secrets/secrets.ts";
import type { OAuthProviderId } from "./providers.ts";
import { isOAuthProviderId } from "./providers.ts";
import { base64urlDecode, base64urlEncode } from "../../../lib/encoding/base64url.ts";

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

// C0 controls and DEL. Browsers drop TAB/CR/LF from URLs, so "/\t/evil.com"
// becomes the protocol-relative "//evil.com".
// deno-lint-ignore no-control-regex
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSameOriginPathShape(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("://") || value.includes("\\")) return false;
  return !URL_CONTROL_CHARS.test(value);
}

/**
 * Same-origin path only: leading `/`, no scheme/host, no protocol-relative
 * `//`, no backslash, and no control character (TAB, CR, LF, NUL, …) — raw
 * or percent-encoded, since the value may be decoded again downstream.
 */
export function isSafeRedirectPath(value: string): boolean {
  if (!isSameOriginPathShape(value)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  return decoded === value || isSameOriginPathShape(decoded);
}

/** RFC 7636 verifier: 32 random bytes, base64url (43 chars). */
export function mintPkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** RFC 7636 `S256` challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64urlEncode(new Uint8Array(digest));
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
