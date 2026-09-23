/**
 * Instance-wide Let's Encrypt knobs for the control plane's own names.
 *
 * Persisted as one `setting` row (`INSTANCE_ACME_SETTINGS`). Per-hostname
 * issuance state lives on `hostname`, not here.
 *
 * Instance ACME is independent of every organization. This module must not
 * import the organization options module, must not read or write an
 * organization's ACME opt-in, and must not touch any `tls` table row.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { setting } from "../../db/schema.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import {
  normalizeSettingFullKey,
  type ResolvedSetting,
  type SettingSource,
  SettingsResolver,
} from "../settings/resolver.ts";

/** DB key for the single JSON row that stores instance ACME settings. */
export const INSTANCE_ACME_SETTINGS = "INSTANCE_ACME_SETTINGS";

export const INSTANCE_ACME_SETTINGS_PREFIX = "TURBOPANEL_INSTANCE_ACME";

export const LETS_ENCRYPT_DIRECTORY_URL =
  "https://acme-v02.api.letsencrypt.org/directory";

export const LETS_ENCRYPT_STAGING_DIRECTORY_URL =
  "https://acme-staging-v02.api.letsencrypt.org/directory";

export const INSTANCE_ACME_SETTING_SHORT_KEYS = [
  "CONTACT_EMAIL",
  "TOS_ACCEPTED",
  "DIRECTORY_URL",
  "USE_STAGING",
] as const;

export type InstanceAcmeSettingShortKey =
  (typeof INSTANCE_ACME_SETTING_SHORT_KEYS)[number];

export const INSTANCE_ACME_SETTINGS_SCHEMA: Record<
  InstanceAcmeSettingShortKey,
  string | undefined
> = {
  CONTACT_EMAIL: "",
  TOS_ACCEPTED: "false",
  DIRECTORY_URL: LETS_ENCRYPT_DIRECTORY_URL,
  USE_STAGING: "false",
};

/**
 * No instance ACME field is sealed today. The set stays so a later account
 * key can join the same encryption gate the email and OAuth settings use.
 */
export const INSTANCE_ACME_SECRET_KEYS: ReadonlySet<
  InstanceAcmeSettingShortKey
> = new Set();

const CAMEL_TO_SHORT: Record<string, InstanceAcmeSettingShortKey> = {
  contactEmail: "CONTACT_EMAIL",
  tosAccepted: "TOS_ACCEPTED",
  directoryUrl: "DIRECTORY_URL",
  useStaging: "USE_STAGING",
};

export type InstanceAcmeSettingMeta = {
  fullKey: string;
  value: string;
  source: SettingSource;
  isEnvOverridden: boolean;
  isDbSet: boolean;
};

export type ResolvedInstanceAcmeSettings = {
  contactEmail: string;
  tosAccepted: boolean;
  directoryUrl: string;
  useStaging: boolean;
  keys: Record<InstanceAcmeSettingShortKey, InstanceAcmeSettingMeta>;
};

export type InstanceAcmeSettingApiEntry = {
  value: string | null;
  source: SettingSource;
};

function fullKey(shortKey: InstanceAcmeSettingShortKey): string {
  return normalizeSettingFullKey(INSTANCE_ACME_SETTINGS_PREFIX, shortKey);
}

function isShortKey(value: string): value is InstanceAcmeSettingShortKey {
  return (INSTANCE_ACME_SETTING_SHORT_KEYS as readonly string[]).includes(
    value,
  );
}

function resolveShortKey(key: string): InstanceAcmeSettingShortKey | undefined {
  if (isShortKey(key)) return key;
  const fromCamel = CAMEL_TO_SHORT[key];
  if (fromCamel) return fromCamel;
  const upper = key.trim().toUpperCase();
  if (isShortKey(upper)) return upper;
  const prefixed = `${INSTANCE_ACME_SETTINGS_PREFIX}__`;
  if (upper.startsWith(prefixed)) {
    const short = upper.slice(prefixed.length);
    if (isShortKey(short)) return short;
  }
  return undefined;
}

function readStoredObject(value: unknown): Record<string, string> {
  if (
    value === null || value === undefined || typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "boolean") out[key] = raw ? "true" : "false";
  }
  return out;
}

async function loadStoredObject(db: Db): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(eq(setting.key, INSTANCE_ACME_SETTINGS));
  const row = rows.find((item) => item.key === INSTANCE_ACME_SETTINGS);
  return readStoredObject(row?.value);
}

function parseFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function metaFromResolved(
  shortKey: InstanceAcmeSettingShortKey,
  resolved: ResolvedSetting,
  resolver: SettingsResolver,
): InstanceAcmeSettingMeta {
  return {
    fullKey: fullKey(shortKey),
    value: resolved.value,
    source: resolved.source,
    isEnvOverridden: resolver.isEnvOverridden(shortKey),
    isDbSet: resolver.isDbSet(shortKey),
  };
}

