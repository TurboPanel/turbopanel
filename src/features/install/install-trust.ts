/**
 * Per-certificate uploaded public trust, and the Platform CA catch-all leaf
 * names an unlisted install override must match.
 *
 * Public trust is whether the dialed uploaded PEM chains to the system trust
 * store. One environment boolean is not applied to every uploaded hostname.
 * Workers has no control-plane certificate files; those calls no-op.
 */

import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { instanceUploadedCertificate } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { coversHostname } from '../../lib/tls/match.ts'
import { parseCertificatePem } from '../../lib/tls/parse.ts'
import { verifyCertificateSignature } from '../../lib/tls/self-signed.ts'
import { installCaFingerprints } from './install-ca-pin.ts'
import {
  hostLabel,
  type InstallHostnameTrust,
  installOriginNeedsInsecureTls,
  installOriginTlsOptions,
  unlistedSelfHostedInstallRefusal,
} from './install-tls.ts'
import {
  certificateSourceForInstallOrigin,
  effectiveCertificateSource,
  type InstanceHostnameRecord,
  listInstanceHostnames,
} from './instance-hostnames.ts'

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

function splitCertificatePems(pem: string): string[] {
  return [...pem.matchAll(PEM_BLOCK)].map((match) => match[0])
}

type ServedHostname = Omit<InstanceHostnameRecord, 'source'> & {
  source: ReturnType<typeof effectiveCertificateSource>
}

/** Hostnames with the source the listener serves (a live DNS-01 pair counts as an upload). */
async function listServedHostnames(db: Db): Promise<ServedHostname[]> {
  const rows = await listInstanceHostnames(db)
  return rows.map((row) => ({ ...row, source: effectiveCertificateSource(row) }))
}

function toTrustRow(
  row: ServedHostname,
  trust: ReadonlyMap<string, boolean>
): InstallHostnameTrust {
  const base = { host: row.host, source: row.source }
  if (row.source !== 'uploaded' || !row.uploadedCertId) return base
  const declared = trust.get(row.uploadedCertId)
  if (declared === undefined) return base
  return { ...base, publicUploaded: declared }
}

/**
 * What a TLS client sees when it dials an uploaded hostname: `public` when
 * the served chain verifies against the runtime's public roots for that
 * name, `private` when the handshake refuses the certificate, and
 * `unavailable` when nothing could be checked (no listener, timeout, or no
 * probe on this runtime).
 */
export type PublicTlsAnswer = 'public' | 'private' | 'unavailable'

/** Dials `hostname` on `port` and reports what its certificate is. */
export type PublicTlsProbe = (hostname: string, port: number) => Promise<PublicTlsAnswer>

/**
 * The check runs in memory: no certificate file is written and no process
 * is started. Only the Deno composition root registers a probe (a TLS
 * handshake with the runtime's own verifier); Workers has none and never
 * reaches this path, because the hosted control plane stores no uploaded
 * hostnames.
 */
let registeredProbe: PublicTlsProbe | null = null

/** Called once by the Deno composition root; tests pass their own probe. */
export function setPublicTlsProbe(probe: PublicTlsProbe | null): void {
  registeredProbe = probe
}

function hostAndPort(host: string): { name: string; port: number } | null {
  const name = hostLabel(host)
  if (!name) return null
  try {
    const url = new URL(host.includes('://') ? host : `https://${host}`)
    return { name, port: url.port ? Number(url.port) : 443 }
  } catch {
    return null
  }
}

/** Never throws: a probe failure reads as `unavailable`. */
export async function uploadedHostnameTrust(
  host: string,
  probe: PublicTlsProbe | null = registeredProbe
): Promise<PublicTlsAnswer> {
  const target = hostAndPort(host)
  if (!probe || !target) return 'unavailable'
  try {
    return await probe(target.name, target.port)
  } catch {
    return 'unavailable'
  }
}

/**
 * Public trust per uploaded certificate, from the first hostname that serves
 * it. An `unavailable` answer leaves the certificate out, so the caller
 * falls back to the aggregate signal and the private-issuer path decides.
 */
