import { assertEquals, assertRejects } from "@std/assert";
import { asc, eq, sql } from "drizzle-orm";
import {
  decryptSecret,
  encryptSecret,
  encryptSecretForDaemon,
  parseSecretEnvelope,
} from "../client/authn/data-encryption.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../client/authn/secrets.ts";
import { getDatabaseUrl } from "../db-url.ts";
import { createDenoDb, type Db } from "../db.ts";
import {
  forge,
  gitConnection,
  organization,
  principal,
  setting,
  tls,
  twoFactor,
  user,
  variable,
} from "../lib/db/schema.ts";
import { SYSTEM_AUTH_PROVIDERS_DB_KEY } from "../lib/settings/auth-provider-settings.ts";
import { SYSTEM_EMAIL_DB_KEY } from "../lib/settings/email-settings.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../test-fixtures/secrets.ts";
import {
  endReencryptSweep,
  reencryptAtRestSecrets,
  reencryptAtRestSecretsToCompletion,
  resetReencryptSweepLockForTests,
  tryBeginReencryptSweep,
} from "./reencrypt-secrets.ts";

const dbUrl = getDatabaseUrl();
const V2_SECRET = "Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7";
const V1_SECRET = TEST_ONLY_TURBOPANEL_SECRET;

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Thrown to force a transaction rollback after successful assertions. */
class RollbackTestTransaction extends Error {
  constructor() {
    super("rollback reencrypt fixture transaction");
    this.name = "RollbackTestTransaction";
  }
}

function createV1OnlySecrets() {
  const config = parseSecretsEnv(`1:${V1_SECRET}`, "deno");
  return deriveEncryptionSecretsConfig(config, "data-encryption");
}

function createRotatedSecrets() {
  const config = parseSecretsEnv(`2:${V2_SECRET},1:${V1_SECRET}`, "deno");
  return deriveEncryptionSecretsConfig(config, "data-encryption");
}

/**
 * Build an empty fixture schema ahead of `public` on `search_path` so the sweep
 * only sees seeded rows. The surrounding transaction always rolls back, so
 * neither the schema nor any re-encrypt writes land on the shared database.
 */
async function installIsolatedFixtureSchema(
  tx: Db,
  schemaName: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new TypeError(`invalid fixture schema name: ${schemaName}`);
  }

  await tx.execute(sql.raw(`CREATE SCHEMA ${schemaName}`));
  await tx.execute(sql.raw(`SET LOCAL search_path TO ${schemaName}, public`));

  // Minimal columns for drizzle inserts/selects used by this test. `uuidv7()`
  // resolves from `public` via search_path.
  await tx.execute(sql.raw(`
    CREATE TABLE organization (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      name varchar(255),
      slug varchar(255),
      metadata jsonb,
      options jsonb
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE variable (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      organization_id uuid,
      workspace_id uuid,
      project_id uuid,
      environment_id uuid,
      service_id uuid,
      hosting_id uuid,
      server_id uuid,
      key varchar(255) NOT NULL,
      value text DEFAULT '' NOT NULL,
      is_secret boolean DEFAULT false NOT NULL,
      is_literal boolean DEFAULT false NOT NULL,
      is_for_build boolean DEFAULT false NOT NULL,
      is_for_runtime boolean DEFAULT true NOT NULL,
      description varchar(255),
      binding_id uuid
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE tls (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      organization_id uuid NOT NULL,
      name varchar(255),
      source text NOT NULL,
      certificate_pem text,
      private_key_pem text,
      status text DEFAULT 'ready' NOT NULL,
      not_after timestamptz(3),
      fingerprint_sha256 text,
      ca_state text,
      ca_generation integer,
      metadata jsonb NOT NULL,
      options jsonb
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE principal (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      kind text NOT NULL,
      provider text NOT NULL,
      username varchar(255) NOT NULL,
      applied_username varchar(255) NOT NULL,
      password text,
      project_id uuid,
      managed_id uuid,
      metadata jsonb,
      options jsonb
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE setting (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      key text NOT NULL,
      value jsonb NOT NULL,
      CONSTRAINT setting_key_unique UNIQUE (key)
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE "user" (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      metadata jsonb,
      options jsonb,
      name varchar(255),
      email varchar(255) NOT NULL,
      is_email_verified boolean DEFAULT false NOT NULL,
      is_2fa_enabled boolean DEFAULT false NOT NULL,
      is_disabled boolean DEFAULT false NOT NULL,
      role text DEFAULT 'user' NOT NULL
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE "2fa" (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      user_id uuid NOT NULL,
      secret text NOT NULL,
      is_verified boolean DEFAULT false NOT NULL,
      backup_codes text NOT NULL
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE forge (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      metadata jsonb,
      options jsonb,
      organization_id uuid,
      provider text NOT NULL,
      name varchar(255) NOT NULL,
      base_url text NOT NULL,
      api_url text,
      external_app_id text NOT NULL,
      app_slug varchar(255),
      client_id text,
      redirect_uri text,
      webhook_origin text,
      is_public boolean DEFAULT false NOT NULL,
      custom_git_user varchar(64),
      custom_git_port integer,
      synced_at timestamptz(3),
      envelopes jsonb NOT NULL,
      webhook_ref varchar(64) NOT NULL,
      webhook_token_hash text
    )
  `));
  await tx.execute(sql.raw(`
    CREATE TABLE connection (
      id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      created_at timestamptz(3) DEFAULT now() NOT NULL,
      updated_at timestamptz(3) DEFAULT now() NOT NULL,
      metadata jsonb,
      options jsonb,
      organization_id uuid NOT NULL,
      forge_id uuid NOT NULL,
      provider text NOT NULL,
      external_installation_id text NOT NULL,
      account_login varchar(255),
      account_type text,
      suspended_at timestamptz(3),
      oauth_envelope jsonb
    )
  `));
}

