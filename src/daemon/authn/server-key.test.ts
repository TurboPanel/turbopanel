import { assertEquals } from "jsr:@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import {
  buildAuthPayload,
  buildEnrollmentPayload,
  computePublicKeyFingerprint,
  verifyDaemonSignature,
} from "./server-key.ts";

const encoder = new TextEncoder();

async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

async function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey("jwk", key);
}

async function signPayload(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    encoder.encode(payload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("buildEnrollmentPayload renders exact enrollment canonical payload", () => {
  const payload = buildEnrollmentPayload({
    challengeId: "challenge-123",
    nonce: "nonce-456",
    licenseId: "license-789",
    machineKey: "machine-abc",
    hostname: "host.local",
    publicKeyFingerprint: "fingerprint-xyz",
  });
  assertEquals(
    payload,
    "turbopanel-daemon-enroll-v1\nchallenge-123\nnonce-456\nlicense-789\nmachine-abc\nhost.local\nfingerprint-xyz",
  );
});

test("buildAuthPayload renders exact auth canonical payload", () => {
  const payload = buildAuthPayload({
    challengeId: "challenge-123",
    nonce: "nonce-456",
    serverId: "server-789",
    keyId: "key-321",
    machineKey: "machine-abc",
    hostname: "host.local",
  });
  assertEquals(
    payload,
    "turbopanel-daemon-auth-v1\nchallenge-123\nnonce-456\nserver-789\nkey-321\nmachine-abc\nhost.local",
  );
});

test("computePublicKeyFingerprint is deterministic", async () => {
  const keyPair = await generateEd25519KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const first = await computePublicKeyFingerprint(publicJwk);
  const second = await computePublicKeyFingerprint(publicJwk);
  assertEquals(first, second);
});

test("verifyDaemonSignature accepts valid signature", async () => {
  const keyPair = await generateEd25519KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const payload = buildAuthPayload({
    challengeId: "challenge-1",
    nonce: "nonce-1",
    serverId: "server-1",
    keyId: "key-1",
    machineKey: "machine-1",
    hostname: "host-1",
  });
  const signature = await signPayload(keyPair.privateKey, payload);
  const ok = await verifyDaemonSignature(publicJwk, payload, signature);
  assertEquals(ok, true);
});

test("verifyDaemonSignature rejects tampered payload", async () => {
  const keyPair = await generateEd25519KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const payload = buildAuthPayload({
    challengeId: "challenge-2",
    nonce: "nonce-2",
    serverId: "server-2",
    keyId: "key-2",
    machineKey: "machine-2",
    hostname: "host-2",
  });
  const signature = await signPayload(keyPair.privateKey, payload);
  const tampered = payload.replace("server-2", "server-x");
  const ok = await verifyDaemonSignature(publicJwk, tampered, signature);
  assertEquals(ok, false);
});

test("verifyDaemonSignature rejects signature from different keypair", async () => {
  const signer = await generateEd25519KeyPair();
  const verifier = await generateEd25519KeyPair();
  const verifierPublicJwk = await exportPublicJwk(verifier.publicKey);
  const payload = buildAuthPayload({
    challengeId: "challenge-3",
    nonce: "nonce-3",
    serverId: "server-3",
    keyId: "key-3",
    machineKey: "machine-3",
    hostname: "host-3",
  });
  const signature = await signPayload(signer.privateKey, payload);
  const ok = await verifyDaemonSignature(verifierPublicJwk, payload, signature);
  assertEquals(ok, false);
});

test("verifyDaemonSignature rejects malformed signature and JWK", async () => {
  const keyPair = await generateEd25519KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const payload = buildAuthPayload({
    challengeId: "challenge-4",
    nonce: "nonce-4",
    serverId: "server-4",
    keyId: "key-4",
    machineKey: "machine-4",
    hostname: "host-4",
  });
  assertEquals(await verifyDaemonSignature(publicJwk, payload, "!!!"), false);
  assertEquals(
    await verifyDaemonSignature({ kty: "RSA" }, payload, "abc"),
    false,
  );
});

test("computePublicKeyFingerprint changes when public JWK changes", async () => {
  const first = await generateEd25519KeyPair();
  const second = await generateEd25519KeyPair();
  const firstFp = await computePublicKeyFingerprint(
    await exportPublicJwk(first.publicKey),
  );
  const secondFp = await computePublicKeyFingerprint(
    await exportPublicJwk(second.publicKey),
  );
  assertEquals(firstFp === secondFp, false);
});
