import type { DaemonJwtKeyring } from "./daemon-jwt-keyring.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DAEMON_JWT_LIFETIME_MS = 15 * 60 * 1000;
export const DAEMON_JWT_AUD = "turbopanel-daemon-api";
export const DAEMON_JWT_ISS = "turbopanel";
export const DAEMON_JWT_TYP = "daemon";

export type DaemonJwtPayload = {
  sub: string;
  kid: string;
  jti: string;
  iss: string;
  aud: string;
  typ: string;
  iat: number;
  exp: number;
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

function base64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i)!;
  }
  return bytes;
}

function parseJson<T>(encoded: string): T | null {
  try {
    const bytes = base64urlDecode(encoded);
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function issueDaemonJwt(
  payload: Pick<DaemonJwtPayload, "sub" | "kid">,
  keyring: DaemonJwtKeyring,
  nowMs = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + DAEMON_JWT_LIFETIME_MS) / 1000);
  const fullPayload: DaemonJwtPayload = {
    ...payload,
    jti: crypto.randomUUID(),
    iss: DAEMON_JWT_ISS,
    aud: DAEMON_JWT_AUD,
    typ: DAEMON_JWT_TYP,
    iat,
    exp,
  };
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: keyring.active.kid,
  };
  const encodedHeader = base64urlEncode(
    textEncoder.encode(JSON.stringify(header)),
  );
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(fullPayload)),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyring.active.privateKey,
    textEncoder.encode(signingInput),
  );
  const encodedSig = base64urlEncode(new Uint8Array(signature));

  return {
    token: `${encodedHeader}.${encodedPayload}.${encodedSig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyDaemonJwt(
  token: string,
  keyring: DaemonJwtKeyring,
): Promise<DaemonJwtPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSig] = parts;
    const header = parseJson<{ alg?: string; kid?: string }>(encodedHeader);
    if (header?.alg !== "EdDSA" || typeof header?.kid !== "string") {
      return null;
    }

    const key = keyring.verifiers.get(header.kid);
    if (!key) return null;

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signatureBytes = base64urlDecode(encodedSig);
    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      textEncoder.encode(signingInput),
    );
    if (!verified) return null;

    const payload = parseJson<DaemonJwtPayload>(encodedPayload);
    if (!payload) return null;
    if (payload.iss !== DAEMON_JWT_ISS) return null;
    if (payload.aud !== DAEMON_JWT_AUD) return null;
    if (payload.typ !== DAEMON_JWT_TYP) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
