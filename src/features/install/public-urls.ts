import type { Db } from "../../db/connection.ts";
import {
  getInstanceHostnamesLegacyShim,
  replacePublicUrlsWithPlatformCa,
} from "./instance-hostnames.ts";

export const PUBLIC_URLS_SETTING_KEY = "TURBOPANEL_PUBLIC_URLS";

/**
 * Self-hosted control-plane listener. Managed Caddy binds `:8443` only.
 * Bare hosts and the discovered-address fallback dial this port.
 * An already valid public HTTPS origin (Workers, a tunnel, any explicit
 * port including `:443`) keeps its own port via {@link publicHttpsOrigin}.
 */
export const PANEL_HTTPS_PORT = "8443";

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

function isValidPublicHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname);
  return host.length > 0 && host !== "null" && host !== "localhost";
}

function hasNonOriginUrlParts(url: URL): boolean {
  return (url.pathname !== "/" && url.pathname !== "") || Boolean(url.search) ||
    Boolean(url.hash);
}

/**
 * True when the URL is an https origin with a valid public host and no extras.
 */
function isHttpsOriginUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (!isValidPublicHost(url.hostname)) return false;
  if (url.username || url.password) return false;
  return !hasNonOriginUrlParts(url);
}

/**
 * Bracket an IPv6 literal once. `URL.hostname` already includes brackets, so
 * those are stripped before a new pair is added.
 */
function formatHostForUrl(host: string, port?: string): string {
  const bare = stripIpv6Brackets(host);
  const hostPart = bare.includes(":") ? `[${bare}]` : bare;
  return port ? `${hostPart}:${port}` : hostPart;
}

/**
 * Self-hosted listener origin. HTTPS always dials {@link PANEL_HTTPS_PORT}.
 */
function httpsOriginWithExplicitPort(url: URL): string {
  return `https://${formatHostForUrl(url.hostname, PANEL_HTTPS_PORT)}`;
}

/**
 * Port kept on an already valid public HTTPS origin. Omitted and `:443`
 * stay the standard origin. Any other explicit port is unchanged.
 */
function preservedHttpsPort(url: URL): string | undefined {
  if (url.port === "" || url.port === "443") return undefined;
  return url.port;
}

/**
 * HTTPS origin that keeps the port of an already valid public URL.
 *
 * Workers (`https://turbopanel.app`), `TURBOPANEL_BASE_URL`, and externally
 * forwarded hosts are reached on their own port — usually 443. Plaintext
 * `http:` is rejected. A bare host is not an edge origin; the self-hosted
 * dial is {@link publicUrlEntryToInstallOrigin}.
 */
export function publicHttpsOrigin(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed || !trimmed.includes("://")) return null;
  try {
    const url = new URL(trimmed);
    if (!isHttpsOriginUrl(url)) return null;
    return `https://${formatHostForUrl(url.hostname, preservedHttpsPort(url))}`;
  } catch {
    return null;
  }
}

/**
 * Parse a bare host / host:port entry (no scheme) into a URL, or null if invalid.
 */
function tryParseBareHostEntry(trimmed: string): URL | null {
  if (/[/?#@]/.test(trimmed)) return null;
  try {
    const url = new URL(`https://${trimmed}`);
    if (!isValidPublicHost(url.hostname)) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url;
  } catch {
    return null;
  }
}

/** Parse one URL or bare host into a normalized hostname, or null to skip. */
export function hostFromPublicUrlEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return null;
  }
  host = stripIpv6Brackets(host);
  if (!isValidPublicHost(host)) return null;
  return host;
}

/**
 * Normalize a self-hosted listener name to `https://<host>:8443`.
 *
 * Accepts persisted origin strings and bare host / host:port forms. This is
 * the Caddy dial for stored panel hostnames and webhook origins. Hosted and
 * forwarded public origins use {@link publicHttpsOrigin} so an implicit
 * port 443 is left alone. Plaintext `http:` is rejected.
 */
export function publicUrlEntryToInstallOrigin(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes("://")) {
      const url = new URL(trimmed);
      if (!isHttpsOriginUrl(url)) return null;
      return httpsOriginWithExplicitPort(url);
    }

    const url = tryParseBareHostEntry(trimmed);
    if (!url) return null;

    return `https://${formatHostForUrl(url.hostname, PANEL_HTTPS_PORT)}`;
  } catch {
    return null;
  }
}

function parseAndNormalizePublicUrlEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      if (!isHttpsOriginUrl(url)) return null;
      return httpsOriginWithExplicitPort(url);
    } catch {
      return null;
    }
  }

  const url = tryParseBareHostEntry(trimmed);
  if (!url) return null;

  const host = stripIpv6Brackets(url.hostname);
  if (!url.port) return formatHostForUrl(host);
  return formatHostForUrl(host, PANEL_HTTPS_PORT);
}

export type ParsePublicUrlEntriesResult =
  | { ok: true; urls: string[] }
  | { ok: false; error: string; invalid: string[] };

/**
 * Parse and validate public URL entries.
 *
 * Plaintext `http:` entries are rejected and reported as invalid.
 */
export function parsePublicUrlEntries(
  raw: string[],
): ParsePublicUrlEntriesResult {
  const validated: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const normalized = parseAndNormalizePublicUrlEntry(entry);
    if (!normalized) {
      invalid.push(entry);
      continue;
    }
    const dedupeKey = publicUrlEntryToInstallOrigin(normalized) ?? normalized;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    validated.push(normalized);
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      error: "One or more public URL entries are invalid",
      invalid,
    };
  }

  return { ok: true, urls: validated };
}

/**
 * Flat public-URL list. Storage is the `hostname` table (`platform-ca` when
 * written here). `TURBOPANEL_PUBLIC_URLS` is kept as a projection of that list.
 */
export async function getPublicUrls(db: Db): Promise<string[]> {
  return await getInstanceHostnamesLegacyShim(db);
}

/** Replace the published names. Entries written here use source `platform-ca`. */
export async function setPublicUrls(db: Db, urls: string[]): Promise<void> {
  await replacePublicUrlsWithPlatformCa(db, urls);
}