async function createResolver(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<SettingsResolver> {
  const dbValues = new Map<string, string>();
  if (db) {
    const stored = await loadStoredObject(db);
    for (const shortKey of INSTANCE_ACME_SETTING_SHORT_KEYS) {
      const value = stored[shortKey];
      if (value !== undefined && value !== "") {
        dbValues.set(fullKey(shortKey), value);
      }
    }
  }
  return new SettingsResolver({
    prefix: INSTANCE_ACME_SETTINGS_PREFIX,
    keys: INSTANCE_ACME_SETTINGS_SCHEMA,
    env,
    dbValues,
  });
}

function resolvedFromResolver(
  resolver: SettingsResolver,
): ResolvedInstanceAcmeSettings {
  const keys = {} as Record<
    InstanceAcmeSettingShortKey,
    InstanceAcmeSettingMeta
  >;
  for (const shortKey of INSTANCE_ACME_SETTING_SHORT_KEYS) {
    keys[shortKey] = metaFromResolved(
      shortKey,
      resolver.resolve(shortKey),
      resolver,
    );
  }
  return {
    contactEmail: keys.CONTACT_EMAIL.value.trim(),
    tosAccepted: parseFlag(keys.TOS_ACCEPTED.value),
    directoryUrl: keys.DIRECTORY_URL.value.trim() || LETS_ENCRYPT_DIRECTORY_URL,
    useStaging: parseFlag(keys.USE_STAGING.value),
    keys,
  };
}

export async function resolveInstanceAcmeSettings(
  db: Db | undefined,
  env: Record<string, string | undefined>,
  _dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<ResolvedInstanceAcmeSettings> {
  const resolver = await createResolver(db, env);
  return resolvedFromResolver(resolver);
}

export function instanceAcmeSettingsToApiShape(
  resolved: ResolvedInstanceAcmeSettings,
): Record<string, InstanceAcmeSettingApiEntry> {
  const out: Record<string, InstanceAcmeSettingApiEntry> = {};
  for (const shortKey of INSTANCE_ACME_SETTING_SHORT_KEYS) {
    const meta = resolved.keys[shortKey];
    const value = meta.value.trim();
    out[meta.fullKey] = {
      source: meta.source,
      value: value === "" ? null : value,
    };
  }
  return out;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function storedAcmeValue(
  shortKey: InstanceAcmeSettingShortKey,
  value: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (shortKey === "TOS_ACCEPTED" || shortKey === "USE_STAGING") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized !== "true" && normalized !== "false" && normalized !== "1" &&
      normalized !== "0"
    ) {
      return { ok: false, error: `Invalid value for ${shortKey}` };
    }
    return { ok: true, value: parseFlag(value) ? "true" : "false" };
  }
  const trimmed = value.trim();
  if (!isAllowedValue(shortKey, trimmed)) {
    return { ok: false, error: `Invalid value for ${shortKey}` };
  }
  return { ok: true, value: trimmed };
}

function isAllowedValue(
  shortKey: InstanceAcmeSettingShortKey,
  value: string,
): boolean {
  if (shortKey === "CONTACT_EMAIL") {
    if (value === "") return true;
    return value.includes("@") && !value.includes(" ");
  }
  if (shortKey === "DIRECTORY_URL") {
    if (value === "") return true;
    return isHttpsUrl(value);
  }
  if (shortKey === "TOS_ACCEPTED" || shortKey === "USE_STAGING") {
    return value === "true" || value === "false";
  }
  return false;
}

export type InstanceAcmeUpdateResult =
  | { ok: true; settings: ResolvedInstanceAcmeSettings }
  | { ok: false; error: string };

/**
 * True when an update sets a sealed field. None are sealed today, so this
 * stays false and the admin route allows the write without an encryption key.
 */
export function instanceAcmeUpdatesRequireEncryption(
  updates: Record<string, string | null>,
): boolean {
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const shortKey = resolveShortKey(key);
    if (shortKey && INSTANCE_ACME_SECRET_KEYS.has(shortKey)) return true;
  }
  return false;
}

export async function updateInstanceAcmeSettings(
  db: Db,
  env: Record<string, string | undefined>,
  updates: Record<string, string | null>,
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<InstanceAcmeUpdateResult> {
  const current = await loadStoredObject(db);
  const resolver = await createResolver(db, env);
  const next: Record<string, string> = { ...current };

  for (const [key, value] of Object.entries(updates)) {
    const shortKey = resolveShortKey(key);
    if (!shortKey) {
      return { ok: false, error: `Unknown instance ACME setting: ${key}` };
    }
    if (resolver.isEnvOverridden(shortKey)) continue;
    if (value === null || value.trim() === "") {
      delete next[shortKey];
      continue;
    }
    const stored = storedAcmeValue(shortKey, value);
    if (!stored.ok) return stored;
    next[shortKey] = stored.value;
  }

  await db
    .insert(setting)
    .values({
      key: INSTANCE_ACME_SETTINGS,
      value: next,
    })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value: next,
        updatedAt: new Date().toISOString(),
      },
    });

  return {
    ok: true,
    settings: await resolveInstanceAcmeSettings(db, env, dataEncryptionSecrets),
  };
}
