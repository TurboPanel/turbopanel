import { eq } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { setting } from "../db/schema.ts";
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from "../../client/authn/data-encryption.ts";
import type { DerivedSecretsConfig } from "../../client/authn/secrets.ts";
import type { OAuthProviderId } from "../../client/authn/oauth/providers.ts";
import {
  normalizeSettingFullKey,
  type ResolvedSetting,
  type SettingSource,
  SettingsResolver,
} from "./resolver.ts";

/** DB key for the single JSON row that stores all OAuth provider credentials. */
export const SYSTEM_AUTH_PROVIDERS_DB_KEY = "SYSTEM_AUTH_PROVIDERS";

export const AUTH_PROVIDER_SETTINGS_PREFIX = "TURBOPANEL_AUTH_PROVIDERS";

export const AUTH_PROVIDER_SETTING_SHORT_KEYS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

export type AuthProviderSettingShortKey =
  (typeof AUTH_PROVIDER_SETTING_SHORT_KEYS)[number];

export const AUTH_PROVIDER_SETTINGS_SCHEMA: Record<
  AuthProviderSettingShortKey,
  string | undefined
> = {
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
};

export const AUTH_PROVIDER_SECRET_KEYS: ReadonlySet<
  AuthProviderSettingShortKey
> = new Set(["GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]);

export type AuthProviderSettingMeta = {
  fullKey: string;
  value: string;
  source: SettingSource;
  isEnvOverridden: boolean;
  isDbSet: boolean;
};

export type AuthProviderCredentials = {
  clientId: string;
  clientSecret: string;
};

export type ResolvedAuthProviderSettings = {
  github?: AuthProviderCredentials;
  google?: AuthProviderCredentials;
  keys: Record<AuthProviderSettingShortKey, AuthProviderSettingMeta>;
};

function fullAuthProviderSettingKey(
  shortKey: AuthProviderSettingShortKey,
): string {
  return normalizeSettingFullKey(AUTH_PROVIDER_SETTINGS_PREFIX, shortKey);
}

function metaFromResolved(
  shortKey: AuthProviderSettingShortKey,
  resolved: ResolvedSetting,
  resolver: SettingsResolver,
): AuthProviderSettingMeta {
  return {
    fullKey: fullAuthProviderSettingKey(shortKey),
    value: resolved.value,
    source: resolved.source,
    isEnvOverridden: resolver.isEnvOverridden(shortKey),
    isDbSet: resolver.isDbSet(shortKey),
  };
}

function readSystemAuthProvidersObject(value: unknown): Record<string, string> {
  if (
    value === null || value === undefined || typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (
      typeof raw === "number" || typeof raw === "boolean" ||
      typeof raw === "bigint"
    ) {
      out[key] = `${raw}`;
    } else if (raw != null) {
      out[key] = JSON.stringify(raw);
    }
  }
  return out;
}

async function loadSystemAuthProvidersObject(
  db: Db,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY))
    .limit(1);

  return readSystemAuthProvidersObject(rows[0]?.value);
}

type AuthProviderSettingMutation = {
  shortKey: AuthProviderSettingShortKey;
  value: string | null;
};

function collectAuthProviderSettingMutations(
  resolver: SettingsResolver,
  updates: Record<string, string | null>,
): AuthProviderSettingMutation[] {
  const mutations: AuthProviderSettingMutation[] = [];

  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue !== null && typeof rawValue !== "string") continue;

    const shortKey = resolveShortKeyFromInput(key);
    if (!shortKey) continue;
    if (resolver.isEnvOverridden(shortKey)) continue;

    if (rawValue === null) {
      mutations.push({ shortKey, value: null });
      continue;
    }

    const trimmed = rawValue.trim();
    if (trimmed === "") continue;

    mutations.push({ shortKey, value: trimmed });
  }

  return mutations;
}

/**
 * Seal secret-key mutations as `tpsecret` envelopes before they are written.
 * Non-secret keys and deletions pass through untouched. Requires
 * data-encryption secrets whenever a secret value is being stored.
 */