async function withIsolatedFixture(
  schemaPrefix: string,
  fn: (scoped: Db) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping reencrypt sweep tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  await resetReencryptSweepLockForTests(db);
  const schemaName = `${schemaPrefix}_${
    crypto.randomUUID().replaceAll("-", "")
  }`;

  try {
    await db.transaction(async (tx) => {
      const scoped = tx as unknown as Db;
      await installIsolatedFixtureSchema(scoped, schemaName);
      await fn(scoped);
      throw new RollbackTestTransaction();
    });
  } catch (error) {
    if (!(error instanceof RollbackTestTransaction)) {
      throw error;
    }
  }
}

test("reencryptAtRestSecrets reseals old enc, skips denc/current, fails plaintext/malformed", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();
  const secretsConfig = parseSecretsEnv(`1:${V1_SECRET}`, "deno");

  const v1VariablePlain = "variable-v1-secret";
  const v1TlsPlain = "tls-v1-private-key";
  const v1PrincipalPlain = "principal-v1-password";
  const v2VariablePlain = "variable-already-v2";
  const daemonPlain = "daemon-bound-secret";
  const plaintextVariable = "legacy-plaintext-variable";
  const plaintextTls =
    "-----BEGIN PRIVATE KEY-----\nPLAIN\n-----END PRIVATE KEY-----";
  const plaintextPrincipal = "legacy-plaintext-password";
  const v1SmtpPassPlain = "smtp-v1-password";

  const v1VariableEnvelope = await encryptSecret(v1Only, v1VariablePlain);
  const v1TlsEnvelope = await encryptSecret(v1Only, v1TlsPlain);
  const v1PrincipalEnvelope = await encryptSecret(v1Only, v1PrincipalPlain);
  const v2VariableEnvelope = await encryptSecret(rotated, v2VariablePlain);
  const v1SmtpPassEnvelope = await encryptSecret(v1Only, v1SmtpPassPlain);
  const daemonEnvelope = await encryptSecretForDaemon(
    secretsConfig,
    {
      serverId: "11111111-1111-4111-8111-111111111111",
      keyId: "22222222-2222-4222-8222-222222222222",
    },
    daemonPlain,
  );
  const unknownVersionEnvelope = v1VariableEnvelope.replaceAll(".v1.", ".v99.");
  // Structural malform: `tpsecret.` magic but invalid key version / shape.
  const malformedEnc = "tpsecret.not-a-version.abcde";
  const malformedDenc = "tpdaemon.not-a-valid-daemon-envelope";

  await withIsolatedFixture("reencrypt_fix", async (scoped) => {
    const [org] = await scoped
      .insert(organization)
      .values({ name: "Reencrypt Sweep Org" })
      .returning({ id: organization.id });
    const organizationId = org!.id;
    const suffix = crypto.randomUUID().replaceAll("-", "");

    const [v1Var] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_V1_${suffix}`,
        value: v1VariableEnvelope,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [v2Var] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_V2_${suffix}`,
        value: v2VariableEnvelope,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [daemonVar] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_DAEMON_${suffix}`,
        value: daemonEnvelope,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [unknownVar] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_UNKNOWN_${suffix}`,
        value: unknownVersionEnvelope,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [plainVar] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_PLAIN_${suffix}`,
        value: plaintextVariable,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [malformedVar] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_MALFORMED_${suffix}`,
        value: malformedEnc,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [malformedDencVar] = await scoped
      .insert(variable)
      .values({
        organizationId,
        key: `REENCRYPT_MALFORMED_DENC_${suffix}`,
        value: malformedDenc,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const [tlsRow] = await scoped
      .insert(tls)
      .values({
        organizationId,
        name: "Reencrypt Sweep Cert",
        source: "upload",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
        privateKeyPem: v1TlsEnvelope,
        metadata: {
          dnsNames: ["example.test"],
          hasWildcard: false,
          notBefore: "2020-01-01T00:00:00.000Z",
          notAfter: "2030-01-01T00:00:00.000Z",
          fingerprintSha256: "aa".repeat(32),
          subject: "CN=example.test",
          issuer: "CN=example.test",
          status: "ready",
        },
      })
      .returning({ id: tls.id });

    const [plainTlsRow] = await scoped
      .insert(tls)
      .values({
        organizationId,
        name: "Reencrypt Plaintext Cert",
        source: "upload",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nPLAIN\n-----END CERTIFICATE-----",
        privateKeyPem: plaintextTls,
        metadata: {
          dnsNames: ["plain.test"],
          hasWildcard: false,
          notBefore: "2020-01-01T00:00:00.000Z",
          notAfter: "2030-01-01T00:00:00.000Z",
          fingerprintSha256: "bb".repeat(32),
          subject: "CN=plain.test",
          issuer: "CN=plain.test",
          status: "ready",
        },
      })
      .returning({ id: tls.id });

    const [principalRow] = await scoped
      .insert(principal)
      .values({
        kind: "database",
        provider: "postgres",
        username: `reencrypt_${
          crypto.randomUUID().replaceAll("-", "").slice(0, 12)
        }`,
        appliedUsername: `reencrypt_${
          crypto.randomUUID().replaceAll("-", "").slice(0, 12)
        }`,
        password: v1PrincipalEnvelope,
      })
      .returning({ id: principal.id });

    const [plainPrincipalRow] = await scoped
      .insert(principal)
      .values({
        kind: "database",
        provider: "postgres",
        username: `reencrypt_p_${
          crypto.randomUUID().replaceAll("-", "").slice(0, 10)
        }`,
        appliedUsername: `reencrypt_p_${
          crypto.randomUUID().replaceAll("-", "").slice(0, 10)
        }`,
        password: plaintextPrincipal,
      })
      .returning({ id: principal.id });

    // Single SYSTEM_EMAIL row: one plaintext secret (invalid/unsupported),
    // one old-version sealed secret, plus a plaintext non-secret PROVIDER.
    await scoped.insert(setting).values({
      key: SYSTEM_EMAIL_DB_KEY,
      value: {
        PROVIDER: "mailgun",
        MAILGUN_API_KEY: "plaintext-legacy-mailgun-key",
        SMTP_PASS: v1SmtpPassEnvelope,
      },
    });

    const summary = await reencryptAtRestSecretsToCompletion(scoped, rotated);

    // 7 variables + 2 tls + 2 principals + 2 email secrets.
    // Resealed: v1 var/tls/principal, smtp pass = 4
    // Skipped: current v2 var, valid denc = 2
    // Failed: unknown-version, malformed enc, malformed denc,
    //         plaintext var/tls/principal/mailgun = 7
    assertEquals(summary, {
      scanned: 13,
      reencrypted: 4,
      skipped: 2,
      failed: 7,
    });

    const [updatedV1Var] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, v1Var!.id));
    assertEquals(parseSecretEnvelope(updatedV1Var!.value), { keyVersion: 2 });
    assertEquals(
      await decryptSecret(rotated, updatedV1Var!.value),
      v1VariablePlain,
    );

    const [updatedPlainVar] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, plainVar!.id));
    assertEquals(updatedPlainVar!.value, plaintextVariable);
    assertEquals(parseSecretEnvelope(updatedPlainVar!.value), null);

    const [updatedTls] = await scoped
      .select({ privateKeyPem: tls.privateKeyPem })
      .from(tls)
      .where(eq(tls.id, tlsRow!.id));
    assertEquals(parseSecretEnvelope(updatedTls!.privateKeyPem!), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, updatedTls!.privateKeyPem!),
      v1TlsPlain,
    );

    const [updatedPlainTls] = await scoped
      .select({ privateKeyPem: tls.privateKeyPem })
      .from(tls)
      .where(eq(tls.id, plainTlsRow!.id));
    assertEquals(updatedPlainTls!.privateKeyPem, plaintextTls);
    assertEquals(parseSecretEnvelope(updatedPlainTls!.privateKeyPem!), null);

    const [updatedPrincipal] = await scoped
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, principalRow!.id));
    assertEquals(parseSecretEnvelope(updatedPrincipal!.password!), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, updatedPrincipal!.password!),
      v1PrincipalPlain,
    );

    const [updatedPlainPrincipal] = await scoped
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, plainPrincipalRow!.id));
    assertEquals(updatedPlainPrincipal!.password, plaintextPrincipal);
    assertEquals(parseSecretEnvelope(updatedPlainPrincipal!.password!), null);

    const [updatedEmail] = await scoped
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SYSTEM_EMAIL_DB_KEY));
    const emailObj = updatedEmail!.value as Record<string, string>;
    assertEquals(emailObj.PROVIDER, "mailgun");
    assertEquals(emailObj.MAILGUN_API_KEY, "plaintext-legacy-mailgun-key");
    assertEquals(parseSecretEnvelope(emailObj.MAILGUN_API_KEY), null);
    assertEquals(parseSecretEnvelope(emailObj.SMTP_PASS), { keyVersion: 2 });
    assertEquals(
      await decryptSecret(rotated, emailObj.SMTP_PASS),
      v1SmtpPassPlain,
    );

    const [unchangedV2] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, v2Var!.id));
    assertEquals(unchangedV2!.value, v2VariableEnvelope);

    const [unchangedDaemon] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, daemonVar!.id));
    assertEquals(unchangedDaemon!.value, daemonEnvelope);

    const [unchangedUnknown] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, unknownVar!.id));
    assertEquals(unchangedUnknown!.value, unknownVersionEnvelope);

    const [unchangedMalformed] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, malformedVar!.id));
    assertEquals(unchangedMalformed!.value, malformedEnc);

    const [unchangedMalformedDenc] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, malformedDencVar!.id));
    assertEquals(unchangedMalformedDenc!.value, malformedDenc);
  });
});

