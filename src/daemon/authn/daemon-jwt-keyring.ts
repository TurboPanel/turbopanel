import type { SecretsConfig } from "../../client/authn/secrets.ts";

const textEncoder = new TextEncoder();

const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

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

async function deriveEd25519KeyPairFromSecret(rootSecret: string): Promise<{
  kid: string;
  privateKey: CryptoKey;
  verifyKey: CryptoKey;
  publicJwk: JsonWebKey;
}> {
  const keyMaterial = textEncoder.encode(rootSecret);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const seedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode("turbopanel"),
      info: textEncoder.encode("daemon-jwt-eddsa"),
    },
    hkdfKey,
    256,
  );
  const seed = new Uint8Array(seedBits);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    true,
    ["sign"],
  );

  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: privateJwk.x,
  };

  const verifyKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(JSON.stringify(canonical)),
  );
  const kid = base64urlEncode(new Uint8Array(digest));

  return { kid, privateKey, verifyKey, publicJwk };
}

export type DaemonJwtKeyring = {
  active: { kid: string; privateKey: CryptoKey };
  verifiers: Map<string, CryptoKey>;
  publicJwks: JsonWebKey[];
};

export async function deriveDaemonJwtKeyring(
  config: SecretsConfig,
): Promise<DaemonJwtKeyring> {
  if (config.versioned.length === 0) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET or TURBOPANEL_SECRETS",
    );
  }

  const entries = await Promise.all(
    config.versioned.map((entry) =>
      deriveEd25519KeyPairFromSecret(entry.value)
    ),
  );

  const verifiers = new Map<string, CryptoKey>();
  const publicJwks: JsonWebKey[] = entries.map(
    ({ kid, verifyKey, publicJwk }) => {
      verifiers.set(kid, verifyKey);
      return {
        kty: "OKP",
        crv: "Ed25519",
        x: publicJwk.x,
        kid,
        use: "sig",
        alg: "EdDSA",
      };
    },
  );

  const first = entries[0];
  return {
    active: { kid: first.kid, privateKey: first.privateKey },
    verifiers,
    publicJwks,
  };
}

export function buildJwksDocument(
  keyring: DaemonJwtKeyring,
): { keys: JsonWebKey[] } {
  return { keys: keyring.publicJwks };
}
