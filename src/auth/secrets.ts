import { generateSecret } from "../generate-secret.ts";

export type VersionedSecret = {
  version: number;
  value: string;
};

export type SecretsConfig = {
  versioned: VersionedSecret[];
  legacy: string | null;
};

export type DerivedSecretsConfig = {
  current: { version: number | null; key: CryptoKey };
  fallbacks: Array<{ version: number | null; key: CryptoKey }>;
  legacyKey: CryptoKey | null;
};

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type SecretsRuntime = "deno" | "workers";

function isProductionDenoMode(): boolean {
  if (typeof Deno === "undefined") return false;
  const mode = Deno.env.get("TURBOPANEL_UI_MODE")?.trim().toLowerCase();
  return mode === "static";
}

function allowEphemeralSecrets(runtime: SecretsRuntime): boolean {
  return runtime === "deno" && !isProductionDenoMode();
}

export function parseSecretsEnv(
  secretEnv: string | undefined,
  secretsEnv: string | undefined,
  runtime: SecretsRuntime = "deno",
): SecretsConfig {
  secretEnv = normalizeEnvValue(secretEnv);
  secretsEnv = normalizeEnvValue(secretsEnv);

  let versioned: VersionedSecret[] = [];

  if (secretsEnv !== undefined) {
    const entries = secretsEnv.split(",");
    versioned = entries.map((entry, index) => {
      const colonIndex = entry.indexOf(":");
      if (colonIndex === -1) {
        throw new Error(
          `Invalid secrets entry at index ${index}: expected "version:secret", got "${entry}"`,
        );
      }
      const versionStr = entry.slice(0, colonIndex);
      const value = entry.slice(colonIndex + 1);
      const version = Number.parseInt(versionStr, 10);
      if (!Number.isInteger(version) || versionStr.length === 0) {
        throw new Error(
          `Invalid version in secrets entry at index ${index}: "${versionStr}" is not a valid integer`,
        );
      }
      return { version, value };
    });
    versioned.sort((a, b) => b.version - a.version);
  }

  let legacy: string | null = secretEnv ?? null;

  if (secretEnv === undefined && secretsEnv === undefined) {
    if (!allowEphemeralSecrets(runtime)) {
      throw new Error("TURBOPANEL_SECRET or TURBOPANEL_SECRETS is required");
    }
    console.warn("[auth] No secret configured — using ephemeral random secret (dev only)");
    legacy = generateSecret();
  }

  return { versioned, legacy };
}

export async function deriveKey(
  rootSecret: string,
  purpose: string,
): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(rootSecret);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("turbopanel"),
      info: new TextEncoder().encode(purpose),
    },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function deriveSecretsConfig(
  config: SecretsConfig,
  purpose: string,
): Promise<DerivedSecretsConfig> {
  const versionedKeys = await Promise.all(
    config.versioned.map((entry) => deriveKey(entry.value, purpose)),
  );
  const legacyKey = config.legacy !== null
    ? await deriveKey(config.legacy, purpose)
    : null;

  if (config.versioned.length > 0) {
    return {
      current: { version: config.versioned[0].version, key: versionedKeys[0] },
      fallbacks: config.versioned.slice(1).map((entry, i) => ({
        version: entry.version,
        key: versionedKeys[i + 1],
      })),
      legacyKey,
    };
  }

  if (legacyKey === null) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET or TURBOPANEL_SECRETS",
    );
  }

  return {
    current: { version: null, key: legacyKey },
    fallbacks: [],
    legacyKey,
  };
}
