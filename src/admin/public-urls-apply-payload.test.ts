import { assertEquals, assertRejects } from "@std/assert";
import { createDenoDb, type Db, endDbConnection } from "../db/connection.ts";
import { getDatabaseUrl } from "../db/url.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
  key,
  server,
} from "../db/schema.ts";
import {
  InstanceSecretSealingError,
  resolveInstanceSecretSealing,
} from "../features/install/instance-secret-sealing.ts";
import {
  decryptSecretForDaemon,
  encryptSecret,
} from "../lib/secrets/data-encryption.ts";
import { deriveEncryptionSecretsConfig } from "../lib/secrets/secrets.ts";
import { SEALED_INSTANCE_SECRETS_FEATURE } from "../lib/version-wire.ts";
import { recordingRedisRegistry } from "../test-fixtures/recording-redis-registry.ts";
import { parseTestSecretsConfig } from "../test-fixtures/secrets.ts";
import { resolvePublicUrlsApplyPayload } from "./public-urls-apply-payload.ts";
import { waitForPublicUrlsApply } from "./routes-helpers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const dbUrl = getDatabaseUrl();

/** Plaintext of the uploaded key; must never appear in an outbox write. */
const UPLOADED_KEY = "uploaded-control-plane-key-material-marker";

class RollbackFixture extends Error {
  constructor() {
    super("rollback public-urls fixture");
    this.name = "RollbackFixture";
  }
}

/** Run `fn` in a transaction that always rolls back. */
async function withRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn("Skipping public-urls sealing tests: TURBOPANEL_DATABASE_URL not set");
    return;
  }
  const db = createDenoDb();
  try {
    await db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new RollbackFixture();
    });
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error;
  } finally {
    await endDbConnection(db);
  }
}

async function seedDaemon(
  tx: Db,
  opts: { features: string[]; revoked?: boolean },
): Promise<{ serverId: string; keyId: string }> {
  const [row] = await tx
    .insert(server)
    .values({
      name: `sealing-${crypto.randomUUID()}`,
      daemon: { projection: { features: opts.features } },
    })
    .returning({ id: server.id });
  const [keyRow] = await tx
    .insert(key)
    .values({
      serverId: row!.id,
      algorithm: "Ed25519",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      fingerprint: `fp-${crypto.randomUUID()}`,
      ...(opts.revoked ? { revokedAt: new Date().toISOString() } : {}),
    })
    .returning({ id: key.id });
  return { serverId: row!.id, keyId: keyRow!.id };
}

async function seedUploadedHostname(tx: Db): Promise<string> {
  const secrets = await dataEncryption();
  const [cert] = await tx
    .insert(instanceUploadedCertificate)
    .values({
      label: "sealing fixture",
      certPem: "uploaded-certificate-pem",
      keyPem: await encryptSecret(secrets, UPLOADED_KEY),
      dnsNames: [],
      notAfter: new Date(Date.now() + 86_400_000).toISOString(),
    })
    .returning({ id: instanceUploadedCertificate.id });
  const host = `sealed-${crypto.randomUUID()}.example.test`;
  await tx.insert(instanceHostname).values({
    host,
    source: "uploaded",
    uploadedCertId: cert!.id,
  });
  return host;
}

function dataEncryption() {
  return deriveEncryptionSecretsConfig(parseTestSecretsConfig(), "data-encryption");
}

test("resolveInstanceSecretSealing seals only to a daemon that advertises the feature", async () => {
  await withRollback(async (tx) => {
    const secretsConfig = parseTestSecretsConfig();

    const legacy = await seedDaemon(tx, { features: ["update-progress-v1"] });
    assertEquals(await resolveInstanceSecretSealing(tx, legacy.serverId, secretsConfig), null);

    const capable = await seedDaemon(tx, { features: [SEALED_INSTANCE_SECRETS_FEATURE] });
    const sealing = await resolveInstanceSecretSealing(tx, capable.serverId, secretsConfig);
    assertEquals(sealing?.recipient, { serverId: capable.serverId, keyId: capable.keyId });

    // Able to open envelopes but the instance cannot seal: refuse, never plaintext.
    await assertRejects(
      () => resolveInstanceSecretSealing(tx, capable.serverId, undefined),
      InstanceSecretSealingError,
    );
    const revoked = await seedDaemon(tx, {
      features: [SEALED_INSTANCE_SECRETS_FEATURE],
      revoked: true,
    });
    await assertRejects(
      () => resolveInstanceSecretSealing(tx, revoked.serverId, secretsConfig),
      InstanceSecretSealingError,
    );
  });
});

test("an uploaded key reaches the Redis outbox only as a tpdaemon envelope", async () => {
  await withRollback(async (tx) => {
    const secretsConfig = parseTestSecretsConfig();
    const host = await seedUploadedHostname(tx);
    const { serverId } = await seedDaemon(tx, {
      features: [SEALED_INSTANCE_SECRETS_FEATURE],
    });
    const sealing = await resolveInstanceSecretSealing(tx, serverId, secretsConfig);
    const payload = await resolvePublicUrlsApplyPayload(
      tx,
      [host],
      "0.1.1",
      await dataEncryption(),
      {},
      sealing,
    );
    const { registry, outboxWrites } = recordingRedisRegistry(serverId);

    await waitForPublicUrlsApply(registry, serverId, payload);

    assertEquals(outboxWrites.length, 1);
    const raw = outboxWrites[0]!.payload!;
    assertEquals(raw.includes(UPLOADED_KEY), false, "plaintext key in the outbox");
    const envelope = JSON.parse(raw) as {
      hostnames?: Array<{ host: string; keyPem?: string; keyEnvelope?: string }>;
    };
    const entry = envelope.hostnames?.find((candidate) => candidate.host === host);
    assertEquals(entry?.keyPem, undefined);
    assertEquals(
      await decryptSecretForDaemon(secretsConfig, sealing!.recipient, entry!.keyEnvelope!),
      UPLOADED_KEY,
    );
  });
});

test("a daemon without the feature still receives the legacy plaintext key", async () => {
  await withRollback(async (tx) => {
    const host = await seedUploadedHostname(tx);
    const payload = await resolvePublicUrlsApplyPayload(
      tx,
      [host],
      "0.1.1",
      await dataEncryption(),
      {},
      null,
    );
    const entry = payload.hostnames?.find((candidate) => candidate.host === host);
    assertEquals(entry?.keyPem, UPLOADED_KEY);
    assertEquals(entry?.keyEnvelope, undefined);
  });
});