async function publicTrustByCertificate(
  rows: readonly ServedHostname[],
  probe: PublicTlsProbe | null
): Promise<Map<string, boolean>> {
  const trust = new Map<string, boolean>()
  const firstHost = new Map<string, string>()
  for (const row of rows) {
    if (row.source === 'uploaded' && row.uploadedCertId && !firstHost.has(row.uploadedCertId)) {
      firstHost.set(row.uploadedCertId, row.host)
    }
  }
  await forEachSequential([...firstHost], async ([id, host]) => {
    const answer = await uploadedHostnameTrust(host, probe)
    if (answer !== 'unavailable') trust.set(id, answer === 'public')
  })
  return trust
}

function platformCaLeafCandidates(): string[] {
  const certsDir = Deno.env.get('TURBOPANEL_TLS_CERTS_DIR')?.trim()
  const state = Deno.env.get('TURBOPANEL_STATE_DIR')?.trim() || '/var/lib/turbopanel'
  const dirs = [certsDir ?? '', `${state}/tls/certs`, `${Deno.cwd()}/certs`]
  const paths: string[] = []
  for (const dir of dirs) {
    if (dir.length === 0) continue
    // platform-ca.crt is the managed name. The dev Caddyfile default, and
    // a converge that has not copied that name yet, serves self-signed.crt
    // as the same catch-all leaf.
    paths.push(`${dir}/platform-ca.crt`, `${dir}/self-signed.crt`)
  }
  return paths
}

async function namesFromLeafFile(path: string): Promise<string[] | null> {
  try {
    const pem = await Deno.readTextFile(path)
    const parsed = await parseCertificatePem(pem)
    return [...parsed.dnsNames, ...parsed.ipAddresses]
  } catch {
    return null
  }
}

/**
 * DNS and IP names on the Platform CA catch-all leaf, or null when that
 * file cannot be read (Workers, or the certificate has not been minted).
 */
export async function readPlatformCaLeafNames(): Promise<string[] | null> {
  if (typeof Deno === 'undefined') return null
  for (const path of platformCaLeafCandidates()) {
    const names = await namesFromLeafFile(path)
    if (names) return names
  }
  return null
}

function pemCompact(pem: string): string {
  return pem.replaceAll(/\s+/g, '')
}

/**
 * Why a private uploaded hostname cannot be installed yet. Bootstrap `-k`
 * is not a trust anchor the daemon can keep.
 */
export function privateUploadedTrustUnavailable(hostname: string): string {
  return `The uploaded certificate for ${hostname} is not publicly trusted, and TurboPanel has no private issuer that covers it. In Admin → Access, upload the leaf together with the private issuer that signed it, and include ${hostname} on the certificate. The install command is withheld until that issuer can be verified. Bootstrap insecure TLS is not saved as runtime trust.`
}

/** In memory only: WebCrypto checks the signature, nothing is written or run. */
async function issuerSignsLeaf(leaf: string, issuer: string): Promise<boolean> {
  if (pemCompact(leaf) === pemCompact(issuer)) return false
  return await verifyCertificateSignature(leaf, issuer).catch(() => false)
}

/**
 * Issuer certificates from a private upload that signed `certPem`'s leaf and
 * whose leaf covers `hostname`. A copy of the leaf is not an issuer: Deno
 * rejects that pin (`UnknownIssuer`) and still checks the chain and SAN.
 * Null when the upload has no such issuer.
 */
export async function privateUploadedTrustMaterial(
  certPem: string,
  hostname: string
): Promise<string | null> {
  const blocks = splitCertificatePems(certPem)
  const leaf = blocks[0]
  if (!leaf) return null
  let names: string[]
  try {
    const parsed = await parseCertificatePem(leaf)
    names = [...parsed.dnsNames, ...parsed.ipAddresses]
  } catch {
    return null
  }
  if (!coversHostname(names, hostname)) return null
  const issuers: string[] = []
  await forEachSequential(blocks.slice(1), async (block) => {
    if (await issuerSignsLeaf(leaf, block)) issuers.push(block.trim())
  })
  if (issuers.length === 0) return null
  return `${issuers.join('\n')}\n`
}

