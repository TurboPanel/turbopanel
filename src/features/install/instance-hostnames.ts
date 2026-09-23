/**
 * Control-plane public hostnames.
 *
 * Each row is one entry operators publish for this instance, with a
 * certificate source and any Let's Encrypt attempt state. The legacy
 * `TURBOPANEL_PUBLIC_URLS` setting remains a flat projection of the `origin`
 * table, so existing readers keep calling `getPublicUrls` / `setPublicUrls`.
 *
 * Instance ACME is independent of every organization. This module must not
 * import the organization options module, must not read or write an
 * organization's ACME opt-in, and must not touch any `tls` table row.
 */

import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
  setting,
} from "../../db/schema.ts";
import { coversHostname } from "../../lib/tls/match.ts";
import { isLoopbackOrPrivateHostname } from "./install-tls.ts";
import {
  hostFromPublicUrlEntry,
  parsePublicUrlEntries,
  PUBLIC_URLS_SETTING_KEY,
} from "./public-urls.ts";

export const INSTANCE_HOSTNAME_SOURCES = [
  "platform-ca",
  "uploaded",
  "lets-encrypt",
] as const;

export type InstanceHostnameSource = (typeof INSTANCE_HOSTNAME_SOURCES)[number];

export type InstanceHostnameStatus = "ready" | "pending" | "failed" | "expired";

export type InstanceHostnameRecord = {
  id: string;
  host: string;
  source: InstanceHostnameSource;
  uploadedCertId: string | null;
  status: InstanceHostnameStatus;
  notAfter: string | null;
  acmeLastAttemptAt: string | null;
  acmeLastError: string | null;
};

export type InstanceHostnameFailure = {
  ok: false;
  error: string;
  invalid: string[];
};

export type InstanceHostnameEntry = {
  host: string;
  source: InstanceHostnameSource;
  uploadedCertId: string | null;
};

type StoredHostname = {
  id: string;
  host: string;
  source: InstanceHostnameSource;
  uploadedCertId: string | null;
  acmeLastAttemptAt: string | null;
  acmeLastError: string | null;
  notAfter: string | null;
  createdAt: string;
  updatedAt: string;
};

type HostnameRow = {
  id: string;
  host: string;
  source: string;
  uploadedCertId: string | null;
  acmeLastAttemptAt: string | null;
  acmeLastError: string | null;
  notAfter: string | null;
  createdAt: string;
  updatedAt: string;
};

