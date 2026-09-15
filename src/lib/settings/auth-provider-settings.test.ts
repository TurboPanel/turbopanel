import { assertEquals, assertRejects } from "@std/assert";
import { isSealedEnvelope } from "../../client/authn/data-encryption.ts";
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from "../../client/authn/secrets.ts";
import { TEST_ONLY_TURBOPANEL_SECRET } from "../../test-fixtures/secrets.ts";
import { setting } from "../db/schema.ts";
import type { Db } from "../../db.ts";
import {
  AUTH_PROVIDER_SETTINGS_PREFIX,
  authProviderSettingsToApiShape,
  authProviderUpdatesRequireEncryption,
  resolveAuthProviderSettings,
  resolveConfiguredProviders,
  SYSTEM_AUTH_PROVIDERS_DB_KEY,
  updateAuthProviderSettings,
} from "./auth-provider-settings.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function deriveDataEncryptionSecrets() {
  const config = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, "deno");
  return await deriveEncryptionSecretsConfig(config, "data-encryption");
}

/**
 * Minimal in-memory stand-in for the drizzle `Db` covering only the `setting`
 * table chains used by `updateAuthProviderSettings` /
 * `resolveAuthProviderSettings`.
 */
function createFakeSettingDb() {
  let stored: Record<string, unknown> | undefined;

  const makeSelect = () => {
    let target: unknown = null;
    const builder = {
      from(table: unknown) {
        target = table;
        return builder;
      },
      where() {
        return builder;
      },
      for() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit(): Promise<Array<{ value: unknown }>> {
        if (target === setting && stored !== undefined) {
          return Promise.resolve([{ value: stored }]);
        }
        return Promise.resolve([]);
      },
    };
    return builder;
  };

  const db = {
    select() {
      return makeSelect();
    },
    insert(table: unknown) {
      return {
        values(row: { key: string; value: Record<string, unknown> }) {
          return {
            onConflictDoUpdate() {
              if (table === setting) stored = row.value;
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    update(table: unknown) {
      const builder = {
        set(values: { value?: Record<string, unknown> }) {
          if (table === setting && values.value) stored = values.value;
          return builder;
        },
        where() {
          return builder;
        },
        returning(): Promise<Array<{ key: string }>> {
          return Promise.resolve([{ key: SYSTEM_AUTH_PROVIDERS_DB_KEY }]);
        },
      };
      return builder;
    },
    delete(table: unknown) {
      return {
        where() {
          if (table === setting) stored = undefined;
          return Promise.resolve(undefined);
        },
      };
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db);
    },
    getStored(): Record<string, unknown> | undefined {
      return stored;
    },
    seedStored(value: Record<string, unknown>) {
      stored = value;
    },
  };
  return db;
}

test("env-wins client id and secret configure github without a DB row", async () => {
  const env = {
    TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: "gh-id",
    TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: "gh-secret",
  };
  const resolved = await resolveAuthProviderSettings(undefined, env);
  assertEquals(resolved.github, {
    clientId: "gh-id",
    clientSecret: "gh-secret",
  });
  assertEquals(resolved.google, undefined);
  assertEquals(await resolveConfiguredProviders(undefined, env), ["github"]);
});

test("authProviderSettingsToApiShape masks env secrets", async () => {
  const resolved = await resolveAuthProviderSettings(undefined, {
    TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: "gh-id",
    TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: "env-secret",
  });
  const api = authProviderSettingsToApiShape(resolved);
  assertEquals(api[`${AUTH_PROVIDER_SETTINGS_PREFIX}__GITHUB_CLIENT_SECRET`], {
    source: "env",
    value: null,
    isEnvOverridden: true,
  });
  assertEquals(api[`${AUTH_PROVIDER_SETTINGS_PREFIX}__GITHUB_CLIENT_ID`], {
    source: "env",
    value: "gh-id",
    isEnvOverridden: true,
  });
});

test("authProviderUpdatesRequireEncryption detects secret writes only", () => {
  assertEquals(
    authProviderUpdatesRequireEncryption({ GITHUB_CLIENT_ID: "id" }),
    false,
  );
  assertEquals(
    authProviderUpdatesRequireEncryption({ GITHUB_CLIENT_SECRET: "secret" }),
    true,
  );
  assertEquals(
    authProviderUpdatesRequireEncryption({ GITHUB_CLIENT_SECRET: "  " }),
    false,
  );
});

test("sealed DB secrets round-trip; presence-only does not decrypt", async () => {
  const secrets = await deriveDataEncryptionSecrets();
  const fakeDb = createFakeSettingDb();
  await updateAuthProviderSettings(
    fakeDb as unknown as Db,
    {},
    {
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "db-secret",
    },
    secrets,
  );

  const stored = fakeDb.getStored() as Record<string, string>;
  assertEquals(stored.GITHUB_CLIENT_ID, "gh-id");
  assertEquals(isSealedEnvelope(stored.GITHUB_CLIENT_SECRET), true);
  assertEquals(stored.GITHUB_CLIENT_SECRET.includes("db-secret"), false);

  const withoutDecrypt = await resolveAuthProviderSettings(
    fakeDb as unknown as Db,
    {},
  );
  assertEquals(withoutDecrypt.github, undefined);
  assertEquals(
    await resolveConfiguredProviders(fakeDb as unknown as Db, {}),
    ["github"],
  );

  const withDecrypt = await resolveAuthProviderSettings(
    fakeDb as unknown as Db,
    {},
    secrets,
  );
  assertEquals(withDecrypt.github, {
    clientId: "gh-id",
    clientSecret: "db-secret",
  });

  const api = authProviderSettingsToApiShape(withDecrypt);
  assertEquals(api[`${AUTH_PROVIDER_SETTINGS_PREFIX}__GITHUB_CLIENT_SECRET`], {
    source: "db",
    value: "***",
    isEnvOverridden: false,
  });

  const envWins = await resolveAuthProviderSettings(
    fakeDb as unknown as Db,
    {
      TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: "env-id",
      TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: "env-secret",
    },
    secrets,
  );
  assertEquals(envWins.github, {
    clientId: "env-id",
    clientSecret: "env-secret",
  });
});

test("plaintext DB secrets fail closed for presence and resolve", async () => {
  const fakeDb = createFakeSettingDb();
  fakeDb.seedStored({
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "plaintext",
  });
  assertEquals(
    await resolveConfiguredProviders(fakeDb as unknown as Db, {}),
    [],
  );
  const resolved = await resolveAuthProviderSettings(
    fakeDb as unknown as Db,
    {},
  );
  assertEquals(resolved.github, undefined);
});

test("secret writes without data-encryption secrets throw", async () => {
  const fakeDb = createFakeSettingDb();
  await assertRejects(
    () =>
      updateAuthProviderSettings(
        fakeDb as unknown as Db,
        {},
        { GITHUB_CLIENT_SECRET: "plain" },
      ),
    Error,
    "data encryption secrets required to store auth provider secret settings",
  );
});
