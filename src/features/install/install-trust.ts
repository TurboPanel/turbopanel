/**
 * Per-certificate uploaded public trust, and the Platform CA catch-all leaf
 * names an unlisted install override must match.
 *
 * Public trust is whether the dialed uploaded PEM chains to the system trust
 * store. One environment boolean is not applied to every uploaded hostname.
 * Workers has no control-plane certificate files; those calls no-op.
 */

import { inArray } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { instanceUploadedCertificate } from "../../db/schema.ts";
import { coversHostname } from "../../lib/tls/match.ts";
import { parseCertificatePem } from "../../lib/tls/parse.ts";
import { verifyCertificateSignature } from "../../lib/tls/self-signed.ts";
import {
  hostLabel,
  type InstallHostnameTrust,
  installOriginNeedsInsecureTls,
  installOriginTlsOptions,
  unlistedSelfHostedInstallRefusal,
} from "./install-tls.ts";
import {
  certificateSourceForInstallOrigin,
  type InstanceHostnameRecord,
  listInstanceHostnames,
} from "./instance-hostnames.ts";

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const LOADER_ENV_VARS = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
];

function splitCertificatePems(pem: string): string[] {
  return [...pem.matchAll(PEM_BLOCK)].map((match) => match[0]);
}

function uploadedCertIds(rows: readonly InstanceHostnameRecord[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.source === "uploaded" && row.uploadedCertId) {
      ids.add(row.uploadedCertId);
    }
  }
  return [...ids];
}

function toTrustRow(
  row: InstanceHostnameRecord,
  trust: ReadonlyMap<string, boolean>,
): InstallHostnameTrust {
  const base = { host: row.host, source: row.source };
  if (row.source !== "uploaded" || !row.uploadedCertId) return base;
  const declared = trust.get(row.uploadedCertId);
  if (declared === undefined) return base;
  return { ...base, publicUploaded: declared };
}

function opensslSpawnEnv(): Record<string, string> {
  const env = { ...Deno.env.toObject() };
  for (const key of LOADER_ENV_VARS) delete env[key];
  return env;
}

function isDenied(err: unknown): boolean {
  return err instanceof Deno.errors.NotCapable ||
    err instanceof Deno.errors.PermissionDenied;
}

