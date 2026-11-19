/**
 * Writes for the `hostname` uniqueness-enforcement table (schema-child-tables,
 * Road-to-0.1.x). See the table's doc comment in `schema.ts` for why this is a
 * mirror, not a promotion, of `hosting.options.hostnames[]`.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hostname, hosting, organization, tls } from '../../db/schema.ts'
import {
  letsEncryptNames,
  readPendingLetsEncrypt,
  pendingLetsEncryptPatch,
} from '../hostings/hosting-certificate.ts'
import type { HostnameCertificate } from '../hostings/name-certificate-vocabulary.ts'
import {
  parseHostingOptions,
  readHostingWwwMode,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../hostings/hosting-options.ts'
import { certificateForPinSource } from '../hostings/name-certificates.ts'
import { nameCertificateOptions } from '../hostings/name-certificate-options.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { assertNotPanelHostnames } from '../hostings/panel-hostname-guard.ts'
import {
  type HostingWwwMode,
  hostingCertificateNames,
  wwwSiblingHostname,
} from '../../contracts/commands/hostname.ts'

/** A name's certificate choice a save sets (names not listed keep theirs). */
export type HostnameChoice = { certificate: HostnameCertificate; tlsId: string | null }

/**
 * Diff sync of a hosting's `hostname` rows against `options.hostnames[]` plus
 * every name the hosting's www choice adds ({@link hostingRoutingNames}, read
 * from the row just written): rows for names no longer served are deleted,
 * new names are inserted (following the site pin until a choice is made), and
 * names that stay keep their row, so a per-name certificate choice survives
 * every save. `choices` sets the choice of the named rows, existing or new.
 * Call inside the same transaction as the `hosting` write it mirrors (panel
 * create/patch, compose reconcile), after that write.
 *
 * When the names grew while the hosting is pinned to a Let's Encrypt row that
 * does not list them all, the same request the "Use Let's Encrypt" button makes
 * is queued ({@link queueLetsEncryptRecheck}), so the new names get their DNS
 * check and the card says which ones do not point here yet.
 */
export async function replaceHostingHostnames(
  db: Db,
  hostingId: string,
  routingOrganizationId: string,
  hostnames: readonly string[],
  choices?: ReadonlyMap<string, HostnameChoice>
): Promise<void> {
  const [row] = await db
    .select({
      tlsId: hosting.tlsId,
      options: hosting.options,
      metadata: hosting.metadata,
      pendingAt: hosting.pendingAt,
    })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  const www = readHostingWwwMode(row?.options)
  const wanted = hostingRoutingNames(hostnames, www)
  // Typed names and the www names the choice adds alike: none may be a name
  // the panel serves. Throws, so the surrounding transaction rolls back.
  await assertNotPanelHostnames(db, wanted)
  const existing = await db
    .select({
      id: hostname.id,
      hostname: hostname.hostname,
      certificate: hostname.certificate,
      tlsId: hostname.tlsId,
    })
    .from(hostname)
    .where(eq(hostname.hostingId, hostingId))
  const keep = new Set(wanted)
  const gone = existing.filter((r) => !keep.has(r.hostname)).map((r) => r.id)
  if (gone.length > 0) await db.delete(hostname).where(inArray(hostname.id, gone))
  const present = new Set(existing.map((r) => r.hostname))
  const added = wanted.filter((value) => !present.has(value))
  const fallback =
    added.length === 0
      ? null
      : await newNameFallback(db, added[0]!, routingOrganizationId, row, keepExisting(existing))
  const typed = new Set(hostnames.map((value) => value.toLowerCase()))
  const resolved = new Map<string, HostnameChoice>()
  for (const r of existing) {
    if (r.certificate !== null) {
      resolved.set(r.hostname, {
        certificate: r.certificate as HostnameCertificate,
        tlsId: r.tlsId,
      })
    }
  }
  for (const [value, choice] of choices ?? []) resolved.set(value, choice)
  await forEachSequential(added, (value) => {
    const partner = wwwSiblingHostname(value)
    const own = choices?.get(value)
    const follows =
      !own && !typed.has(value) && partner !== null ? resolved.get(partner) : undefined
    const choice = own ?? follows ?? fallback!
    resolved.set(value, choice)
    return db.insert(hostname).values({
      hostingId,
      routingOrganizationId,
      hostname: value,
      certificate: choice.certificate,
      tlsId: choice.tlsId,
    })
  })
  if (choices) {
    await forEachSequential(
      wanted.filter((value) => present.has(value) && choices.has(value)),
      (value) => {
        const choice = choices.get(value)!
        return db
          .update(hostname)
          .set({ certificate: choice.certificate, tlsId: choice.tlsId })
          .where(and(eq(hostname.hostingId, hostingId), eq(hostname.hostname, value)))
      }
    )
  }
  if (row) await queueLetsEncryptRecheck(db, hostingId, row, letsEncryptNames(hostnames, www))
}