/**
 * Wrap `db.update` so the first variable UPDATE runs only after a concurrent
 * writer has replaced the row's envelope — simulating a race between sweep
 * read and write.
 */
function withConcurrentVariableMutation(
  db: Db,
  variableId: string,
  concurrentEnvelope: string,
): Db {
  let mutated = false;
  const rawUpdate = db.update.bind(db);

  const wrapThenable = <T extends object>(builder: T): T => {
    return new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then") {
          const then = Reflect.get(target, prop, receiver) as
            | typeof Promise.prototype.then
            | undefined;
          if (typeof then !== "function") {
            return undefined;
          }
          return (
            onfulfilled?: ((value: unknown) => unknown) | null,
            onrejected?: ((reason: unknown) => unknown) | null,
          ) => {
            const run = async () => {
              if (!mutated) {
                mutated = true;
                await rawUpdate(variable)
                  .set({
                    value: concurrentEnvelope,
                    updatedAt: new Date().toISOString(),
                  })
                  .where(eq(variable.id, variableId));
              }
              return await (target as PromiseLike<unknown>);
            };
            return run().then(onfulfilled, onrejected);
          };
        }

        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (result !== null && typeof result === "object") {
            return wrapThenable(result);
          }
          return result;
        };
      },
    });
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (table: unknown) => {
          const builder = rawUpdate(table as typeof variable);
          if (table !== variable) {
            return builder;
          }
          return wrapThenable(builder);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

test("reencryptAtRestSecrets does not overwrite a concurrent secret update", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();

  const stalePlain = "stale-v1-secret-before-race";
  const concurrentPlain = "concurrent-writer-won";
  const v1Envelope = await encryptSecret(v1Only, stalePlain);
  const concurrentEnvelope = await encryptSecret(rotated, concurrentPlain);

  await withIsolatedFixture("reencrypt_race", async (scoped) => {
    const [org] = await scoped
      .insert(organization)
      .values({ name: "Reencrypt Race Org" })
      .returning({ id: organization.id });

    const [v1Var] = await scoped
      .insert(variable)
      .values({
        organizationId: org!.id,
        key: `REENCRYPT_RACE_${crypto.randomUUID().replaceAll("-", "")}`,
        value: v1Envelope,
        isSecret: true,
      })
      .returning({ id: variable.id });

    const racingDb = withConcurrentVariableMutation(
      scoped,
      v1Var!.id,
      concurrentEnvelope,
    );

    const summary = await reencryptAtRestSecrets(racingDb, rotated);

    assertEquals(summary.scanned, 1);
    assertEquals(summary.reencrypted, 0);
    assertEquals(summary.skipped, 1);
    assertEquals(summary.failed, 0);
    assertEquals(summary.completed, true);
    assertEquals(summary.cursor, null);

    const [after] = await scoped
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, v1Var!.id));

    assertEquals(after!.value, concurrentEnvelope);
    assertEquals(await decryptSecret(rotated, after!.value), concurrentPlain);
    assertEquals(parseSecretEnvelope(after!.value), { keyVersion: 2 });
  });
});