async function sealAuthProviderMutation(
  mutation: AuthProviderSettingMutation,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<AuthProviderSettingMutation> {
  if (mutation.value === null) return mutation;
  if (!AUTH_PROVIDER_SECRET_KEYS.has(mutation.shortKey)) return mutation;
  if (!dataEncryptionSecrets) {
    throw new Error(
      "data encryption secrets required to store auth provider secret settings",
    );
  }
  return {
    shortKey: mutation.shortKey,
    value: await encryptSecret(dataEncryptionSecrets, mutation.value),
  };
}

async function applyAuthProviderSettingMutations(
  db: Db,
  mutations: AuthProviderSettingMutation[],
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<void> {
  if (mutations.length === 0) return;

  const sealed = await Promise.all(
    mutations.map((mutation) =>
      sealAuthProviderMutation(mutation, dataEncryptionSecrets)
    ),
  );

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY))
      .for("update")
      .limit(1);

    const obj = readSystemAuthProvidersObject(rows[0]?.value);

    for (const { shortKey, value } of sealed) {
      if (value === null) {
        delete obj[shortKey];
      } else {
        obj[shortKey] = value;
      }
    }

    if (Object.keys(obj).length === 0) {
      await tx.delete(setting).where(
        eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY),
      );
      return;
    }

    await tx
      .insert(setting)
      .values({ key: SYSTEM_AUTH_PROVIDERS_DB_KEY, value: obj })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: obj,
          updatedAt: new Date().toISOString(),
        },
      });
  });
}

/**
 * Decrypt a DB-stored auth-provider secret for runtime use.
 *
 * DB values for `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` must be
 * `tpsecret` envelopes. Plaintext or other non-envelope material fails closed
 * (`undefined`) so the setting resolves as unset rather than activating an
 * unsealed secret.
 */
