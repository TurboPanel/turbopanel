import { assertEquals, assertThrows } from "@std/assert";
import {
  AUTH_DATA_FLAG_AT,
  AUTH_DATA_FLAG_BE,
  AUTH_DATA_FLAG_BS,
  AUTH_DATA_FLAG_UP,
  AUTH_DATA_FLAG_UV,
  base64urlDecode,
  coseKeyToJwk,
  decodeCbor,
  derToRawEcdsaSignature,
  ecdsaSignatureForVerify,
  parseAttestationObject,
  parseAuthenticatorData,
  verifyAssertion,
  type CosePublicJwk,
} from "./webauthn.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const textEncoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) {
    return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  }
  return new Uint8Array([
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function encodeCbor(value: unknown): Uint8Array {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError("CBOR encoder only supports integers");
    }
    if (value >= 0) return encodeHead(0, value);
    return encodeHead(1, -1 - value);
  }
  if (value instanceof Uint8Array) {
    return concat(encodeHead(2, value.length), value);
  }
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    return concat(encodeHead(3, bytes.length), bytes);
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => encodeCbor(entry));
    return concat(encodeHead(4, items.length), ...items);
  }
  if (value instanceof Map) {
    const pairs: Uint8Array[] = [];
    for (const [key, entry] of value.entries()) {
      pairs.push(encodeCbor(key), encodeCbor(entry));
    }
    return concat(encodeHead(5, value.size), ...pairs);
  }
  throw new TypeError("unsupported CBOR value");
}

function encodeUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function encodeUint16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  const encodeInt = (component: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < component.length - 1 && component[start] === 0) {
      start += 1;
    }
    let bytes = component.subarray(start);
    if ((bytes[0]! & 0x80) !== 0) {
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes, 1);
      bytes = padded;
    }
    return concat(new Uint8Array([0x02, bytes.length]), bytes);
  };
  const rEnc = encodeInt(raw.subarray(0, 32));
  const sEnc = encodeInt(raw.subarray(32));
  const body = concat(rEnc, sEnc);
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function generateEs256(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function jwkFromPublic(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

function coseEs256FromJwk(jwk: JsonWebKey): Uint8Array {
  const map = new Map<unknown, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, base64urlDecode(jwk.x!)],
    [-3, base64urlDecode(jwk.y!)],
  ]);
  return encodeCbor(map);
}

function coseEcJwk(jwk: JsonWebKey): CosePublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
}

async function signRawEcdsa(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    data as BufferSource,
  );
  return new Uint8Array(signature);
}

async function signedPayload(
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
): Promise<Uint8Array> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSON as BufferSource),
  );
  return concat(authData, hash);
}

test("CBOR decoder reads unsigned, negative, bytes, text, arrays, and maps", () => {
  assertEquals(decodeCbor(new Uint8Array([0x05])).value, 5);
  assertEquals(decodeCbor(new Uint8Array([0x18, 0x18])).value, 24);
  assertEquals(decodeCbor(new Uint8Array([0x20])).value, -1);
  assertEquals(
    Array.from(decodeCbor(new Uint8Array([0x43, 1, 2, 3])).value as Uint8Array),
    [1, 2, 3],
  );
  assertEquals(
    decodeCbor(new Uint8Array([0x63, 0x61, 0x62, 0x63])).value,
    "abc",
  );
  assertEquals(decodeCbor(new Uint8Array([0x82, 0x01, 0x02])).value, [1, 2]);
  const map = decodeCbor(new Uint8Array([0xa1, 0x61, 0x61, 0x01])).value as Map<
    unknown,
    unknown
  >;
  assertEquals(map.get("a"), 1);
});

test("parseAuthenticatorData extracts flag bits and attested credential data", () => {
  const rpIdHash = new Uint8Array(32).fill(7);
  const aaguid = new Uint8Array(16).fill(9);
  const credentialId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const cose = encodeCbor(
    new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1]]),
  );
  const flags = AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV | AUTH_DATA_FLAG_BE |
    AUTH_DATA_FLAG_BS | AUTH_DATA_FLAG_AT;
  const authData = concat(
    rpIdHash,
    new Uint8Array([flags]),
    encodeUint32(42),
    aaguid,
    encodeUint16(credentialId.length),
    credentialId,
    cose,
  );
  const parsed = parseAuthenticatorData(authData);
  assertEquals(parsed.userPresent, true);
  assertEquals(parsed.userVerified, true);
  assertEquals(parsed.backupEligible, true);
  assertEquals(parsed.backupState, true);
  assertEquals(parsed.attestedCredentialDataIncluded, true);
  assertEquals(parsed.counter, 42);
  assertEquals(Array.from(parsed.attested!.credentialId), [0xde, 0xad, 0xbe, 0xef]);
});