test("tryBeginReencryptSweep rejects concurrent sweeps until released", async () => {
  await withIsolatedFixture("reencrypt_lock", async (scoped) => {
    const first = await tryBeginReencryptSweep(scoped);
    assertEquals(first !== null, true);
    assertEquals(await tryBeginReencryptSweep(scoped), null);
    await endReencryptSweep(scoped, first!);
    assertEquals((await tryBeginReencryptSweep(scoped)) !== null, true);
  });
});

test("tryBeginReencryptSweep allows only one of two independent concurrent callers", async () => {
  await withIsolatedFixture("reencrypt_lock_race", async (scoped) => {
    const [first, second] = await Promise.all([
      tryBeginReencryptSweep(scoped),
      tryBeginReencryptSweep(scoped),
    ]);
    const held = [first, second].filter((lock) => lock !== null);
    assertEquals(held.length, 1);
    await endReencryptSweep(scoped, held[0]!);
    assertEquals((await tryBeginReencryptSweep(scoped)) !== null, true);
  });
});

test("reencryptAtRestSecrets reseals 2fa.secret onto the current key version", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();
  const totpPlain = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const v1Envelope = await encryptSecret(v1Only, totpPlain);

  await withIsolatedFixture("reencrypt_2fa", async (scoped) => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const [owner] = await scoped
      .insert(user)
      .values({
        email: `reencrypt-2fa-${suffix}@example.com`,
        isEmailVerified: true,
        role: "user",
      })
      .returning({ id: user.id });

    const [row] = await scoped
      .insert(twoFactor)
      .values({
        userId: owner!.id,
        secret: v1Envelope,
        isVerified: true,
        backupCodes: "[]",
      })
      .returning({ id: twoFactor.id });

    const summary = await reencryptAtRestSecrets(scoped, rotated, {
      cursor: { stage: "twofactor" },
    });

    assertEquals(summary.scanned, 1);
    assertEquals(summary.reencrypted, 1);
    assertEquals(summary.skipped, 0);
    assertEquals(summary.failed, 0);
    assertEquals(summary.completed, true);

    const [updated] = await scoped
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.id, row!.id));
    assertEquals(parseSecretEnvelope(updated!.secret), { keyVersion: 2 });
    assertEquals(await decryptSecret(rotated, updated!.secret), totpPlain);
  });
});