function isHostnameSource(value: string): value is InstanceHostnameSource {
  return value === "platform-ca" || value === "uploaded" ||
    value === "lets-encrypt";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stampAt(index: number): string {
  return new Date(Date.now() + index).toISOString();
}

function byCreated(a: StoredHostname, b: StoredHostname): number {
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

function mapStored(row: HostnameRow): StoredHostname {
  return {
    id: row.id,
    host: row.host,
    source: isHostnameSource(row.source) ? row.source : "platform-ca",
    uploadedCertId: row.uploadedCertId,
    acmeLastAttemptAt: row.acmeLastAttemptAt,
    acmeLastError: row.acmeLastError,
    notAfter: row.notAfter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function deriveInstanceHostnameStatus(
  row: {
    source: InstanceHostnameSource;
    acmeLastError: string | null;
    notAfter: string | null;
  },
  now = Date.now(),
): InstanceHostnameStatus {
  const error = row.acmeLastError?.trim() ?? "";
  if (error !== "") return "failed";
  if (row.notAfter) {
    const expiry = Date.parse(row.notAfter);
    if (!Number.isNaN(expiry) && expiry <= now) return "expired";
    if (!Number.isNaN(expiry)) return "ready";
  }
  if (row.source === "lets-encrypt") return "pending";
  return "ready";
}

function toRecord(row: StoredHostname): InstanceHostnameRecord {
  return {
    id: row.id,
    host: row.host,
    source: row.source,
    uploadedCertId: row.uploadedCertId,
    status: deriveInstanceHostnameStatus(row),
    notAfter: row.notAfter,
    acmeLastAttemptAt: row.acmeLastAttemptAt,
    acmeLastError: row.acmeLastError,
  };
}

/**
 * Reject Let's Encrypt for a name the public ACME service cannot issue:
 * loopback or private hosts, and wildcards.
 */
export function validateHostnameSource(
  host: string,
  source: InstanceHostnameSource,
): { ok: true } | InstanceHostnameFailure {
  const hostname = hostFromPublicUrlEntry(host);
  if (!hostname) {
    return {
      ok: false,
      error: "One or more public URL entries are invalid",
      invalid: [host],
    };
  }
  if (source !== "lets-encrypt") return { ok: true };
  if (isLoopbackOrPrivateHostname(hostname)) {
    return {
      ok: false,
      error:
        "Let's Encrypt cannot issue a certificate for a loopback or private hostname",
      invalid: [host],
    };
  }
  if (hostname.startsWith("*.")) {
    return {
      ok: false,
      error: "Let's Encrypt cannot issue a certificate for a wildcard hostname",
      invalid: [host],
    };
  }
  return { ok: true };
}

export function uploadedCertificateCoversHost(
  dnsNames: string[],
  host: string,
): boolean {
  const hostname = hostFromPublicUrlEntry(host);
  if (!hostname) return false;
  return coversHostname(dnsNames, hostname);
}

function coercePublicUrlValue(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string =>
      typeof entry === "string" && entry.trim() !== ""
    );
  }
  if (typeof raw !== "string") return [];
  return raw.split(",").map((entry) => entry.trim()).filter((entry) =>
    entry !== ""
  );
}

function legacyUrlsToStore(raw: string[]): string[] {
  const parsed = parsePublicUrlEntries(raw, { allowHttp: true });
  if (parsed.ok) return parsed.urls;
  const kept: string[] = [];
  for (const entry of raw) {
    const one = parsePublicUrlEntries([entry], { allowHttp: true });
    if (one.ok && one.urls[0]) kept.push(one.urls[0]);
  }
  return kept;
}

async function loadHostnameRows(db: Db): Promise<StoredHostname[]> {
  const rows = await db
    .select()
    .from(instanceHostname)
    .where(isNotNull(instanceHostname.id));
  return rows.map((row) => mapStored(row as HostnameRow)).sort(byCreated);
}

async function readLegacyPublicUrls(db: Db): Promise<string[]> {
  const rows = await db
    .select()
    .from(setting)
    .where(eq(setting.key, PUBLIC_URLS_SETTING_KEY));
  const row = rows.find((item) => item.key === PUBLIC_URLS_SETTING_KEY);
  if (!row) return [];
  return coercePublicUrlValue(row.value);
}

async function writeLegacyPublicUrls(db: Db, urls: string[]): Promise<void> {
  await db
    .insert(setting)
    .values({
      key: PUBLIC_URLS_SETTING_KEY,
      value: urls,
    })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value: urls,
        updatedAt: new Date().toISOString(),
      },
    });
}

