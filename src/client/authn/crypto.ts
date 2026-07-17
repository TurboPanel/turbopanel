import type { DerivedSecretsConfig } from "./secrets.ts";

export type VerifyResult = {
  token: string;
  rotated: boolean;
};

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

export const HTTP_SESSION_COOKIE_NAME = "turbopanel.session_token";

export const HTTPS_SESSION_COOKIE_NAME = "__Secure-turbopanel.session_token";

export type RequestTls = {
  isHttps: boolean;
  cookieName: string;
};

function tlsFromProtocol(protocol: string): RequestTls | null {
  if (protocol === "http:") {
    return { isHttps: false, cookieName: HTTP_SESSION_COOKIE_NAME };
  }
  if (protocol === "https:") {
    return { isHttps: true, cookieName: HTTPS_SESSION_COOKIE_NAME };
  }
  return null;
}

/**
 * URL-derived TLS state. This is the platform-trusted signal on Cloudflare
 * Workers (the request URL scheme reflects the real client connection) and the
 * fallback for the Deno trusted-proxy path. It never consults request headers,
 * so a spoofed `X-Forwarded-Proto` cannot influence it.
 */
export function resolveRequestTlsFromUrl(requestUrl: string): RequestTls {
  try {
    const resolved = tlsFromProtocol(new URL(requestUrl).protocol);
    if (resolved) return resolved;
  } catch {
    // fall through to the safe default
  }
  return { isHttps: false, cookieName: HTTP_SESSION_COOKIE_NAME };
}

/**
 * Trusted-proxy TLS resolution for the **Deno Caddy-over-Unix-socket entrypoint
 * only**. Caddy terminates TLS and forwards the request over a local Unix socket,
 * so the request URL is `http+unix://…` / `http://…` while `X-Forwarded-Proto`
 * carries the real client scheme set by the trusted local proxy.
 *
 * This is the ONLY resolver permitted to honor `X-Forwarded-Proto`. It must
 * never be used for a publicly-reachable listener (e.g. Workers), where the
 * header is client-controlled and could downgrade the session cookie to the
 * non-`Secure` HTTP name.
 */
export function resolveTrustedProxyRequestTls(
  requestUrl: string,
  forwardedProto?: string | null,
): RequestTls {
  const normalized = forwardedProto?.trim().toLowerCase();
  if (normalized === "https" || normalized === "http") {
    return tlsFromProtocol(`${normalized}:`)!;
  }
  return resolveRequestTlsFromUrl(requestUrl);
}

export type RequestTlsSignal = {
  requestUrl: string;
  runtime: "deno" | "workers";
  /** Raw `X-Forwarded-Proto`; only honored on the Deno trusted-proxy path. */
  forwardedProto?: string | null;
};

/**
 * Runtime-aware TLS resolver for session-cookie security. `X-Forwarded-Proto`
 * is **not** trusted by default:
 *
 * - **Workers:** HTTPS state is derived only from the request URL (a
 *   platform-trusted signal). A spoofed `X-Forwarded-Proto: http` on an HTTPS
 *   request is ignored, so it can never produce the non-`Secure` HTTP cookie
 *   name or omit `Secure`.
 * - **Deno:** uses the trusted-proxy path (local Caddy → Unix socket) and honors
 *   `X-Forwarded-Proto`, falling back to the request URL. The Deno instance only
 *   accepts connections from the local Caddy over the Unix socket, so the header
 *   originates from a trusted proxy.
 */
export function resolveRequestTls(signal: RequestTlsSignal): RequestTls {
  if (signal.runtime === "deno") {
    return resolveTrustedProxyRequestTls(
      signal.requestUrl,
      signal.forwardedProto,
    );
  }
  return resolveRequestTlsFromUrl(signal.requestUrl);
}

/** Runtime-aware session cookie name (see {@link resolveRequestTls}). */
export function resolveSessionCookieName(signal: RequestTlsSignal): string {
  return resolveRequestTls(signal).cookieName;
}

/**
 * URL-only cookie name for documentation / OpenAPI surfaces (Scalar), which
 * only need to display the cookie name derived from the API base URL. This is
 * never a security decision and is never header-influenced.
 */
export function resolveSessionCookieNameFromUrl(requestUrl: string): string {
  return resolveRequestTlsFromUrl(requestUrl).cookieName;
}

export const SESSION_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function signToken(token: string, key: CryptoKey): Promise<string> {
  const tokenBytes = new TextEncoder().encode(token);
  const result = await crypto.subtle.sign("HMAC", key, tokenBytes);
  return base64urlEncode(new Uint8Array(result));
}

export async function buildSignedCookie(
  token: string,
  secrets: DerivedSecretsConfig,
): Promise<string> {
  const sig = await signToken(token, secrets.current.key);
  return `${token}.v${secrets.current.version}.${sig}`;
}

function signaturesEqual(providedSig: string, expectedSig: string): boolean {
  const providedBytes = new TextEncoder().encode(providedSig);
  const expectedBytes = new TextEncoder().encode(expectedSig);
  if (providedBytes.length !== expectedBytes.length) return false;

  const timingSafeEqual = (crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  }).timingSafeEqual;

  // Must be invoked on crypto.subtle — unbound calls throw in Workers (nodejs_compat).
  if (typeof timingSafeEqual === "function") {
    return timingSafeEqual.call(crypto.subtle, providedBytes, expectedBytes);
  }

  let diff = 0;
  for (const [i, byte] of providedBytes.entries()) {
    diff |= byte ^ expectedBytes[i];
  }
  return diff === 0;
}

async function signatureMatches(
  token: string,
  providedSig: string,
  key: CryptoKey,
): Promise<boolean> {
  const expectedSig = await signToken(token, key);
  return signaturesEqual(providedSig, expectedSig);
}

function parseCookieVersion(versionSegment: string): number | null {
  if (!versionSegment.startsWith("v")) return null;

  const versionDigits = versionSegment.slice(1);
  if (versionDigits.length === 0 || !/^\d+$/.test(versionDigits)) return null;

  const version = Number.parseInt(versionDigits, 10);
  return Number.isInteger(version) ? version : null;
}

function findKeyForVersion(
  secrets: DerivedSecretsConfig,
  version: number,
): CryptoKey | null {
  if (secrets.current.version === version) return secrets.current.key;

  const fallback = secrets.fallbacks.find((f) => f.version === version);
  return fallback?.key ?? null;
}

async function verifyVersionedCookie(
  token: string,
  versionSegment: string,
  providedSig: string,
  secrets: DerivedSecretsConfig,
): Promise<VerifyResult | null> {
  const version = parseCookieVersion(versionSegment);
  if (version === null) return null;

  const matchedKey = findKeyForVersion(secrets, version);
  if (matchedKey === null) return null;

  if (!await signatureMatches(token, providedSig, matchedKey)) return null;

  return { token, rotated: matchedKey !== secrets.current.key };
}

export async function verifySignedCookie(
  cookieValue: string,
  secrets: DerivedSecretsConfig,
): Promise<VerifyResult | null> {
  const segments = cookieValue.split(".");

  if (segments.length === 3) {
    const [token, versionSegment, providedSig] = segments;
    if (!token || !versionSegment || !providedSig) return null;
    return verifyVersionedCookie(token, versionSegment, providedSig, secrets);
  }

  return null;
}