async function writeVerifyPem(body: string): Promise<string> {
  try {
    const path = await Deno.makeTempFile({
      prefix: "tp-uploaded-trust-",
      suffix: ".pem",
    });
    await Deno.writeTextFile(path, body);
    return path;
  } catch (err) {
    if (!isDenied(err)) throw err;
  }
  const state = Deno.env.get("TURBOPANEL_STATE_DIR")?.trim() ||
    "/var/lib/turbopanel";
  const dir = `${state}/tls`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/uploaded-trust-${crypto.randomUUID()}.pem`;
  await Deno.writeTextFile(path, body);
  return path;
}

async function opensslOk(args: string[]): Promise<boolean> {
  for (const bin of ["/usr/bin/openssl", "openssl"]) {
    try {
      const output = await new Deno.Command(bin, {
        args,
        env: opensslSpawnEnv(),
        stdout: "piped",
        stderr: "piped",
      }).output();
      return output.code === 0;
    } catch (err) {
      if (isDenied(err)) return false;
    }
  }
  return false;
}

async function verifyAgainstSystemRoots(
  leaf: string,
  intermediates: string,
): Promise<boolean> {
  const leafPath = await writeVerifyPem(leaf);
  const extraPath = intermediates.length > 0
    ? await writeVerifyPem(intermediates)
    : null;
  try {
    // No -CAfile: OpenSSL's default trust store is the one this distribution
    // configured (Debian's /etc/ssl/certs, RHEL's /etc/pki/tls, …), and it
    // honours SSL_CERT_FILE / SSL_CERT_DIR. A hard-coded Debian bundle made
    // every public upload read as private on RHEL-family hosts.
    const args = ["verify"];
    if (extraPath) args.push("-untrusted", extraPath);
    args.push(leafPath);
    return await opensslOk(args);
  } finally {
    await Deno.remove(leafPath).catch(() => undefined);
    if (extraPath) await Deno.remove(extraPath).catch(() => undefined);
  }
}

/**
 * True when `certPem` (leaf, optionally followed by intermediates) chains to
 * the host trust store. A private or unreadable chain is not public.
 */
export async function uploadedCertificateChainsToPublicRoot(
  certPem: string,
): Promise<boolean> {
  if (typeof Deno === "undefined") return false;
  const blocks = splitCertificatePems(certPem);
  const leaf = blocks[0];
  if (!leaf) return false;
  try {
    return await verifyAgainstSystemRoots(leaf, blocks.slice(1).join("\n"));
  } catch {
    return false;
  }
}

async function publicTrustByCertificate(
  db: Db,
  ids: string[],
): Promise<Map<string, boolean>> {
  const trust = new Map<string, boolean>();
  if (ids.length === 0 || typeof Deno === "undefined") return trust;
  const rows = await db
    .select({
      id: instanceUploadedCertificate.id,
      certPem: instanceUploadedCertificate.certPem,
    })
    .from(instanceUploadedCertificate)
    .where(inArray(instanceUploadedCertificate.id, ids));
  for (const row of rows) {
    trust.set(row.id, await uploadedCertificateChainsToPublicRoot(row.certPem));
  }
  return trust;
}

function platformCaLeafCandidates(): string[] {
  const certsDir = Deno.env.get("TURBOPANEL_TLS_CERTS_DIR")?.trim();
  const state = Deno.env.get("TURBOPANEL_STATE_DIR")?.trim() ||
    "/var/lib/turbopanel";
  const dirs = [
    certsDir ?? "",
    `${state}/tls/certs`,
    `${Deno.cwd()}/certs`,
  ];
  const paths: string[] = [];
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    // platform-ca.crt is the managed name. The dev Caddyfile default, and
    // a converge that has not copied that name yet, serves self-signed.crt
    // as the same catch-all leaf.
    paths.push(`${dir}/platform-ca.crt`, `${dir}/self-signed.crt`);
  }
  return paths;
}

async function namesFromLeafFile(path: string): Promise<string[] | null> {
  try {
    const pem = await Deno.readTextFile(path);
    const parsed = await parseCertificatePem(pem);
    return [...parsed.dnsNames, ...parsed.ipAddresses];
  } catch {
    return null;
  }
}

/**
 * DNS and IP names on the Platform CA catch-all leaf, or null when that
 * file cannot be read (Workers, or the certificate has not been minted).
 */
export async function readPlatformCaLeafNames(): Promise<string[] | null> {
  if (typeof Deno === "undefined") return null;
  for (const path of platformCaLeafCandidates()) {
    const names = await namesFromLeafFile(path);
    if (names) return names;
  }
  return null;
}

function pemCompact(pem: string): string {
  return pem.replaceAll(/\s+/g, "");
}

/**
 * Why a private uploaded hostname cannot be installed yet. Bootstrap `-k`
 * is not a trust anchor the daemon can keep.
 */
export function privateUploadedTrustUnavailable(hostname: string): string {
  return `The uploaded certificate for ${hostname} is not publicly trusted, and TurboPanel has no private issuer that covers it. In Admin → Access, upload the leaf together with the private issuer that signed it, and include ${hostname} on the certificate. The install command is withheld until that issuer can be verified. Bootstrap insecure TLS is not saved as runtime trust.`;
}

async function opensslIssuerSignsLeaf(
  leaf: string,
  issuer: string,
): Promise<boolean> {
  if (typeof Deno === "undefined") return false;
  const leafPath = await writeVerifyPem(leaf);
  const issuerPath = await writeVerifyPem(issuer);
  try {
    return await opensslOk([
      "verify",
      "-partial_chain",
      "-CAfile",
      issuerPath,
      leafPath,
    ]);
  } finally {
    await Deno.remove(leafPath).catch(() => undefined);
    await Deno.remove(issuerPath).catch(() => undefined);
  }
}

async function issuerSignsLeaf(leaf: string, issuer: string): Promise<boolean> {
  if (pemCompact(leaf) === pemCompact(issuer)) return false;
  if (await verifyCertificateSignature(leaf, issuer)) return true;
  return await opensslIssuerSignsLeaf(leaf, issuer);
}

/**
 * Issuer certificates from a private upload that signed `certPem`'s leaf and
 * whose leaf covers `hostname`. A copy of the leaf is not an issuer: Deno
 * rejects that pin (`UnknownIssuer`) and still checks the chain and SAN.
 * Null when the upload has no such issuer.
 */
export async function privateUploadedTrustMaterial(
  certPem: string,
  hostname: string,
): Promise<string | null> {
  const blocks = splitCertificatePems(certPem);
  const leaf = blocks[0];
  if (!leaf) return null;
  let names: string[];
  try {
    const parsed = await parseCertificatePem(leaf);
    names = [...parsed.dnsNames, ...parsed.ipAddresses];
  } catch {
    return null;
  }
  if (!coversHostname(names, hostname)) return null;
  const issuers: string[] = [];
  for (const block of blocks.slice(1)) {
    if (await issuerSignsLeaf(leaf, block)) issuers.push(block.trim());
  }
  if (issuers.length === 0) return null;
  return `${issuers.join("\n")}\n`;
}

async function loadUploadedCertPem(db: Db, id: string): Promise<string | null> {
  const rows = await db
    .select({
      id: instanceUploadedCertificate.id,
      certPem: instanceUploadedCertificate.certPem,
    })
    .from(instanceUploadedCertificate)
    .where(inArray(instanceUploadedCertificate.id, [id]));
  const row = rows.find((item) => item.id === id);
  return row?.certPem ?? null;
}

/**
 * PEM trust anchor for one dialed private uploaded hostname, or null when
 * that name is not a private upload with a covering issuer. Never the
 * Platform CA bundle, and never a publicly trusted upload (those use the
 * system roots).
 */
export async function readPrivateUploadedTrustPem(
  db: Db,
  hostname: string,
): Promise<string | null> {
  const wanted = hostLabel(hostname);
  if (!wanted) return null;
  const hostnames = await listInstanceHostnames(db);
  const row = hostnames.find((item) =>
    item.source === "uploaded" && hostLabel(item.host) === wanted
  );
  if (!row?.uploadedCertId) return null;
  const certPem = await loadUploadedCertPem(db, row.uploadedCertId);
  if (!certPem) return null;
  return await rememberPrivateTrust(certPem, wanted, async () => {
    if (await uploadedCertificateChainsToPublicRoot(certPem)) return null;
    return await privateUploadedTrustMaterial(certPem, wanted);
  });
}

/**
 * The answer for one (certificate, hostname) pair, kept for a few minutes.
 *
 * `GET /instance/uploaded-trust` is unauthenticated by design (the installer
 * calls it before it has any trust), and answering it spawns up to three
 * `openssl verify` runs. Only a configured uploaded hostname reaches this far,
 * so the keys are bounded; the cache stops a request loop against one name
 * from becoming a process-spawn loop. Keyed on the certificate's contents, so
 * a replaced upload is never answered from the old one.
 */
const PRIVATE_TRUST_TTL_MS = 5 * 60_000;
const PRIVATE_TRUST_MAX_ENTRIES = 128;
const privateTrustCache = new Map<
  string,
  { expiresAt: number; pem: string | null }
>();

async function rememberPrivateTrust(
  certPem: string,
  hostname: string,
  compute: () => Promise<string | null>,
): Promise<string | null> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(certPem),
  );
  const key = `${hostname}\n${
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
  const now = Date.now();
  const hit = privateTrustCache.get(key);
  if (hit && hit.expiresAt > now) return hit.pem;
  const pem = await compute();
  if (privateTrustCache.size >= PRIVATE_TRUST_MAX_ENTRIES) {
    privateTrustCache.clear();
  }
  privateTrustCache.set(key, { expiresAt: now + PRIVATE_TRUST_TTL_MS, pem });
  return pem;
}

async function privateUploadTrustError(
  db: Db,
  instanceUrl: string,
  source: ReturnType<typeof certificateSourceForInstallOrigin>,
  publicUploaded: boolean | undefined,
): Promise<string | null> {
  if (source !== "uploaded" || publicUploaded === true) return null;
  const host = hostLabel(instanceUrl) ?? instanceUrl.trim();
  // Workers has no private control-plane leaf to pin. Serving an issuer
  // the edge certificate was not signed by would look installed and then
  // fail closed in the installer.
  if (typeof Deno === "undefined") return privateUploadedTrustUnavailable(host);
  const pem = await readPrivateUploadedTrustPem(db, host);
  if (!pem) return privateUploadedTrustUnavailable(host);
  return null;
}

/**
 * Install-command TLS for one origin. Uploaded public trust is that
 * certificate's chain. Every Platform CA catch-all `:8443` name the leaf
 * does not cover is refused, including a private IP or `.lan` alias. A
 * private upload is refused unless its PEM contains an issuer that signed
 * the leaf and the leaf covers the dialed name — bootstrap `-k` is not
 * stored as runtime trust.
 */
export async function resolveInstallOriginTls(
  db: Db,
  instanceUrl: string,
  env: Record<string, string | undefined>,
  selfHostedListener: boolean,
): Promise<{ ok: true; insecureTls: boolean } | { ok: false; error: string }> {
  const hostnames = await listInstanceHostnames(db);
  const trust = await publicTrustByCertificate(db, uploadedCertIds(hostnames));
  const trusted = hostnames.map((row) => toTrustRow(row, trust));
  const source = certificateSourceForInstallOrigin(instanceUrl, hostnames);
  const leafNames = selfHostedListener ? await readPlatformCaLeafNames() : null;
  const uncovered = unlistedSelfHostedInstallRefusal(instanceUrl, {
    source,
    selfHostedListener,
    leafNames,
  });
  if (uncovered) return { ok: false, error: uncovered };
  const options = installOriginTlsOptions(source, env, {
    hostnames: trusted,
    origin: instanceUrl,
    selfHostedListener,
  });
  const withheld = await privateUploadTrustError(
    db,
    instanceUrl,
    source,
    options.publicUploaded,
  );
  if (withheld) return { ok: false, error: withheld };
  return {
    ok: true,
    insecureTls: installOriginNeedsInsecureTls(instanceUrl, options),
  };
}