test("reencryptAtRestSecrets reseals forge envelopes and gitConnection oauthEnvelope", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();
  const v1PrivateKeyPlain = "forge-v1-private-key";
  const v1ClientSecretPlain = "forge-v1-client-secret";
  const v1AccessTokenPlain = "gitlab-v1-access-token";
  const v1RefreshTokenPlain = "gitlab-v1-refresh-token";

  const v1PrivateKeyEnvelope = await encryptSecret(v1Only, v1PrivateKeyPlain);
  const v1ClientSecretEnvelope = await encryptSecret(
    v1Only,
    v1ClientSecretPlain,
  );
  const v1AccessTokenEnvelope = await encryptSecret(
    v1Only,
    v1AccessTokenPlain,
  );
  const v1RefreshTokenEnvelope = await encryptSecret(
    v1Only,
    v1RefreshTokenPlain,
  );

  await withIsolatedFixture("reencrypt_forge", async (scoped) => {
    const [org] = await scoped
      .insert(organization)
      .values({ name: "Reencrypt Forge Org" })
      .returning({ id: organization.id });

    const [forgeRow] = await scoped
      .insert(forge)
      .values({
        organizationId: org!.id,
        provider: "github",
        name: "Reencrypt Forge App",
        baseUrl: "https://github.example.test",
        externalAppId: "12345",
        webhookRef: crypto.randomUUID().replaceAll("-", ""),
        envelopes: {
          privateKeyEnvelope: v1PrivateKeyEnvelope,
          clientSecretEnvelope: v1ClientSecretEnvelope,
        },
      })
      .returning({ id: forge.id });

    const [connRow] = await scoped
      .insert(gitConnection)
      .values({
        organizationId: org!.id,
        forgeId: forgeRow!.id,
        provider: "gitlab",
        externalInstallationId: "67890",
        oauthEnvelope: {
          accessTokenEnvelope: v1AccessTokenEnvelope,
          refreshTokenEnvelope: v1RefreshTokenEnvelope,
          expiresAt: "2030-01-01T00:00:00.000Z",
          scope: "api",
        },
      })
      .returning({ id: gitConnection.id });

    const summary = await reencryptAtRestSecrets(scoped, rotated, {
      cursor: { stage: "forge" },
    });

    assertEquals(summary.scanned, 4);
    assertEquals(summary.reencrypted, 4);
    assertEquals(summary.skipped, 0);
    assertEquals(summary.failed, 0);
    assertEquals(summary.completed, true);
    assertEquals(summary.cursor, null);

    const [updatedForge] = await scoped
      .select({ envelopes: forge.envelopes })
      .from(forge)
      .where(eq(forge.id, forgeRow!.id));
    const forgeEnvelopes = updatedForge!.envelopes as Record<string, string>;
    assertEquals(parseSecretEnvelope(forgeEnvelopes.privateKeyEnvelope), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, forgeEnvelopes.privateKeyEnvelope),
      v1PrivateKeyPlain,
    );
    assertEquals(parseSecretEnvelope(forgeEnvelopes.clientSecretEnvelope), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, forgeEnvelopes.clientSecretEnvelope),
      v1ClientSecretPlain,
    );

    const [updatedConn] = await scoped
      .select({ oauthEnvelope: gitConnection.oauthEnvelope })
      .from(gitConnection)
      .where(eq(gitConnection.id, connRow!.id));
    const connEnvelope = updatedConn!.oauthEnvelope as Record<string, string>;
    assertEquals(parseSecretEnvelope(connEnvelope.accessTokenEnvelope), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, connEnvelope.accessTokenEnvelope),
      v1AccessTokenPlain,
    );
    assertEquals(parseSecretEnvelope(connEnvelope.refreshTokenEnvelope), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, connEnvelope.refreshTokenEnvelope),
      v1RefreshTokenPlain,
    );
    assertEquals(connEnvelope.expiresAt, "2030-01-01T00:00:00.000Z");
    assertEquals(connEnvelope.scope, "api");
  });
});

