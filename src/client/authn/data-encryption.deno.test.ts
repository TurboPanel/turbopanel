import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  DataEncryptionError,
  decryptSecret,
  decryptSecretForDaemon,
  encryptSecret,
  encryptSecretForDaemon,
  isSealedEnvelope,
} from "./data-encryption.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "./secrets.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";

const V2_SECRET = "Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7";
const V1_SECRET = TEST_ONLY_TURBOPANEL_SECRET;

async function createCurrentSecrets() {
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, "deno");
  return deriveEncryptionSecretsConfig(config, "data-encryption");
}

async function createRotatedSecrets() {
  const config = parseSecretsEnv(
    undefined,
    `2:${V2_SECRET},1:${V1_SECRET}`,
    "deno",
  );
  return deriveEncryptionSecretsConfig(config, "data-encryption");
}

async function createV1OnlySecrets() {
  const config = parseSecretsEnv(undefined, `1:${V1_SECRET}`, "deno");
  return deriveEncryptionSecretsConfig(config, "data-encryption");
}

async function createSecretsConfig() {
  return parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, "deno");
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("encryptSecretForDaemon / decryptSecretForDaemon round-trip", async () => {
  const secretsConfig = await createSecretsConfig();
  const recipient = {
    serverId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  const envelope = await encryptSecretForDaemon(
    secretsConfig,
    recipient,
    "daemon-bound",
  );
  assertEquals(isSealedEnvelope(envelope), true);
  assertEquals(
    await decryptSecretForDaemon(secretsConfig, recipient, envelope),
    "daemon-bound",
  );
});

test("decryptSecretForDaemon rejects recipient mismatch", async () => {
  const secretsConfig = await createSecretsConfig();
  const recipient = {
    serverId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  const envelope = await encryptSecretForDaemon(
    secretsConfig,
    recipient,
    "daemon-bound",
  );
  await assertRejects(
    () => decryptSecretForDaemon(
      secretsConfig,
      { serverId: recipient.serverId, keyId: "other-key" },
      envelope,
    ),
    DataEncryptionError,
  );
});

test("encryptSecret / decryptSecret round-trip", async () => {
  const secrets = await createCurrentSecrets();
  const envelope = await encryptSecret(secrets, "hello-secret");
  assertEquals(isSealedEnvelope(envelope), true);
  assertEquals(await decryptSecret(secrets, envelope), "hello-secret");
});

test("decryptSecret supports rotation fallbacks", async () => {
  const rotated = await createRotatedSecrets();
  const envelope = await encryptSecret(rotated, "rotated-value");
  assertEquals(await decryptSecret(rotated, envelope), "rotated-value");

  const v1Only = await createV1OnlySecrets();
  const v1Envelope = await encryptSecret(v1Only, "v1-key-version-value");
  assertEquals(await decryptSecret(rotated, v1Envelope), "v1-key-version-value");
});

test("decryptSecret rejects unknown key version", async () => {
  const secrets = await createCurrentSecrets();
  const envelope = await encryptSecret(secrets, "x");
  const tamperedVersion = envelope.replace(/\.1\./, ".99.");
  await assertRejects(
    () => decryptSecret(secrets, tamperedVersion),
    DataEncryptionError,
  );
});

test("decryptSecret rejects malformed and tampered envelopes", async () => {
  const secrets = await createCurrentSecrets();
  await assertRejects(
    () => decryptSecret(secrets, "tpsecret.v1"),
    DataEncryptionError,
  );
  await assertRejects(
    () => decryptSecret(secrets, "not-sealed"),
    DataEncryptionError,
  );

  const envelope = await encryptSecret(secrets, "tamper-me");
  const parts = envelope.split(".");
  parts[4] = `${parts[4].slice(0, -2)}xx`;
  await assertRejects(
    () => decryptSecret(secrets, parts.join(".")),
    DataEncryptionError,
  );
});

test("isSealedEnvelope detects sealed values only", async () => {
  const secrets = await createCurrentSecrets();
  const envelope = await encryptSecret(secrets, "x");
  assertEquals(isSealedEnvelope(envelope), true);
  assertEquals(isSealedEnvelope("plain-password"), false);
  assertEquals(isSealedEnvelope(""), false);
});
