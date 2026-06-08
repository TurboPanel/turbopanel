function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export const SESSION_COOKIE_NAME = "tp_session";

export const SESSION_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function signToken(token: string, secret: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tokenBytes = new TextEncoder().encode(token);
  const result = await crypto.subtle.sign("HMAC", key, tokenBytes);
  return base64urlEncode(new Uint8Array(result));
}

export async function buildSignedCookie(
  token: string,
  secret: string,
): Promise<string> {
  return `${token}.${await signToken(token, secret)}`;
}

export async function verifySignedCookie(
  cookieValue: string,
  secret: string,
): Promise<string | null> {
  const lastDot = cookieValue.lastIndexOf(".");
  if (lastDot === -1) return null;

  const token = cookieValue.slice(0, lastDot);
  const providedSig = cookieValue.slice(lastDot + 1);
  if (!token || !providedSig) return null;

  const expectedSig = await signToken(token, secret);

  const providedBytes = new TextEncoder().encode(providedSig);
  const expectedBytes = new TextEncoder().encode(expectedSig);
  if (providedBytes.length !== expectedBytes.length) return null;

  const timingSafeEqual = (crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  }).timingSafeEqual;

  if (typeof timingSafeEqual === "function") {
    if (!timingSafeEqual(providedBytes, expectedBytes)) return null;
  } else {
    let diff = 0;
    for (let i = 0; i < providedBytes.length; i++) {
      diff |= providedBytes[i] ^ expectedBytes[i];
    }
    if (diff !== 0) return null;
  }

  return token;
}
