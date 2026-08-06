import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  DataEncryptionError,
  decryptSecret,
  decryptSecretForDaemon,
  ENVELOPE_MAGIC,
  encryptSecret,
  encryptSecretForDaemon,
  generateSealedSecret,
  isDaemonSealedEnvelope,
  isSealedEnvelope,
  parseDaemonSecretEnvelope,
  parseSecretEnvelope,
  resealSecretForDaemon,
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
  assertEquals(envelope.startsWith(`${ENVELOPE_MAGIC}.1.`), true);
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

test("reseals to current key version on write after rotation", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();
  const v1Envelope = await encryptSecret(v1Only, "rotate-me");
  assertEquals(parseSecretEnvelope(v1Envelope), { keyVersion: 1 });

  const plaintext = await decryptSecret(rotated, v1Envelope);
  const resealed = await encryptSecret(rotated, plaintext);
  assertEquals(parseSecretEnvelope(resealed), {
    keyVersion: rotated.current.version,
  });
  assertEquals(rotated.current.version, 2);
  assertEquals(resealed === v1Envelope, false);
  assertEquals(await decryptSecret(rotated, resealed), "rotate-me");
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
    () => decryptSecret(secrets, "enc.1"),
    DataEncryptionError,
  );
  await assertRejects(
    () => decryptSecret(secrets, "not-sealed"),
    DataEncryptionError,
  );

  const envelope = await encryptSecret(secrets, "tamper-me");
  const parts = envelope.split(".");
  parts[2] = `${parts[2]!.slice(0, -2)}xx`;
  await assertRejects(
    () => decryptSecret(secrets, parts.join(".")),
    DataEncryptionError,
  );
});

test("resealSecretForDaemon reseals enc → denc for recipient", async () => {
  const secretsConfig = await createSecretsConfig();
  const dataEncryptionSecrets = await createCurrentSecrets();
  const recipient = {
    serverId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  const sealed = await encryptSecret(dataEncryptionSecrets, "delivery-secret");
  const forDaemon = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    recipient,
    sealed,
  );
  assertEquals(isDaemonSealedEnvelope(forDaemon), true);
  assertEquals(
    await decryptSecretForDaemon(secretsConfig, recipient, forDaemon),
    "delivery-secret",
  );
});

test("generateSealedSecret returns plaintext and decryptable enc", async () => {
  const dataEncryptionSecrets = await createCurrentSecrets();
  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets);
  assertEquals(sealed.startsWith(`${ENVELOPE_MAGIC}.`), true);
  assertEquals(await decryptSecret(dataEncryptionSecrets, sealed), plaintext);
});

test("principal-password sealing stores enc never plaintext", async () => {
  const dataEncryptionSecrets = await createCurrentSecrets();
  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets);
  assertEquals(sealed.startsWith(`${ENVELOPE_MAGIC}.`), true);
  assertEquals(sealed.includes(plaintext), false);
  assertEquals(await decryptSecret(dataEncryptionSecrets, sealed), plaintext);
});

test("isSealedEnvelope detects sealed values only", async () => {
  const secrets = await createCurrentSecrets();
  const envelope = await encryptSecret(secrets, "x");
  assertEquals(isSealedEnvelope(envelope), true);
  assertEquals(isSealedEnvelope("plain-password"), false);
  assertEquals(isSealedEnvelope(""), false);
});

test("parseSecretEnvelope returns null for malformed enc values", async () => {
  const secrets = await createCurrentSecrets();
  const envelope = await encryptSecret(secrets, "x");
  assertEquals(parseSecretEnvelope(envelope)?.keyVersion, 1);
  assertEquals(parseSecretEnvelope("denc.1.payload"), null);
  assertEquals(parseSecretEnvelope("enc"), null);
  assertEquals(parseSecretEnvelope("enc..payload"), null);
  assertEquals(parseSecretEnvelope("enc.not-a-version.payload"), null);
});

test("parseDaemonSecretEnvelope validates denc structure", async () => {
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
  assertEquals(parseDaemonSecretEnvelope(envelope), {
    ...recipient,
    keyVersion: 1,
  });
  assertEquals(isDaemonSealedEnvelope(envelope), true);
  assertEquals(parseDaemonSecretEnvelope("denc.only.four.parts"), null);
  assertEquals(
    parseDaemonSecretEnvelope(
      "denc.server.key.not-a-version.payload",
    ),
    null,
  );
});

test("decryptSecret rejects daemon envelopes and invalid versions", async () => {
  const secrets = await createCurrentSecrets();
  const secretsConfig = await createSecretsConfig();
  const recipient = {
    serverId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  const denc = await encryptSecretForDaemon(
    secretsConfig,
    recipient,
    "daemon-only",
  );
  await assertRejects(
    () => decryptSecret(secrets, denc),
    DataEncryptionError,
    "malformed envelope",
  );
  await assertRejects(
    () => decryptSecret(secrets, "enc.not-a-version.payload"),
    DataEncryptionError,
    "invalid key version",
  );
  await assertRejects(
    () => decryptSecret(secrets, "enc.1."),
    DataEncryptionError,
    "invalid payload length",
  );
});

test("decryptSecretForDaemon rejects malformed and unknown-version envelopes", async () => {
  const secretsConfig = await createSecretsConfig();
  const recipient = {
    serverId: "11111111-1111-4111-8111-111111111111",
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  await assertRejects(
    () => decryptSecretForDaemon(secretsConfig, recipient, "enc.1.payload"),
    DataEncryptionError,
    "not a daemon sealed envelope",
  );

  const envelope = await encryptSecretForDaemon(
    secretsConfig,
    recipient,
    "daemon-bound",
  );
  const tampered = envelope.replace(/\.1\./, ".99.");
  await assertRejects(
    () => decryptSecretForDaemon(secretsConfig, recipient, tampered),
    DataEncryptionError,
    "unknown key version",
  );

  const parts = envelope.split(".");
  parts[4] = "YQ";
  await assertRejects(
    () => decryptSecretForDaemon(secretsConfig, recipient, parts.join(".")),
    DataEncryptionError,
    "invalid payload length",
  );
});
