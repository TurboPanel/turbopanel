import { generateSecret, SECRET_LENGTH } from "../../generate-secret.ts";
import { compatLogWarn } from "../../log-compat.ts";
import { isExplicitDevelopmentMode } from "../../dev-mode.ts";

/**
 * Minimum accepted length for a configured root secret. Matches the canonical
 * generator ({@link SECRET_LENGTH} chars from `src/generate-secret.ts`). Any
 * shorter value is rejected at boot as insufficient-entropy.
 */
export const MIN_SECRET_LENGTH = SECRET_LENGTH;

function assertValidSecretValue(value: string, context: string): void {
  if (value.length === 0) {
    throw new Error(`${context}: secret value must not be empty`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${context}: secret is too short (${value.length} chars; minimum ${MIN_SECRET_LENGTH})`,
    );
  }
}

export type VersionedSecret = {
  version: number;
  value: string;
};

export type SecretsConfig = {
  versioned: VersionedSecret[];
};

export type DerivedSecretsConfig = {
  current: { version: number; key: CryptoKey };
  fallbacks: Array<{ version: number; key: CryptoKey }>;
};

/**
 * Direct version→key lookup against a derived keyring. Returns the matching
 * current or fallback key, or `null` when the version is absent.
 */
export function findKeyForVersion(
  secrets: DerivedSecretsConfig,
  version: number,
): CryptoKey | null {
  if (secrets.current.version === version) return secrets.current.key;
  const fallback = secrets.fallbacks.find((f) => f.version === version);
  return fallback?.key ?? null;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type SecretsRuntime = "deno" | "workers";

/**
 * The dev-only ephemeral random secret fallback is gated behind an **explicit**
 * development flag (see {@link isExplicitDevelopmentMode}) — never implicit mode
 * inference. Outside explicit dev mode a missing secret is a hard boot failure.
 */
function allowEphemeralSecrets(runtime: SecretsRuntime): boolean {
  return runtime === "deno" && isExplicitDevelopmentMode();
}

function parseVersionedSecrets(secretsEnv: string): VersionedSecret[] {
  const entries = secretsEnv.split(",");
  const versioned = entries.map((entry, index) => {
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Invalid secrets entry at index ${index}: expected "version:secret", got "${entry}"`,
      );
    }
    const versionStr = entry.slice(0, colonIndex).trim();
    const value = entry.slice(colonIndex + 1);
    if (!/^\d+$/.test(versionStr)) {
      throw new Error(
        `Invalid version in secrets entry at index ${index}: "${versionStr}" is not a positive integer`,
      );
    }
    const version = Number.parseInt(versionStr, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `Invalid version in secrets entry at index ${index}: "${versionStr}" is not a positive integer`,
      );
    }
    assertValidSecretValue(value, `secrets entry at index ${index}`);
    return { version, value };
  });

  const seen = new Set<number>();
  for (const entry of versioned) {
    if (seen.has(entry.version)) {
      throw new Error(
        `Duplicate secret version ${entry.version} in TURBOPANEL_SECRETS`,
      );
    }
    seen.add(entry.version);
  }

  // Order-as-written is authoritative: versioned[0] is current/signing.
  // Warn (do not reorder) when operators listed keys off descending-version order.
  if (versioned.length > 1) {
    let descending = true;
    for (let i = 1; i < versioned.length; i++) {
      if (versioned[i].version >= versioned[i - 1].version) {
        descending = false;
        break;
      }
    }
    if (!descending) {
      compatLogWarn(
        "auth",
        "TURBOPANEL_SECRETS entries are not listed in descending version order; " +
          "the first entry is treated as current — list highest version first",
      );
    }
  }

  return versioned;
}

export type SecretEnvVars = {
  TURBOPANEL_SECRET?: string;
  TURBOPANEL_SECRETS?: string;
};

/**
 * Resolve the root secret from process / Worker env.
 *
 * `TURBOPANEL_SECRET` is the normal single current secret (bare value, version 1).
 * `TURBOPANEL_SECRETS` is the optional versioned keyring (`2:new,1:old`) used
 * when rotating. When the keyring is set it is the full list and takes
 * precedence so a rotation deploy does not need to clear the singular binding.
 */
export function parseSecretsFromEnv(
  vars: SecretEnvVars,
  runtime: SecretsRuntime = "deno",
): SecretsConfig {
  const secrets = normalizeEnvValue(vars.TURBOPANEL_SECRETS);
  if (secrets !== undefined) {
    return parseSecretsEnv(secrets, runtime);
  }
  const secret = normalizeEnvValue(vars.TURBOPANEL_SECRET);
  if (secret !== undefined) {
    assertValidSecretValue(secret, "TURBOPANEL_SECRET");
    return { versioned: [{ version: 1, value: secret }] };
  }
  return parseSecretsEnv(undefined, runtime);
}

export function parseSecretsEnv(
  secretsEnv: string | undefined,
  runtime: SecretsRuntime = "deno",
): SecretsConfig {
  secretsEnv = normalizeEnvValue(secretsEnv);

  let versioned: VersionedSecret[] = [];

  if (secretsEnv !== undefined) {
    versioned = parseVersionedSecrets(secretsEnv);
  }

  if (secretsEnv === undefined) {
    if (!allowEphemeralSecrets(runtime)) {
      throw new Error("TURBOPANEL_SECRET is required");
    }
    compatLogWarn('auth', 'No secret configured — using ephemeral random secret (dev only)');
    versioned = [{ version: 1, value: generateSecret() }];
  }

  return { versioned };
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

export async function deriveEncryptionKey(
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
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveSecretsConfig(
  config: SecretsConfig,
  purpose: string,
): Promise<DerivedSecretsConfig> {
  if (config.versioned.length === 0) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET",
    );
  }

  const versionedKeys = await Promise.all(
    config.versioned.map((entry) => deriveKey(entry.value, purpose)),
  );

  return {
    current: { version: config.versioned[0].version, key: versionedKeys[0] },
    fallbacks: config.versioned.slice(1).map((entry, i) => ({
      version: entry.version,
      key: versionedKeys[i + 1],
    })),
  };
}

export async function deriveEncryptionSecretsConfig(
  config: SecretsConfig,
  purpose: string,
): Promise<DerivedSecretsConfig> {
  if (config.versioned.length === 0) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET",
    );
  }

  const versionedKeys = await Promise.all(
    config.versioned.map((entry) => deriveEncryptionKey(entry.value, purpose)),
  );

  return {
    current: { version: config.versioned[0].version, key: versionedKeys[0] },
    fallbacks: config.versioned.slice(1).map((entry, i) => ({
      version: entry.version,
      key: versionedKeys[i + 1],
    })),
  };
}
