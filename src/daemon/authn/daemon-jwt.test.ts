import { assertEquals, assertExists } from "jsr:@std/assert"
import { deriveSecretsConfig } from "../../client/authn/secrets.ts"
import {
  DAEMON_JWT_AUD,
  DAEMON_JWT_TYP,
  issueDaemonJwt,
  verifyDaemonJwt,
} from "./daemon-jwt.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4)
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeJson<T>(part: string): T {
  return JSON.parse(decoder.decode(base64urlDecode(part))) as T
}

async function createSecrets() {
  return await deriveSecretsConfig({
    versioned: [{ version: 1, value: "test_secret_key_value_for_daemon_jwt" }],
  }, "daemon-jwt-signing")
}

async function buildTokenWithPayload(
  payload: Record<string, unknown>,
): Promise<string> {
  const secrets = await createSecrets()
  const header = { alg: "HS256", typ: "JWT", ver: 1 }
  const encodedHeader = base64urlEncode(encoder.encode(JSON.stringify(header)))
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await crypto.subtle.sign(
    "HMAC",
    secrets.current.key,
    encoder.encode(signingInput),
  )
  const encodedSignature = base64urlEncode(new Uint8Array(signature))
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`
}

Deno.test("issueDaemonJwt produces a 15-minute JWT", async () => {
  const secrets = await createSecrets()
  const issued = await issueDaemonJwt(
    { sub: "server-1", kid: "key-1" },
    secrets,
  )
  const [, encodedPayload] = issued.token.split(".")
  const payload = decodeJson<{ iat: number; exp: number; jti: string }>(encodedPayload)
  assertEquals(payload.exp - payload.iat, 900)
  assertExists(payload.jti)
})

Deno.test("verifyDaemonJwt accepts a valid token", async () => {
  const secrets = await createSecrets()
  const issued = await issueDaemonJwt(
    { sub: "server-1", kid: "key-1" },
    secrets,
  )
  const payload = await verifyDaemonJwt(issued.token, secrets)
  assertExists(payload)
  assertEquals(payload.sub, "server-1")
  assertEquals(payload.kid, "key-1")
  assertExists(payload.jti)
  assertEquals(payload.jti.length > 0, true)
})

Deno.test("verifyDaemonJwt rejects an expired token", async () => {
  const secrets = await createSecrets()
  const nowMs = Date.now() - (16 * 60 * 1000)
  const issued = await issueDaemonJwt(
    { sub: "server-1", kid: "key-1" },
    secrets,
    nowMs,
  )
  const payload = await verifyDaemonJwt(issued.token, secrets)
  assertEquals(payload, null)
})

Deno.test("verifyDaemonJwt rejects a tampered payload", async () => {
  const secrets = await createSecrets()
  const issued = await issueDaemonJwt(
    { sub: "server-1", kid: "key-1" },
    secrets,
  )
  const [header, payload, signature] = issued.token.split(".")
  const tamperedPayload = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A")
  const tamperedToken = `${header}.${tamperedPayload}.${signature}`
  const verified = await verifyDaemonJwt(tamperedToken, secrets)
  assertEquals(verified, null)
})

Deno.test("verifyDaemonJwt rejects wrong aud", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const token = await buildTokenWithPayload({
    sub: "server-1",
    jti: crypto.randomUUID(),
    kid: "key-1",
    iss: "turbopanel",
    aud: "other",
    typ: DAEMON_JWT_TYP,
    iat: nowSeconds,
    exp: nowSeconds + 900,
  })
  const secrets = await createSecrets()
  const verified = await verifyDaemonJwt(token, secrets)
  assertEquals(verified, null)
})

Deno.test("verifyDaemonJwt rejects wrong typ", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const token = await buildTokenWithPayload({
    sub: "server-1",
    jti: crypto.randomUUID(),
    kid: "key-1",
    iss: "turbopanel",
    aud: DAEMON_JWT_AUD,
    typ: "user",
    iat: nowSeconds,
    exp: nowSeconds + 900,
  })
  const secrets = await createSecrets()
  const verified = await verifyDaemonJwt(token, secrets)
  assertEquals(verified, null)
})