type ExistingName = { certificate: string | null; tlsId: string | null }

function keepExisting(rows: readonly ExistingName[]): ExistingName[] {
  return rows.map((r) => ({ certificate: r.certificate, tlsId: r.tlsId }))
}

/**
 * The choice a new name gets when the request names none: never NULL. A site
 * whose names all follow its pin (or that has no names yet) gives the new name
 * what that pin stands for; a site whose names already differ has no single
 * pin to follow, so the new name gets the default of the choice table for a
 * name nothing carries yet.
 */
async function newNameFallback(
  db: Db,
  newName: string,
  organizationId: string,
  row: { tlsId: string | null; options: unknown } | undefined,
  existing: readonly ExistingName[]
): Promise<HostnameChoice> {
  const pinId = row?.tlsId ?? null
  let pinSource: string | null = null
  if (pinId !== null) {
    const [pin] = await db
      .select({ source: tls.source })
      .from(tls)
      .where(eq(tls.id, pinId))
      .limit(1)
    pinSource = pin?.source ?? null
  }
  const sitePin = pinSource === null ? null : pinId
  const sitePinChoice: HostnameChoice = {
    certificate: certificateForPinSource(pinSource),
    tlsId: sitePin,
  }
  const mixed = existing.some(
    (r) =>
      r.certificate !== null &&
      (r.certificate !== sitePinChoice.certificate || r.tlsId !== sitePinChoice.tlsId)
  )
  if (sitePin !== null && !mixed) return sitePinChoice
  const [org] = await db
    .select({ isAcmeEnabled: organization.isAcmeEnabled })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const options = parseHostingOptions(row?.options)
  const { default: certificate } = nameCertificateOptions({
    hostname: newName,
    reach: 'direct',
    bind: resolveHostingBind(options),
    isHttp: resolveHostingProtocol(options) === 'http',
    acmeEnabled: org?.isAcmeEnabled === true,
    dnsIssuance: false,
    covering: [],
  })
  return { certificate, tlsId: null }
}

/**
 * Queue a Let's Encrypt request for a hosting pinned to a Let's Encrypt row
 * whose names do not cover `names` (and with no request already waiting). The
 * sweep then checks DNS on every name, shows "www.<name> doesn't point at this
 * server yet" while it waits, and pins a row covering every name once DNS is
 * right. Returns whether a request was queued.
 */
export async function queueLetsEncryptRecheck(
  db: Db,
  hostingId: string,
  row: Readonly<{ tlsId: string | null; metadata: unknown; pendingAt: string | null }>,
  names: readonly string[],
  now: Date = new Date()
): Promise<boolean> {
  if (!row.tlsId || readPendingLetsEncrypt(row) !== null) return false
  const [pin] = await db
    .select({ source: tls.source, metadata: tls.metadata })
    .from(tls)
    .where(eq(tls.id, row.tlsId))
    .limit(1)
  if (pin?.source !== 'lets_encrypt') return false
  const covered = (pin.metadata as { dnsNames?: unknown } | null)?.dnsNames
  if (Array.isArray(covered) && names.every((name) => covered.includes(name))) return false
  await db
    .update(hosting)
    .set({
      ...pendingLetsEncryptPatch(row.metadata, { requestedAt: now.toISOString(), dns: null }),
    })
    .where(eq(hosting.id, hostingId))
  return true
}

/**
 * Every name a hosting answers on, for the uniqueness table: the typed names
 * plus each name its www choice adds (served or redirect-only). A www name
 * goes on the shared routing layer exactly like a typed one, so it must be
 * just as unique: one environment's `both` may not claim a name another one
 * typed, and typing a name another hosting's www choice already adds is
 * refused too (`hostname_in_use`).
 */
export function hostingRoutingNames(
  hostnames: readonly string[],
  www: HostingWwwMode | undefined
): string[] {
  return hostingCertificateNames({ hostnames, www })
}

/** `uniq_hostname_routing_organization_id_hostname` firing — see `unique-violation.ts` for the `.cause` walk. */
export function isHostnameUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, 'uniq_hostname_routing_organization_id_hostname')
}
