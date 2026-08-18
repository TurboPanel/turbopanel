/**
 * Operator host defaults that cascade organization → datacenter → server.
 *
 * Most-specific configured value wins. Built-in fallbacks apply only when no
 * layer set the key (`sshPort` → 22). Timezone keeps its own enforce/override
 * resolver in `server-metadata.ts`; NTP/SSH/TurboFabric defaults live here.
 *
 * These are desired configuration — they do not rewrite sshd or fan out NTP
 * commands on save. Apply-to-host stays on `server.ntp.set` / timezone
 * commands. TurboFabric mesh enable remains `PUT …/fabric`.
 */

import { isValidNtpServer } from "./commands/schemas.ts";

export const DEFAULT_SSH_PORT = 22;
export const SSH_PORT_MIN = 1;
export const SSH_PORT_MAX = 65535;

export type HostDefaultsSource = "server" | "datacenter" | "organization";

export type NtpDefaults = {
  enabled?: boolean;
  servers?: string[];
  fallbackServers?: string[];
};

export type HostDefaultsLayer = {
  sshPort?: number;
  ntp?: NtpDefaults;
  /** Organization layer only — ignored on datacenter/server. */
  defaultFabricEnabled?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined<T>(
  layers: ReadonlyArray<{ value: T | undefined; source: HostDefaultsSource }>,
): { value: T | undefined; source: HostDefaultsSource | null } {
  for (const layer of layers) {
    if (layer.value !== undefined) {
      return { value: layer.value, source: layer.source };
    }
  }
  return { value: undefined, source: null };
}

/** True when `value` is an integer in the TCP port range (1–65535). */
export function isValidSshPort(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SSH_PORT_MIN &&
    value <= SSH_PORT_MAX;
}

/**
 * Parse an SSH port PUT/PATCH value. `null` clears the layer (inherit parent).
 */
export function parseSshPortInput(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!isValidSshPort(value)) return { ok: false };
  return { ok: true, value };
}

/** Lenient jsonb read — invalid/missing → omitted. */
export function parseSshPort(value: unknown): number | undefined {
  return isValidSshPort(value) ? value : undefined;
}

function parseOptionalNtpHostList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const hosts: string[] = [];
  for (const entry of value) {
    if (!isValidNtpServer(entry)) return undefined;
    hosts.push(entry);
  }
  return hosts;
}

function parseNtpHostListInput(
  value: unknown,
): { ok: true; value: string[] } | { ok: false } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false };
  const hosts: string[] = [];
  for (const entry of value) {
    if (!isValidNtpServer(entry)) return { ok: false };
    hosts.push(entry);
  }
  return { ok: true, value: hosts };
}

/** Lenient jsonb read for desired NTP defaults. */
export function parseNtpDefaults(value: unknown): NtpDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const ntp: NtpDefaults = {};
  if (typeof value.enabled === "boolean") ntp.enabled = value.enabled;
  const servers = parseOptionalNtpHostList(value.servers);
  if (servers) ntp.servers = servers;
  const fallbackServers = parseOptionalNtpHostList(value.fallbackServers);
  if (fallbackServers) ntp.fallbackServers = fallbackServers;
  return Object.keys(ntp).length > 0 ? ntp : undefined;
}

/**
 * Parse an NTP defaults PUT/PATCH value. `null` clears the layer.
 * A provided object must include at least one of `enabled`, `servers`, or
 * `fallbackServers`. Empty host arrays are rejected.
 */
export function parseNtpDefaultsInput(
  value: unknown,
): { ok: true; value: NtpDefaults | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };

  const ntp: NtpDefaults = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") return { ok: false };
    ntp.enabled = value.enabled;
  }
  if ("servers" in value) {
    const parsed = parseNtpHostListInput(value.servers);
    if (!parsed.ok) return { ok: false };
    ntp.servers = parsed.value;
  }
  if ("fallbackServers" in value) {
    const parsed = parseNtpHostListInput(value.fallbackServers);
    if (!parsed.ok) return { ok: false };
    ntp.fallbackServers = parsed.value;
  }
  if (Object.keys(ntp).length === 0) return { ok: false };
  return { ok: true, value: ntp };
}

export function parseDefaultFabricEnabledInput(
  value: unknown,
): { ok: true; value: boolean | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "boolean") return { ok: false };
  return { ok: true, value };
}

export function resolveEffectiveSshPort(
  server: HostDefaultsLayer | null | undefined,
  datacenter: HostDefaultsLayer | null | undefined,
  organization: HostDefaultsLayer | null | undefined,
): { sshPort: number; source: HostDefaultsSource | null } {
  const resolved = firstDefined([
    { value: server?.sshPort, source: "server" },
    { value: datacenter?.sshPort, source: "datacenter" },
    { value: organization?.sshPort, source: "organization" },
  ]);
  if (resolved.value !== undefined) {
    return { sshPort: resolved.value, source: resolved.source };
  }
  return { sshPort: DEFAULT_SSH_PORT, source: null };
}

export function resolveEffectiveNtpDefaults(
  server: HostDefaultsLayer | null | undefined,
  datacenter: HostDefaultsLayer | null | undefined,
  organization: HostDefaultsLayer | null | undefined,
): { ntp: NtpDefaults | null; source: HostDefaultsSource | null } {
  const resolved = firstDefined([
    { value: server?.ntp, source: "server" },
    { value: datacenter?.ntp, source: "datacenter" },
    { value: organization?.ntp, source: "organization" },
  ]);
  return {
    ntp: resolved.value ?? null,
    source: resolved.value ? resolved.source : null,
  };
}
