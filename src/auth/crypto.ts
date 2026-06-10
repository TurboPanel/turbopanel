import type { DerivedSecretsConfig } from "./secrets.ts";

export type VerifyResult = {
  token: string;
  rotated: boolean;
};

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
  if (secrets.current.version !== null) {
    return `${token}.v${secrets.current.version}.${sig}`;
  }
  return `${token}.${sig}`;
}

export async function verifySignedCookie(
  cookieValue: string,
  secrets: DerivedSecretsConfig,
): Promise<VerifyResult | null> {
  const segments = cookieValue.split(".");

  if (segments.length === 3) {
    const [token, versionSegment, providedSig] = segments;
    if (!token || !versionSegment || !providedSig) return null;
    if (!versionSegment.startsWith("v")) return null;

    const versionDigits = versionSegment.slice(1);
    if (versionDigits.length === 0 || !/^\d+$/.test(versionDigits)) return null;

    const version = Number.parseInt(versionDigits, 10);
    if (!Number.isInteger(version)) return null;

    let matchedKey: CryptoKey | null = null;
    if (secrets.current.version === version) {
      matchedKey = secrets.current.key;
    } else {
      const fallback = secrets.fallbacks.find((f) => f.version === version);
      if (fallback) matchedKey = fallback.key;
    }
    if (matchedKey === null) return null;

    const expectedSig = await signToken(token, matchedKey);
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

    return { token, rotated: matchedKey !== secrets.current.key };
  }

  if (segments.length === 2) {
    const [token, providedSig] = segments;
    if (!token || !providedSig) return null;

    const verifyWithKey = async (key: CryptoKey): Promise<boolean> => {
      const expectedSig = await signToken(token, key);
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
      for (let i = 0; i < providedBytes.length; i++) {
        diff |= providedBytes[i] ^ expectedBytes[i];
      }
      return diff === 0;
    };

    if (secrets.legacyKey !== null && await verifyWithKey(secrets.legacyKey)) {
      return { token, rotated: secrets.legacyKey !== secrets.current.key };
    }
    if (await verifyWithKey(secrets.current.key)) {
      return { token, rotated: secrets.current.version !== null };
    }
    return null;
  }

  return null;
}