test("parseAttestationObject accepts fmt none without verifying attStmt", () => {
  const authData = concat(
    new Uint8Array(32),
    new Uint8Array([AUTH_DATA_FLAG_UP]),
    encodeUint32(0),
  );
  const encoded = encodeCbor(
    new Map<unknown, unknown>([
      ["fmt", "none"],
      ["authData", authData],
      ["attStmt", new Map()],
    ]),
  );
  const parsed = parseAttestationObject(encoded);
  assertEquals(parsed.fmt, "none");
  assertEquals(parsed.authData.length, authData.length);
});

test("verifyAssertion accepts ES256 raw and DER signatures and rejects tampering", async () => {
  const pair = await generateEs256();
  const jwk = await jwkFromPublic(pair.publicKey);
  const authData = concat(
    new Uint8Array(32).fill(1),
    new Uint8Array([AUTH_DATA_FLAG_UP | AUTH_DATA_FLAG_UV]),
    encodeUint32(1),
  );
  const clientDataJSON = textEncoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "abc",
      origin: "https://panel.example.com",
    }),
  );
  const signed = await signedPayload(authData, clientDataJSON);
  const rawSig = await signRawEcdsa(pair.privateKey, signed);
  const coseJwk = coseEcJwk(jwk);

  assertEquals(
    await verifyAssertion({
      jwk: coseJwk,
      authData,
      clientDataJSON,
      signature: rawSig,
    }),
    true,
  );

  const der = rawToDerEcdsa(rawSig);
  assertEquals(derToRawEcdsaSignature(der).length, 64);
  assertEquals(ecdsaSignatureForVerify(der), derToRawEcdsaSignature(der));
  // A raw r‖s whose r starts with the DER SEQUENCE tag is still raw — the
  // 64-byte length decides, not the first byte (this was a 1-in-256 CI flake).
  const rawWithSequenceTag = new Uint8Array(rawSig);
  rawWithSequenceTag[0] = 0x30;
  assertEquals(ecdsaSignatureForVerify(rawWithSequenceTag), rawWithSequenceTag);
  assertEquals(
    await verifyAssertion({
      jwk: coseJwk,
      authData,
      clientDataJSON,
      signature: der,
    }),
    true,
  );

  const tampered = textEncoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "nope",
      origin: "https://panel.example.com",
    }),
  );
  assertEquals(
    await verifyAssertion({
      jwk: coseJwk,
      authData,
      clientDataJSON: tampered,
      signature: rawSig,
    }),
    false,
  );
});

test("verifyAssertion accepts RS256 signatures", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await jwkFromPublic(pair.publicKey);
  const authData = concat(
    new Uint8Array(32).fill(2),
    new Uint8Array([AUTH_DATA_FLAG_UV]),
    encodeUint32(0),
  );
  const clientDataJSON = textEncoder.encode('{"type":"webauthn.get"}');
  const signed = await signedPayload(authData, clientDataJSON);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      signed as BufferSource,
    ),
  );
  assertEquals(
    await verifyAssertion({
      jwk: { kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256" },
      authData,
      clientDataJSON,
      signature,
    }),
    true,
  );
});

test("coseKeyToJwk maps ES256 and rejects unknown algorithms", async () => {
  const pair = await generateEs256();
  const jwk = await jwkFromPublic(pair.publicKey);
  const converted = coseKeyToJwk(coseEs256FromJwk(jwk));
  assertEquals(converted.kty, "EC");
  if (converted.kty === "EC") {
    assertEquals(converted.x, jwk.x);
    assertEquals(converted.y, jwk.y);
  }
  assertThrows(
    () => coseKeyToJwk(encodeCbor(new Map<unknown, unknown>([[1, 1], [3, -8]]))),
    TypeError,
  );
});