test("reencryptAtRestSecrets reseals SYSTEM_AUTH_PROVIDERS then continues to email", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();
  const githubPlain = "github-client-secret-v1";
  const smtpPlain = "smtp-pass-v1";
  const v1Github = await encryptSecret(v1Only, githubPlain);
  const v1Smtp = await encryptSecret(v1Only, smtpPlain);

  await withIsolatedFixture("reencrypt_authproviders", async (scoped) => {
    await scoped.insert(setting).values({
      key: SYSTEM_AUTH_PROVIDERS_DB_KEY,
      value: {
        GITHUB_CLIENT_ID: "gh-id",
        GITHUB_CLIENT_SECRET: v1Github,
        GOOGLE_CLIENT_SECRET: "plaintext-google",
      },
    });
    await scoped.insert(setting).values({
      key: SYSTEM_EMAIL_DB_KEY,
      value: { SMTP_PASS: v1Smtp },
    });

    const summary = await reencryptAtRestSecrets(scoped, rotated, {
      cursor: { stage: "authproviders" },
    });

    assertEquals(summary.scanned, 3);
    assertEquals(summary.reencrypted, 2);
    assertEquals(summary.skipped, 0);
    assertEquals(summary.failed, 1);
    assertEquals(summary.completed, true);
    assertEquals(summary.cursor, null);

    const [providers] = await scoped
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY));
    const providerObj = providers!.value as Record<string, string>;
    assertEquals(parseSecretEnvelope(providerObj.GITHUB_CLIENT_SECRET), {
      keyVersion: 2,
    });
    assertEquals(
      await decryptSecret(rotated, providerObj.GITHUB_CLIENT_SECRET),
      githubPlain,
    );
    assertEquals(providerObj.GOOGLE_CLIENT_SECRET, "plaintext-google");

    const [email] = await scoped
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SYSTEM_EMAIL_DB_KEY));
    const emailObj = email!.value as Record<string, string>;
    assertEquals(parseSecretEnvelope(emailObj.SMTP_PASS), { keyVersion: 2 });
    assertEquals(await decryptSecret(rotated, emailObj.SMTP_PASS), smtpPlain);
  });
});