function newPlatformCaRow(host: string, index: number): StoredHostname {
  const stamp = stampAt(index);
  return {
    id: crypto.randomUUID(),
    host,
    source: "platform-ca",
    uploadedCertId: null,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

async function insertHostnameRows(
  db: Db,
  rows: StoredHostname[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(instanceHostname).values(rows);
}

async function persistHostnameRows(
  db: Db,
  rows: StoredHostname[],
): Promise<void> {
  const ordered = [...rows].sort(byCreated);
  await db.transaction(async (tx) => {
    await tx.delete(instanceHostname).where(isNotNull(instanceHostname.id));
    await insertHostnameRows(tx, ordered);
    await writeLegacyPublicUrls(tx, ordered.map((row) => row.host));
  });
}

type UploadedCertHit = {
  id: string;
  dnsNames: string[];
  notAfter: string;
};

async function loadUploadedCertificates(db: Db): Promise<UploadedCertHit[]> {
  const rows = await db
    .select()
    .from(instanceUploadedCertificate)
    .where(isNotNull(instanceUploadedCertificate.id));
  return rows.map((row) => ({
    id: row.id,
    dnsNames: asStringArray(row.dnsNames),
    notAfter: row.notAfter,
  }));
}

function coverageFailure(
  host: string,
  found: boolean,
): InstanceHostnameFailure {
  if (!found) {
    return {
      ok: false,
      error: "Uploaded certificate was not found",
      invalid: [host],
    };
  }
  return {
    ok: false,
    error: "Uploaded certificate does not cover the hostname",
    invalid: [host],
  };
}

function certForHost(
  certs: UploadedCertHit[],
  host: string,
  uploadedCertId: string | null,
): { ok: true; cert: UploadedCertHit } | InstanceHostnameFailure {
  if (!uploadedCertId) {
    return {
      ok: false,
      error: "An uploaded certificate is required for this hostname",
      invalid: [host],
    };
  }
  const cert = certs.find((item) => item.id === uploadedCertId);
  if (!cert || !uploadedCertificateCoversHost(cert.dnsNames, host)) {
    return coverageFailure(host, cert !== undefined);
  }
  return { ok: true, cert };
}

/**
 * Copy `TURBOPANEL_PUBLIC_URLS` into `hostname` once, when the table is empty.
 * Idempotent: a later call sees the rows and does nothing. Safe on every read.
 */
export async function migrateLegacyPublicUrls(db: Db): Promise<void> {
  const existing = await loadHostnameRows(db);
  if (existing.length > 0) return;
  const legacy = await readLegacyPublicUrls(db);
  if (legacy.length === 0) return;
  const urls = legacyUrlsToStore(legacy);
  if (urls.length === 0) return;
  await insertHostnameRows(
    db,
    urls.map((host, index) => newPlatformCaRow(host, index)),
  );
}

export async function listInstanceHostnames(
  db: Db,
): Promise<InstanceHostnameRecord[]> {
  await migrateLegacyPublicUrls(db);
  const rows = await loadHostnameRows(db);
  return rows.map(toRecord);
}

const HTTP01_PREFLIGHT_PREFIX = "Let's Encrypt HTTP-01 preflight failed for ";

/** Parse a daemon HTTP-01 preflight failure. Other apply errors return null. */
export function instanceAcmeHttp01PreflightFailure(
  error: string,
): { hostname: string; errorMessage: string } | null {
  if (!error.startsWith(HTTP01_PREFLIGHT_PREFIX)) return null;
  const rest = error.slice(HTTP01_PREFLIGHT_PREFIX.length);
  const split = rest.indexOf(": ");
  if (split <= 0) return null;
  const hostname = rest.slice(0, split).trim();
  if (hostname.length === 0) return null;
  return { hostname, errorMessage: error };
}

export async function recordInstanceAcmePreflightFailure(
  db: Db,
  error: string,
  at = new Date().toISOString(),
): Promise<void> {
  const parsed = instanceAcmeHttp01PreflightFailure(error);
  if (!parsed) return;
  await recordInstanceAcmeIssuance(db, {
    hostname: parsed.hostname,
    ok: false,
    errorMessage: parsed.errorMessage,
    at,
  });
}

/**
 * Record one instance Let's Encrypt probe. Matches `origin` rows whose
 * source is `lets-encrypt`. Does not touch an organization's `tls` rows.
 * `notAfter` is written only on success. A failure leaves the stored expiry
 * in place. Changing the source away from Let's Encrypt clears it.
 */
export async function recordInstanceAcmeIssuance(
  db: Db,
  event: {
    hostname: string;
    ok: boolean;
    errorMessage?: string;
    notAfter?: string;
    at: string;
  },
): Promise<void> {
  const rows = await db
    .select({
      id: instanceHostname.id,
      host: instanceHostname.host,
    })
    .from(instanceHostname)
    .where(eq(instanceHostname.source, "lets-encrypt"));
  const match = rows.find((row) =>
    row.host === event.hostname ||
    hostFromPublicUrlEntry(row.host) === event.hostname
  );
  if (!match) return;
  const patch: {
    acmeLastAttemptAt: string;
    acmeLastError: string | null;
    notAfter?: string;
  } = {
    acmeLastAttemptAt: event.at,
    acmeLastError: event.ok
      ? null
      : (event.errorMessage ?? "certificate issuance failed"),
  };
  if (event.ok && event.notAfter) patch.notAfter = event.notAfter;
  await db
    .update(instanceHostname)
    .set(patch)
    .where(eq(instanceHostname.id, match.id));
}

export async function getInstanceHostnamesLegacyShim(
  db: Db,
): Promise<string[]> {
  const rows = await listInstanceHostnames(db);
  return rows.map((row) => row.host);
}

/** Replace the flat public-URL list. Every entry is stored as `platform-ca`. */
export async function replacePublicUrlsWithPlatformCa(
  db: Db,
  urls: string[],
): Promise<void> {
  await persistHostnameRows(
    db,
    urls.map((host, index) => newPlatformCaRow(host, index)),
  );
}

function carryAcme(
  previous: StoredHostname | undefined,
  source: InstanceHostnameSource,
): Pick<StoredHostname, "acmeLastAttemptAt" | "acmeLastError" | "notAfter"> {
  if (
    !previous || source !== "lets-encrypt" || previous.source !== "lets-encrypt"
  ) {
    return {
      acmeLastAttemptAt: null,
      acmeLastError: null,
      notAfter: null,
    };
  }
  return {
    acmeLastAttemptAt: previous.acmeLastAttemptAt,
    acmeLastError: previous.acmeLastError,
    notAfter: previous.notAfter,
  };
}

function rowFromEntry(
  entry: InstanceHostnameEntry,
  previous: StoredHostname | undefined,
  index: number,
  notAfter: string | null,
): StoredHostname {
  const stamp = stampAt(index);
  const acme = carryAcme(previous, entry.source);
  const expiry = entry.source === "uploaded" ? notAfter : acme.notAfter;
  return {
    id: previous?.id ?? crypto.randomUUID(),
    host: entry.host,
    source: entry.source,
    uploadedCertId: entry.source === "uploaded" ? entry.uploadedCertId : null,
    acmeLastAttemptAt: acme.acmeLastAttemptAt,
    acmeLastError: acme.acmeLastError,
    notAfter: expiry,
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
  };
}

function normalizeEntryHost(
  entry: InstanceHostnameEntry,
  allowHttp: boolean,
): { ok: true; host: string } | InstanceHostnameFailure {
  const parsed = parsePublicUrlEntries([entry.host], { allowHttp });
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      invalid: parsed.invalid,
    };
  }
  const host = parsed.urls[0];
  if (!host) {
    return {
      ok: false,
      error: "One or more public URL entries are invalid",
      invalid: [entry.host],
    };
  }
  return { ok: true, host };
}

function combineFailures(
  failures: InstanceHostnameFailure[],
): InstanceHostnameFailure {
  const invalid = failures.flatMap((failure) => failure.invalid);
  const messages = [...new Set(failures.map((failure) => failure.error))];
  const error = messages.length === 1
    ? messages[0]!
    : "One or more hostnames are invalid";
  return { ok: false, error, invalid };
}

async function buildReplacementRows(
  db: Db,
  entries: InstanceHostnameEntry[],
  current: StoredHostname[],
  allowHttp: boolean,
): Promise<{ ok: true; rows: StoredHostname[] } | InstanceHostnameFailure> {
  const failures: InstanceHostnameFailure[] = [];
  const byHost = new Map<string, InstanceHostnameEntry>();
  for (const entry of entries) {
    const hostResult = normalizeEntryHost(entry, allowHttp);
    if (!hostResult.ok) {
      failures.push(hostResult);
      continue;
    }
    const sourceResult = validateHostnameSource(hostResult.host, entry.source);
    if (!sourceResult.ok) {
      failures.push(sourceResult);
      continue;
    }
    byHost.set(hostResult.host, {
      host: hostResult.host,
      source: entry.source,
      uploadedCertId: entry.uploadedCertId,
    });
  }
  const normalized = [...byHost.values()];
  if (failures.length > 0) return combineFailures(failures);

  const certs = await loadUploadedCertificates(db);
  const rows: StoredHostname[] = [];
  for (const [index, entry] of normalized.entries()) {
    let notAfter: string | null = null;
    if (entry.source === "uploaded") {
      const covered = certForHost(certs, entry.host, entry.uploadedCertId);
      if (!covered.ok) {
        failures.push(covered);
        continue;
      }
      notAfter = covered.cert.notAfter;
    }
    const previous = current.find((row) => row.host === entry.host);
    rows.push(rowFromEntry(entry, previous, index, notAfter));
  }
  if (failures.length > 0) return combineFailures(failures);
  return { ok: true, rows };
}

export async function replaceInstanceHostnames(
  db: Db,
  entries: InstanceHostnameEntry[],
  opts: { allowHttp?: boolean } = {},
): Promise<
  { ok: true; hostnames: InstanceHostnameRecord[] } | InstanceHostnameFailure
> {
  await migrateLegacyPublicUrls(db);
  const current = await loadHostnameRows(db);
  const built = await buildReplacementRows(
    db,
    entries,
    current,
    opts.allowHttp === true,
  );
  if (!built.ok) return built;
  await persistHostnameRows(db, built.rows);
  return { ok: true, hostnames: built.rows.map(toRecord) };
}

export async function upsertInstanceHostname(
  db: Db,
  host: string,
  source: InstanceHostnameSource,
  opts: { uploadedCertId?: string | null; allowHttp?: boolean } = {},
): Promise<
  { ok: true; hostname: InstanceHostnameRecord } | InstanceHostnameFailure
> {
  const current = await listInstanceHostnames(db);
  const replaced = await replaceInstanceHostnames(db, [
    ...current.map((row) => ({
      host: row.host,
      source: row.source,
      uploadedCertId: row.uploadedCertId,
    })),
    {
      host,
      source,
      uploadedCertId: opts.uploadedCertId ?? null,
    },
  ], { allowHttp: opts.allowHttp });
  if (!replaced.ok) return replaced;
  const parsed = parsePublicUrlEntries([host], { allowHttp: opts.allowHttp });
  const normalized = parsed.ok ? parsed.urls[0] : undefined;
  const hostname = replaced.hostnames.find((row) => row.host === normalized);
  if (!hostname) {
    return {
      ok: false,
      error: "One or more public URL entries are invalid",
      invalid: [host],
    };
  }
  return { ok: true, hostname };
}

export async function removeInstanceHostname(
  db: Db,
  host: string,
): Promise<void> {
  await migrateLegacyPublicUrls(db);
  const rows = await loadHostnameRows(db);
  await persistHostnameRows(
    db,
    rows.filter((row) => row.host !== host),
  );
}

/**
 * Apply an uploaded pair onto the given hosts and detach it from any hostname
 * that no longer lists it. Detached names stay published as `platform-ca`.
 */
export async function applyUploadedCertificateHosts(
  db: Db,
  cert: UploadedCertHit,
  hosts: string[],
  opts: { allowHttp?: boolean } = {},
): Promise<{ ok: true; hostnames: string[] } | InstanceHostnameFailure> {
  await migrateLegacyPublicUrls(db);
  const current = await loadHostnameRows(db);
  const desired = new Set<string>();
  const failures: InstanceHostnameFailure[] = [];
  for (const raw of hosts) {
    const parsed = parsePublicUrlEntries([raw], { allowHttp: opts.allowHttp });
    if (!parsed.ok || !parsed.urls[0]) {
      failures.push({
        ok: false,
        error: "One or more public URL entries are invalid",
        invalid: [raw],
      });
      continue;
    }
    const host = parsed.urls[0];
    if (!uploadedCertificateCoversHost(cert.dnsNames, host)) {
      failures.push(coverageFailure(host, true));
      continue;
    }
    desired.add(host);
  }
  if (failures.length > 0) return combineFailures(failures);

  const next: StoredHostname[] = [];
  const seen = new Set<string>();
  for (const row of current) {
    if (desired.has(row.host)) {
      next.push(rowFromEntry(
        {
          host: row.host,
          source: "uploaded",
          uploadedCertId: cert.id,
        },
        row,
        next.length,
        cert.notAfter,
      ));
      seen.add(row.host);
      continue;
    }
    if (row.uploadedCertId === cert.id) {
      next.push(rowFromEntry(
        {
          host: row.host,
          source: "platform-ca",
          uploadedCertId: null,
        },
        row,
        next.length,
        null,
      ));
      continue;
    }
    next.push(row);
  }
  let index = next.length;
  for (const host of desired) {
    if (seen.has(host)) continue;
    next.push(rowFromEntry(
      {
        host,
        source: "uploaded",
        uploadedCertId: cert.id,
      },
      undefined,
      index,
      cert.notAfter,
    ));
    index += 1;
  }
  await persistHostnameRows(db, next);
  return {
    ok: true,
    hostnames: [...desired].sort((a, b) => a.localeCompare(b)),
  };
}