async function loadUploadedCertPem(db: Db, id: string): Promise<string | null> {
  const rows = await db
    .select({
      id: instanceUploadedCertificate.id,
      certPem: instanceUploadedCertificate.certPem,
    })
    .from(instanceUploadedCertificate)
    .where(inArray(instanceUploadedCertificate.id, [id]))
  const row = rows.find((item) => item.id === id)
  return row?.certPem ?? null
}

type UploadedTrust = { answer: PublicTlsAnswer | 'none'; pem: string | null }

/**
 * Trust for one dialed uploaded hostname: `none` when the name is not an
 * upload, else the probe's answer and, for a private upload, the issuer from
 * its PEM that signed the leaf (null when there is none).
 */
async function uploadedTrustForHostname(
  db: Db,
  hostname: string,
  probe: PublicTlsProbe | null
): Promise<UploadedTrust> {
  const none: UploadedTrust = { answer: 'none', pem: null }
  const wanted = hostLabel(hostname)
  if (!wanted) return none
  const hostnames = await listServedHostnames(db)
  const row = hostnames.find(
    (item) => item.source === 'uploaded' && hostLabel(item.host) === wanted
  )
  if (!row?.uploadedCertId) return none
  const certPem = await loadUploadedCertPem(db, row.uploadedCertId)
  if (!certPem) return none
  return await rememberPrivateTrust(certPem, wanted, async () => {
    const answer = await uploadedHostnameTrust(row.host, probe)
    if (answer !== 'private') return { answer, pem: null }
    return { answer, pem: await privateUploadedTrustMaterial(certPem, wanted) }
  })
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
  probe: PublicTlsProbe | null = registeredProbe
): Promise<string | null> {
  return (await uploadedTrustForHostname(db, hostname, probe)).pem
}

/**
 * The answer for one (certificate, hostname) pair, kept for a few minutes.
 *
 * `GET /instance/uploaded-trust` is unauthenticated by design (the installer
 * calls it before it has any trust), and answering it runs a TLS handshake.
 * Only a configured uploaded hostname reaches this far, so the keys are
 * bounded; the cache stops a request loop against one name from becoming a
 * connection loop. Keyed on the certificate's contents, so a replaced upload
 * is never answered from the old one. An `unavailable` answer is not kept,
 * so the next request checks again.
 */
const PRIVATE_TRUST_TTL_MS = 5 * 60_000
const PRIVATE_TRUST_MAX_ENTRIES = 128
const privateTrustCache = new Map<string, { expiresAt: number; trust: UploadedTrust }>()

async function rememberPrivateTrust(
  certPem: string,
  hostname: string,
  compute: () => Promise<UploadedTrust>
): Promise<UploadedTrust> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(certPem))
  const key = `${hostname}\n${Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')}`
  const now = Date.now()
  const hit = privateTrustCache.get(key)
  if (hit && hit.expiresAt > now) return hit.trust
  const trust = await compute()
  if (trust.answer === 'unavailable') return trust
  if (privateTrustCache.size >= PRIVATE_TRUST_MAX_ENTRIES) {
    privateTrustCache.clear()
  }
  privateTrustCache.set(key, { expiresAt: now + PRIVATE_TRUST_TTL_MS, trust })
  return trust
}

/** Why an uploaded hostname's install command is withheld when its certificate could not be checked. */
export function uploadedTrustUnchecked(hostname: string): string {
  return `TurboPanel could not check the certificate that ${hostname} serves, so the install command is withheld. Make sure the control plane is reachable on that address and try again.`
}

/**
 * The private issuer the installer will fetch for a private upload, or the
 * reason that upload cannot be installed. Null `pem` when the dialed name is
 * not a private upload.
 */
