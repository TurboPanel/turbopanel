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
 * Resolve cookie name + Secure flag from proxy headers first, then the request URL.
 * Deno unix sockets behind Caddy use `http+unix://` URLs while `X-Forwarded-Proto` is `https`.
 */
export function resolveRequestTls(
  requestUrl: string,
  forwardedProto?: string | null,
): RequestTls {
  const normalized = forwardedProto?.trim().toLowerCase();
  if (normalized === "https" || normalized === "http") {
    return tlsFromProtocol(`${normalized}:`)!;
  }

  try {
    const resolved = tlsFromProtocol(new URL(requestUrl).protocol);
    if (resolved) return resolved;
  } catch {
    // fall through
  }

  return { isHttps: false, cookieName: HTTP_SESSION_COOKIE_NAME };
}

/** `http:` → {@link HTTP_SESSION_COOKIE_NAME}; `https:` → {@link HTTPS_SESSION_COOKIE_NAME}. */
export function resolveSessionCookieName(
  requestUrl: string,
  forwardedProto?: string | null,
): string {
  return resolveRequestTls(requestUrl, forwardedProto).cookieName;
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

  if (typeof timingSafeEqual === "function") {
    return timingSafeEqual(providedBytes, expectedBytes);
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
