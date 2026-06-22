import { decodeBase64Url } from "@std/encoding/base64url"
import { encodeHex } from "@std/encoding/hex"

const textEncoder = new TextEncoder()

export function buildEnrollmentPayload(params: {
  challengeId: string
  nonce: string
  licenseId: string
  machineId: string
  hostname: string
  publicKeyFingerprint: string
}): string {
  return [
    "turbopanel-daemon-enroll-v1",
    params.challengeId,
    params.nonce,
    params.licenseId,
    params.machineId,
    params.hostname,
    params.publicKeyFingerprint,
  ].join("\n")
}

export function buildAuthPayload(params: {
  challengeId: string
  nonce: string
  serverId: string
  keyId: string
  machineId: string
  hostname: string
}): string {
  return [
    "turbopanel-daemon-auth-v1",
    params.challengeId,
    params.nonce,
    params.serverId,
    params.keyId,
    params.machineId,
    params.hostname,
  ].join("\n")
}

/**
 * @deprecated Use `buildAuthPayload()` for daemon auth payloads.
 */
export function buildCanonicalPayload(params: {
  challengeId: string
  nonce: string
  serverId?: string
  keyId?: string
  machineId?: string
  hostname?: string
  fingerprint?: string
}): string {
  // Legacy callers may still pass `fingerprint` from the pre-split helper.
  // Keep that path working by mapping it to auth `keyId`.
  return buildAuthPayload({
    challengeId: params.challengeId,
    nonce: params.nonce,
    serverId: params.serverId ?? "",
    keyId: params.keyId ?? params.fingerprint ?? "",
    machineId: params.machineId ?? "",
    hostname: params.hostname ?? "",
  })
}

export async function computePublicKeyFingerprint(
  publicJwk: JsonWebKey,
): Promise<string> {
  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  }
  const canonicalJson = JSON.stringify(canonical)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson),
  )
  return encodeHex(new Uint8Array(digest))
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
    )
    const signatureBytes = decodeBase64Url(signatureB64url)
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      textEncoder.encode(payload),
    )
  } catch {
    return false
  }
}