async function privateUploadTrust(
  db: Db,
  instanceUrl: string,
  source: ReturnType<typeof certificateSourceForInstallOrigin>,
  publicUploaded: boolean | undefined,
  probe: PublicTlsProbe | null
): Promise<{ error: string } | { pem: string | null }> {
  if (source !== 'uploaded' || publicUploaded === true) return { pem: null }
  const host = hostLabel(instanceUrl) ?? instanceUrl.trim()
  // Workers has no private control-plane leaf to pin. Serving an issuer
  // the edge certificate was not signed by would look installed and then
  // fail closed in the installer.
  if (typeof Deno === 'undefined') return { error: privateUploadedTrustUnavailable(host) }
  const trust = await uploadedTrustForHostname(db, host, probe)
  if (trust.answer === 'public') return { pem: null }
  if (trust.pem) return { pem: trust.pem }
  if (trust.answer === 'unavailable') return { error: uploadedTrustUnchecked(host) }
  return { error: privateUploadedTrustUnavailable(host) }
}

async function readPlatformCaQuietly(
  read: (() => Promise<string>) | undefined
): Promise<string | null> {
  if (!read) return null
  try {
    return await read()
  } catch {
    return null
  }
}

export type InstallOriginTlsReaders = {
  /**
   * Reads the document `GET /api/daemon/v1/instance/ca` serves (the Platform
   * CA bundle). Injected by the Deno composition root; Workers leaves it
   * unset.
   */
  readPlatformCaPem?: () => Promise<string>
  /** Overrides the registered public-trust probe (tests). */
  probePublicTls?: PublicTlsProbe | null
}

/**
 * Install-command TLS for one origin. Uploaded public trust is that
 * certificate's chain. Every Platform CA catch-all `:8443` name the leaf
 * does not cover is refused, including a private IP or `.lan` alias. A
 * private upload is refused unless its PEM contains an issuer that signed
 * the leaf and the leaf covers the dialed name — bootstrap `-k` is not
 * stored as runtime trust.
 *
 * When the command bootstraps insecure TLS, `caFingerprints` lists every
 * certificate the installer may fetch over that leg: the Platform CA bundle
 * (served for an uploaded name too unless `TURBOPANEL_TLS_PUBLIC` hides it)
 * and the private issuer. The installer refuses anything outside that list.
 */
export async function resolveInstallOriginTls(
  db: Db,
  instanceUrl: string,
  env: Record<string, string | undefined>,
  selfHostedListener: boolean,
  readers: InstallOriginTlsReaders = {}
): Promise<
  { ok: true; insecureTls: boolean; caFingerprints: string[] } | { ok: false; error: string }
> {
  // Hosted (no self-hosted listener): the platform terminates TLS and stored
  // hostname rows are ignored, so none can mark the origin untrusted.
  const hostnames = selfHostedListener ? await listServedHostnames(db) : []
  const probe = readers.probePublicTls === undefined ? registeredProbe : readers.probePublicTls
  const trust = await publicTrustByCertificate(hostnames, probe)
  const trusted = hostnames.map((row) => toTrustRow(row, trust))
  const source = certificateSourceForInstallOrigin(instanceUrl, hostnames)
  const leafNames = selfHostedListener ? await readPlatformCaLeafNames() : null
  const uncovered = unlistedSelfHostedInstallRefusal(instanceUrl, {
    source,
    selfHostedListener,
    leafNames,
  })
  if (uncovered) return { ok: false, error: uncovered }
  const options = installOriginTlsOptions(source, env, {
    hostnames: trusted,
    origin: instanceUrl,
    selfHostedListener,
  })
  const upload = await privateUploadTrust(db, instanceUrl, source, options.publicUploaded, probe)
  if ('error' in upload) return { ok: false, error: upload.error }
  const insecureTls = installOriginNeedsInsecureTls(instanceUrl, options)
  if (!insecureTls) return { ok: true, insecureTls, caFingerprints: [] }
  const caFingerprints = await installCaFingerprints([
    await readPlatformCaQuietly(readers.readPlatformCaPem),
    upload.pem,
  ])
  return { ok: true, insecureTls, caFingerprints }
}
