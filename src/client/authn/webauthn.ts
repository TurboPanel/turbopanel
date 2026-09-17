/**
 * Dependency-free WebAuthn helpers (CBOR, authenticator data, assertion
 * verify). Workers-bundle-safe: no `crypto.subtle` / `fetch` at module load.
 *
 * Credential IDs are stored and compared as unpadded base64url of the raw
 * credential-id bytes from authenticator data.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const AUTH_DATA_FLAG_UP = 0x01;
export const AUTH_DATA_FLAG_UV = 0x04;
export const AUTH_DATA_FLAG_BE = 0x08;
export const AUTH_DATA_FLAG_BS = 0x10;
export const AUTH_DATA_FLAG_AT = 0x40;

const RP_ID_HASH_LEN = 32;
const AAGUID_LEN = 16;
const COUNTER_LEN = 4;
const ECDSA_P256_COMPONENT_LEN = 32;
const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_ALG_ES256 = -7;
const COSE_ALG_RS256 = -257;
const COSE_EC_CRV_P256 = 1;

export type CoseEcJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type CoseRsaJwk = {
  kty: "RSA";
  n: string;
  e: string;
  alg: "RS256";
};

export type CosePublicJwk = CoseEcJwk | CoseRsaJwk;

export type ParsedAuthenticatorData = {
  rpIdHash: Uint8Array;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backupState: boolean;
  attestedCredentialDataIncluded: boolean;
  counter: number;
  attested?: {
    aaguid: Uint8Array;
    credentialId: Uint8Array;
    coseKeyBytes: Uint8Array;
  };
};

export type ParsedAttestationObject = {
  fmt: string;
  authData: Uint8Array;
  attStmt: unknown;
};

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

export function base64urlDecode(input: string): Uint8Array {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

type CborDecode = { value: unknown; offset: number };

function readCborUint(
  bytes: Uint8Array,
  offset: number,
  additional: number,
): { value: number; offset: number } {
  if (additional < 24) {
    return { value: additional, offset };
  }
  if (additional === 24) {
    return { value: bytes[offset]!, offset: offset + 1 };
  }
  if (additional === 25) {
    return {
      value: (bytes[offset]! << 8) | bytes[offset + 1]!,
      offset: offset + 2,
    };
  }
  if (additional === 26) {
    const value = ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>> 0;
    return { value, offset: offset + 4 };
  }
  if (additional === 27) {
    // 64-bit integers used as CBOR lengths/values must fit JS number.
    let value = 0;
    for (let i = 0; i < 8; i += 1) {
      value = value * 256 + bytes[offset + i]!;
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("CBOR integer exceeds safe integer range");
    }
    return { value, offset: offset + 8 };
  }
  throw new TypeError("unsupported CBOR additional information");
}

function decodeCborAt(bytes: Uint8Array, offset: number): CborDecode {
  if (offset >= bytes.length) {
    throw new TypeError("unexpected end of CBOR");
  }
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let cursor = offset + 1;

  if (major === 0) {
    const decoded = readCborUint(bytes, cursor, additional);
    return { value: decoded.value, offset: decoded.offset };
  }
  if (major === 1) {
    const decoded = readCborUint(bytes, cursor, additional);
    return { value: -1 - decoded.value, offset: decoded.offset };
  }
  if (major === 2 || major === 3) {
    const decoded = readCborUint(bytes, cursor, additional);
    const start = decoded.offset;
    const end = start + decoded.value;
    if (end > bytes.length) {
      throw new TypeError("CBOR byte/text string overruns buffer");
    }
    const slice = bytes.subarray(start, end);
    if (major === 2) {
      return { value: slice, offset: end };
    }
    return { value: textDecoder.decode(slice), offset: end };
  }
  if (major === 4) {
    const decoded = readCborUint(bytes, cursor, additional);
    cursor = decoded.offset;
    const items: unknown[] = [];
    for (let i = 0; i < decoded.value; i += 1) {
      const item = decodeCborAt(bytes, cursor);
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const decoded = readCborUint(bytes, cursor, additional);
    cursor = decoded.offset;
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < decoded.value; i += 1) {
      const key = decodeCborAt(bytes, cursor);
      const value = decodeCborAt(bytes, key.offset);
      map.set(key.value, value.value);
      cursor = value.offset;
    }
    return { value: map, offset: cursor };
  }
  throw new TypeError(`unsupported CBOR major type ${major}`);
}

/** Decode a single CBOR item from `bytes` starting at `offset` (default 0). */
export function decodeCbor(bytes: Uint8Array, offset = 0): CborDecode {
  return decodeCborAt(bytes, offset);
}