async function decryptAuthProviderSecretValue(
  value: string,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<string | undefined> {
  if (!isSealedEnvelope(value)) {
    return undefined;
  }
  if (!dataEncryptionSecrets) {
    return undefined;
  }
  try {
    return await decryptSecret(dataEncryptionSecrets, value);
  } catch {
    return undefined;
  }
}

async function loadAuthProviderSettingDbValues(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<Map<string, string>> {
  const obj = await loadSystemAuthProvidersObject(db);
  const out = new Map<string, string>();

  for (const shortKey of AUTH_PROVIDER_SETTING_SHORT_KEYS) {
    const stored = obj[shortKey];
    if (stored === undefined || stored === "") continue;

    if (AUTH_PROVIDER_SECRET_KEYS.has(shortKey)) {
      const plaintext = await decryptAuthProviderSecretValue(
        stored,
        dataEncryptionSecrets,
      );
      if (plaintext !== undefined && plaintext !== "") {
        out.set(fullAuthProviderSettingKey(shortKey), plaintext);
      }
      continue;
    }

    out.set(fullAuthProviderSettingKey(shortKey), stored);
  }

  return out;
}

async function createAuthProviderSettingsResolver(
  db: Db | undefined,
  env: Record<string, string | undefined>,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<SettingsResolver> {
  const dbValues = db
    ? await loadAuthProviderSettingDbValues(db, dataEncryptionSecrets)
    : new Map<string, string>();
  return new SettingsResolver({
    prefix: AUTH_PROVIDER_SETTINGS_PREFIX,
    keys: AUTH_PROVIDER_SETTINGS_SCHEMA,
    env,
    dbValues,
  });
}

/**
 * Presence-only DB values for {@link resolveConfiguredProviders}: secret keys
 * map to a non-empty placeholder when a *sealed* value is stored, never the
 * decrypted plaintext. A stored value that is not a sealed envelope must still
 * resolve as unset.
 */
async function loadAuthProviderSettingPresenceDbValues(
  db: Db,
): Promise<Map<string, string>> {
  const obj = await loadSystemAuthProvidersObject(db);
  const out = new Map<string, string>();
  for (const shortKey of AUTH_PROVIDER_SETTING_SHORT_KEYS) {
    const stored = obj[shortKey];
    if (stored === undefined || stored === "") continue;
    if (AUTH_PROVIDER_SECRET_KEYS.has(shortKey)) {
      if (isSealedEnvelope(stored)) {
        out.set(fullAuthProviderSettingKey(shortKey), "set");
      }
      continue;
    }
    out.set(fullAuthProviderSettingKey(shortKey), stored);
  }
  return out;
}

async function createAuthProviderPresenceResolver(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<SettingsResolver> {
  const dbValues = db
    ? await loadAuthProviderSettingPresenceDbValues(db)
    : new Map<string, string>();
  return new SettingsResolver({
    prefix: AUTH_PROVIDER_SETTINGS_PREFIX,
    keys: AUTH_PROVIDER_SETTINGS_SCHEMA,
    env,
    dbValues,
  });
}

function pairIsConfigured(
  clientId: string,
  clientSecret: string,
): boolean {
  return clientId.trim() !== "" && clientSecret.trim() !== "";
}

/**
 * Cheap public-availability check for `GET /api/client/v1/status`: which
 * OAuth providers have both a client id and a secret set, without decrypting
 * those secrets.
 */
export async function resolveConfiguredProviders(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<OAuthProviderId[]> {
  const resolver = await createAuthProviderPresenceResolver(db, env);
  const configured: OAuthProviderId[] = [];
  if (
    pairIsConfigured(
      resolver.resolve("GITHUB_CLIENT_ID").value,
      resolver.resolve("GITHUB_CLIENT_SECRET").value,
    )
  ) {
    configured.push("github");
  }
  if (
    pairIsConfigured(
      resolver.resolve("GOOGLE_CLIENT_ID").value,
      resolver.resolve("GOOGLE_CLIENT_SECRET").value,
    )
  ) {
    configured.push("google");
  }
  return configured;
}

function credentialsIfConfigured(
  clientId: string,
  clientSecret: string,
): AuthProviderCredentials | undefined {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id === "" || secret === "") return undefined;
  return { clientId: id, clientSecret: secret };
}

export async function resolveAuthProviderSettings(
  db: Db | undefined,
  env: Record<string, string | undefined>,
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<ResolvedAuthProviderSettings> {
  const resolver = await createAuthProviderSettingsResolver(
    db,
    env,
    dataEncryptionSecrets,
  );

  const keys = {} as Record<
    AuthProviderSettingShortKey,
    AuthProviderSettingMeta
  >;
  for (const shortKey of AUTH_PROVIDER_SETTING_SHORT_KEYS) {
    keys[shortKey] = metaFromResolved(
      shortKey,
      resolver.resolve(shortKey),
      resolver,
    );
  }

  const github = credentialsIfConfigured(
    keys.GITHUB_CLIENT_ID.value,
    keys.GITHUB_CLIENT_SECRET.value,
  );
  const google = credentialsIfConfigured(
    keys.GOOGLE_CLIENT_ID.value,
    keys.GOOGLE_CLIENT_SECRET.value,
  );

  return {
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
    keys,
  };
}

export type AuthProviderSettingApiEntry = {
  value: string | null;
  source: SettingSource;
  isEnvOverridden: boolean;
};

export function authProviderSettingsToApiShape(
  resolved: ResolvedAuthProviderSettings,
): Record<string, AuthProviderSettingApiEntry> {
  const out: Record<string, AuthProviderSettingApiEntry> = {};

  for (const shortKey of AUTH_PROVIDER_SETTING_SHORT_KEYS) {
    const meta = resolved.keys[shortKey];
    const isSecret = AUTH_PROVIDER_SECRET_KEYS.has(shortKey);

    if (meta.source === "env" && isSecret) {
      out[meta.fullKey] = {
        source: "env",
        value: null,
        isEnvOverridden: meta.isEnvOverridden,
      };
      continue;
    }

    if (meta.source === "db" && isSecret) {
      out[meta.fullKey] = {
        source: "db",
        value: "***",
        isEnvOverridden: meta.isEnvOverridden,
      };
      continue;
    }

    const value = meta.value.trim();
    out[meta.fullKey] = {
      source: meta.source,
      value: value === "" ? null : value,
      isEnvOverridden: meta.isEnvOverridden,
    };
  }

  return out;
}

export async function updateAuthProviderSettings(
  db: Db,
  env: Record<string, string | undefined>,
  updates: Record<string, string | null>,
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<ResolvedAuthProviderSettings> {
  const resolver = await createAuthProviderSettingsResolver(
    db,
    env,
    dataEncryptionSecrets,
  );
  const mutations = collectAuthProviderSettingMutations(resolver, updates);
  await applyAuthProviderSettingMutations(db, mutations, dataEncryptionSecrets);
  return await resolveAuthProviderSettings(db, env, dataEncryptionSecrets);
}

/**
 * True when any incoming update sets (not clears) an
 * `AUTH_PROVIDER_SECRET_KEYS` entry, which requires data-encryption secrets
 * to seal at rest.
 */
export function authProviderUpdatesRequireEncryption(
  updates: Record<string, string | null>,
): boolean {
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") continue;
    const shortKey = resolveShortKeyFromInput(key);
    if (shortKey && AUTH_PROVIDER_SECRET_KEYS.has(shortKey)) return true;
  }
  return false;
}

function resolveShortKeyFromInput(
  key: string,
): AuthProviderSettingShortKey | null {
  const trimmed = key.trim();
  if (!trimmed) return null;

  const prefix = `${AUTH_PROVIDER_SETTINGS_PREFIX}__`;
  const upper = trimmed.toUpperCase();
  const shortKey = upper.startsWith(prefix)
    ? upper.slice(prefix.length)
    : upper;

  if (
    (AUTH_PROVIDER_SETTING_SHORT_KEYS as readonly string[]).includes(shortKey)
  ) {
    return shortKey as AuthProviderSettingShortKey;
  }
  return null;
}