test("reencryptAtRestSecrets rejects non-positive limits", async () => {
  const rotated = await createRotatedSecrets();
  await assertRejects(
    () => reencryptAtRestSecrets({} as Db, rotated, { limit: 0 }),
    TypeError,
    "reencrypt limit must be a positive integer",
  );
});

test("reencryptAtRestSecrets resumes across bounded batches via cursor", async () => {
  const v1Only = await createV1OnlySecrets();
  const rotated = await createRotatedSecrets();

  await withIsolatedFixture("reencrypt_batch", async (scoped) => {
    const [org] = await scoped
      .insert(organization)
      .values({ name: "Reencrypt Batch Org" })
      .returning({ id: organization.id });

    const plains = ["batch-a", "batch-b", "batch-c"];
    for (const [index, plain] of plains.entries()) {
      await scoped.insert(variable).values({
        organizationId: org!.id,
        key: `REENCRYPT_BATCH_${index}_${
          crypto.randomUUID().replaceAll("-", "")
        }`,
        value: await encryptSecret(v1Only, plain),
        isSecret: true,
      });
    }

    const first = await reencryptAtRestSecrets(scoped, rotated, { limit: 2 });
    assertEquals(first.completed, false);
    assertEquals(first.cursor?.stage, "variables");
    assertEquals(typeof first.cursor?.afterId, "string");
    assertEquals(first.scanned, 2);
    assertEquals(first.reencrypted, 2);

    const second = await reencryptAtRestSecrets(scoped, rotated, {
      cursor: first.cursor,
      limit: 2,
    });
    // One remaining variable, then empty tls/principals, then email (none).
    assertEquals(second.completed, true);
    assertEquals(second.cursor, null);
    assertEquals(second.scanned, 1);
    assertEquals(second.reencrypted, 1);

    const rows = await scoped
      .select({ value: variable.value })
      .from(variable)
      .orderBy(asc(variable.id));
    assertEquals(rows.length, 3);
    for (const row of rows) {
      assertEquals(parseSecretEnvelope(row.value), { keyVersion: 2 });
    }
  });
});