function requireCborMap(value: unknown, label: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new TypeError(`${label} is not a CBOR map`);
  }
  return value;
}

function mapGet(map: Map<unknown, unknown>, key: string | number): unknown {
  return map.get(key);
}

function requireByteString(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} is not a CBOR byte string`);
  }
  return value;
}

export function parseAttestationObject(
  attestationObjectBytes: Uint8Array,
): ParsedAttestationObject {
  const decoded = decodeCbor(attestationObjectBytes);
  const map = requireCborMap(decoded.value, "attestationObject");
  const fmt = mapGet(map, "fmt");
  if (typeof fmt !== "string" || fmt.length === 0) {
    throw new TypeError("attestationObject.fmt is missing");
  }
  const authData = requireByteString(mapGet(map, "authData"), "authData");
  const attStmt = mapGet(map, "attStmt") ?? new Map();
  return { fmt, authData, attStmt };
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!) >>> 0;
}

export function parseAuthenticatorData(
  authData: Uint8Array,
): ParsedAuthenticatorData {
  const minLen = RP_ID_HASH_LEN + 1 + COUNTER_LEN;
  if (authData.length < minLen) {
    throw new TypeError("authenticator data is truncated");
  }
  const rpIdHash = authData.subarray(0, RP_ID_HASH_LEN);
  const flags = authData[RP_ID_HASH_LEN]!;
  const counter = readUint32(authData, RP_ID_HASH_LEN + 1);
  const parsed: ParsedAuthenticatorData = {
    rpIdHash,
    flags,
    userPresent: (flags & AUTH_DATA_FLAG_UP) !== 0,
    userVerified: (flags & AUTH_DATA_FLAG_UV) !== 0,
    backupEligible: (flags & AUTH_DATA_FLAG_BE) !== 0,
    backupState: (flags & AUTH_DATA_FLAG_BS) !== 0,
    attestedCredentialDataIncluded: (flags & AUTH_DATA_FLAG_AT) !== 0,
    counter,
  };

  if (!parsed.attestedCredentialDataIncluded) {
    return parsed;
  }

  const attestedOffset = minLen;
  const credHeaderEnd = attestedOffset + AAGUID_LEN + 2;
  if (authData.length < credHeaderEnd) {
    throw new TypeError("attested credential data is truncated");
  }
  const aaguid = authData.subarray(attestedOffset, attestedOffset + AAGUID_LEN);
  const credentialIdLength = readUint16(
    authData,
    attestedOffset + AAGUID_LEN,
  );
  const credIdStart = credHeaderEnd;
  const credIdEnd = credIdStart + credentialIdLength;
  if (authData.length < credIdEnd) {
    throw new TypeError("attested credential id is truncated");
  }
  const credentialId = authData.subarray(credIdStart, credIdEnd);
  const coseStart = credIdEnd;
  const cose = decodeCbor(authData, coseStart);
  const coseKeyBytes = authData.subarray(coseStart, cose.offset);
  parsed.attested = { aaguid, credentialId, coseKeyBytes };
  return parsed;
}

function requireCoseBytes(
  map: Map<unknown, unknown>,
  key: number,
  label: string,
): Uint8Array {
  return requireByteString(mapGet(map, key), label);
}

function coseEcJwk(map: Map<unknown, unknown>, crv: unknown): CoseEcJwk {
  if (crv !== COSE_EC_CRV_P256) {
    throw new TypeError("unsupported COSE EC curve");
  }
  const x = requireCoseBytes(map, -2, "COSE x");
  const y = requireCoseBytes(map, -3, "COSE y");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(x),
    y: base64urlEncode(y),
  };
}

function coseRsaJwk(map: Map<unknown, unknown>): CoseRsaJwk {
  const n = requireCoseBytes(map, -1, "COSE n");
  const e = requireCoseBytes(map, -2, "COSE e");
  return {
    kty: "RSA",
    n: base64urlEncode(n),
    e: base64urlEncode(e),
    alg: "RS256",
  };
}

export function coseKeyToJwk(coseKeyBytes: Uint8Array): CosePublicJwk {
  const decoded = decodeCbor(coseKeyBytes);
  const map = requireCborMap(decoded.value, "COSE key");
  const kty = mapGet(map, 1);
  const alg = mapGet(map, 3);
  if (kty === COSE_KTY_EC2 && alg === COSE_ALG_ES256) {
    return coseEcJwk(map, mapGet(map, -1));
  }
  if (kty === COSE_KTY_RSA && alg === COSE_ALG_RS256) {
    return coseRsaJwk(map);
  }
  throw new TypeError("unsupported COSE key type or algorithm");
}

function readDerLength(
  der: Uint8Array,
  offset: number,
): { length: number; offset: number } {
  const first = der[offset]!;
  if (first < 0x80) {
    return { length: first, offset: offset + 1 };
  }
  const count = first & 0x7f;
  if (count === 0 || count > 2) {
    throw new TypeError("unsupported DER length");
  }
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    length = (length << 8) | der[offset + 1 + i]!;
  }
  return { length, offset: offset + 1 + count };
}

function readDerInteger(
  der: Uint8Array,
  offset: number,
): { bytes: Uint8Array; offset: number } {
  if (der[offset] !== 0x02) {
    throw new TypeError("DER INTEGER tag missing");
  }
  const len = readDerLength(der, offset + 1);
  const start = len.offset;
  const end = start + len.length;
  if (end > der.length) {
    throw new TypeError("DER INTEGER overruns buffer");
  }
  return { bytes: der.subarray(start, end), offset: end };
}

function padComponent(intBytes: Uint8Array, componentLen: number): Uint8Array {
  let start = 0;
  while (start < intBytes.length - 1 && intBytes[start] === 0) {
    start += 1;
  }
  const stripped = intBytes.subarray(start);
  if (stripped.length > componentLen) {
    throw new TypeError("ECDSA component exceeds expected length");
  }
  const out = new Uint8Array(componentLen);
  out.set(stripped, componentLen - stripped.length);
  return out;
}

/**
 * Convert a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs) to raw r‖s.
 */
export function derToRawEcdsaSignature(
  der: Uint8Array,
  componentLen = ECDSA_P256_COMPONENT_LEN,
): Uint8Array {
  if (der[0] !== 0x30) {
    throw new TypeError("ECDSA signature is not a DER SEQUENCE");
  }
  const seq = readDerLength(der, 1);
  const r = readDerInteger(der, seq.offset);
  const s = readDerInteger(der, r.offset);
  const raw = new Uint8Array(componentLen * 2);
  raw.set(padComponent(r.bytes, componentLen), 0);
  raw.set(padComponent(s.bytes, componentLen), componentLen);
  return raw;
}

/**
 * Normalize an ES256 assertion signature to the raw r‖s form WebCrypto
 * verifies. Authenticators send DER (SEQUENCE of two INTEGERs, ≥ 70 bytes for
 * P-256 once the sign-bit padding is counted); test doubles and some libraries
 * send raw r‖s. Length is the only reliable discriminator — one raw signature
 * in 256 starts with 0x30 (the SEQUENCE tag), and treating that as DER made
 * the login verify fail once in a while.
 */
export function ecdsaSignatureForVerify(signature: Uint8Array): Uint8Array {
  if (signature.length === ECDSA_P256_COMPONENT_LEN * 2) {
    return signature;
  }
  return derToRawEcdsaSignature(signature);
}

async function sha256(data: BufferSource): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function importVerifyKey(
  jwk: CosePublicJwk,
): Promise<{ key: CryptoKey; algorithm: AlgorithmIdentifier | EcdsaParams }> {
  if (jwk.kty === "EC") {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { key, algorithm: { name: "ECDSA", hash: "SHA-256" } };
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return { key, algorithm: { name: "RSASSA-PKCS1-v1_5" } };
}

export async function verifyAssertion(params: {
  jwk: CosePublicJwk;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  const { key, algorithm } = await importVerifyKey(params.jwk);
  const clientHash = await sha256(params.clientDataJSON as BufferSource);
  const signed = concatBytes(params.authData, clientHash);
  const signature = params.jwk.kty === "EC"
    ? ecdsaSignatureForVerify(params.signature)
    : params.signature;
  return crypto.subtle.verify(
    algorithm,
    key,
    signature as BufferSource,
    signed as BufferSource,
  );
}

export async function verifyRpIdHash(
  authData: Uint8Array,
  expectedRpId: string,
): Promise<boolean> {
  const parsed = parseAuthenticatorData(authData);
  const expected = await sha256(textEncoder.encode(expectedRpId));
  if (parsed.rpIdHash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= parsed.rpIdHash[i]! ^ expected[i]!;
  }
  return diff === 0;
}

/** Format 16-byte AAGUID as a dashed UUID string. */
export function aaguidToUuid(aaguid: Uint8Array): string {
  if (aaguid.length !== AAGUID_LEN) {
    throw new TypeError("AAGUID must be 16 bytes");
  }
  const hex = Array.from(aaguid, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) {
    return textEncoder.encode(uuid);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  return aaguidToUuid(bytes);
}
