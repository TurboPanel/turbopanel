const textEncoder = new TextEncoder();

function decodeBase64Url(input: string): Uint8Array {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function buildEnrollmentPayload(params: {
  challengeId: string;
  nonce: string;
  licenseId: string;
  machineId: string;
  hostname: string;
  publicKeyFingerprint: string;
}): string {
  return [
    "turbopanel-daemon-enroll-v1",
    params.challengeId,
    params.nonce,
    params.licenseId,
    params.machineId,
    params.hostname,
    params.publicKeyFingerprint,
  ].join("\n");
}

export function buildAuthPayload(params: {
  challengeId: string;
  nonce: string;
  serverId: string;
  keyId: string;
  machineId: string;
  hostname: string;
}): string {
  return [
    "turbopanel-daemon-auth-v1",
    params.challengeId,
    params.nonce,
    params.serverId,
    params.keyId,
    params.machineId,
    params.hostname,
  ].join("\n");
}

export async function computePublicKeyFingerprint(
  publicJwk: JsonWebKey,
): Promise<string> {
  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  };
  const canonicalJson = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson),
  );
  return encodeHex(new Uint8Array(digest));
}

export async function verifyDaemonSignature(
  publicJwk: JsonWebKey,
  payload: string,
  signatureB64url: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signatureBytes = new Uint8Array(decodeBase64Url(signatureB64url));
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      textEncoder.encode(payload),
    );
  } catch {
    return false;
  }
}
