/**
 * Database side of the one-click Let's Encrypt action: the store the service in
 * `features/hostings/use-letsencrypt.ts` talks to, and the derived certificate
 * block returned with every hosting.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  deployment,
  environment,
  hosting,
  ip,
  organization,
  service,
  tls,
} from '../../db/schema.ts'
import { readHostingComposeOwner } from '../../features/hostings/hosting-compose-owner.ts'
import {
  type HostingCertificate,
  type PinnedCertificateRow,
  deriveHostingCertificate,
  letsEncryptRefusal,
  readPendingLetsEncrypt,
} from '../../features/hostings/hosting-certificate.ts'
import {
  parseHostingOptions,
  readHostingWwwMode,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../../features/hostings/hosting-options.ts'
import type { LetsEncryptStore } from '../../features/hostings/use-letsencrypt.ts'
import {
  parseOrganizationOptions,
  resolveAcmeEnabled,
} from '../../features/organizations/organization-options.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import { splitTlsMetadata } from '../../lib/tls/metadata.ts'
import { materialFromLetsEncrypt, isCreateTlsFailure } from '../tls/routes-helpers.ts'

export async function loadAcmeEnabled(db: Db, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveAcmeEnabled(parseOrganizationOptions(row?.options))
}

async function loadServerIdOfHosting(db: Db, hostingId: string): Promise<string | null> {
  const [row] = await db
    .select({ serverId: environment.serverId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .where(eq(hosting.id, hostingId))
    .limit(1)
  return row?.serverId ?? null
}

async function loadExpectedAddresses(db: Db, hostingId: string): Promise<string[]> {
  const [pinRow] = await db
    .select({ address: ip.address })
    .from(hosting)
    .innerJoin(ip, eq(ip.id, hosting.ipId))
    .where(eq(hosting.id, hostingId))
    .limit(1)
  if (pinRow) {
    const pinned = inetAddressToString(pinRow.address)
    return pinned === undefined ? [] : [pinned]
  }
  const serverId = await loadServerIdOfHosting(db, hostingId)
  if (serverId === null) return []
  const rows = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'public')))
  return rows.flatMap((row) => {
    const address = inetAddressToString(row.address)
    return address === undefined ? [] : [address]
  })
}

/** Hostnames of the other web hostings that deploy together with this one (same environment). */
async function loadOtherWebHostnames(db: Db, hostingId: string): Promise<string[]> {
  const [own] = await db
    .select({ environmentId: service.environmentId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(eq(hosting.id, hostingId))
    .limit(1)
  if (!own) return []
  const rows = await db
    .select({ options: hosting.options })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(and(eq(service.environmentId, own.environmentId), ne(hosting.id, hostingId)))
  return rows.flatMap((row) => {
    const options = parseHostingOptions(row.options)
    return resolveHostingProtocol(options) === 'http' ? (options?.hostnames ?? []) : []
  })
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left.map((name) => name.toLowerCase()))
  return right.every((name) => set.has(name.toLowerCase()))
}

export function createLetsEncryptStore(db: Db): LetsEncryptStore {
  return {
    expectedAddresses: (record) => loadExpectedAddresses(db, record.id),

    otherWebHostnames: (record) => loadOtherWebHostnames(db, record.id),

    async findManagedCertificate(organizationId, names) {
      const rows = await db
        .select({ id: tls.id, metadata: tls.metadata })
        .from(tls)
        .where(
          and(
            eq(tls.organizationId, organizationId),
            eq(tls.source, 'lets_encrypt'),
            eq(tls.status, 'managed')
          )
        )
      const match = rows.find((row) => {
        const dnsNames = (row.metadata as { dnsNames?: unknown } | null)?.dnsNames
        return Array.isArray(dnsNames) && sameNames(dnsNames as string[], names)
      })
      return match?.id ?? null
    },

    async createManagedCertificate(organizationId, names) {
      const material = materialFromLetsEncrypt({ hostnames: [...names] })
      if (isCreateTlsFailure(material)) throw new Error(material.error)
      const { columns, residual } = splitTlsMetadata(material.metadata)
      const [inserted] = await db
        .insert(tls)
        .values({
          organizationId,
          name: null,
          source: 'lets_encrypt',
          certificatePem: null,
          privateKeyPem: null,
          status: columns.status,
          notAfter: columns.notAfter,
          fingerprintSha256: columns.fingerprintSha256,
          metadata: residual,
          options: material.options,
        })
        .returning({ id: tls.id })
      return inserted.id
    },

    async saveHosting(hostingId, patch) {
      await db
        .update(hosting)
        .set({
          ...(patch.tlsId === undefined ? {} : { tlsId: patch.tlsId }),
          ...(patch.options === undefined ? {} : { options: patch.options }),
          ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        })
        .where(eq(hosting.id, hostingId))
    },
  }
}

export type HostingCertificateRow = {
  id: string
  tlsId: string | null
  options: unknown
  metadata: unknown
  updatedAt: string
}

/** Environments (by hosting) whose last applied deployment predates `since`. */
async function loadNeedsDeploy(
  db: Db,
  rows: readonly HostingCertificateRow[]
): Promise<Set<string>> {
  if (rows.length === 0) return new Set()
  const ids = rows.map((row) => row.id)
  const finished = await db
    .select({
      hostingId: hosting.id,
      finishedAt: sql<
        string | null
      >`max(${deployment.finishedAt}) filter (where ${deployment.status} = 'applied')`,
    })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .leftJoin(deployment, eq(deployment.environmentId, service.environmentId))
    .where(inArray(hosting.id, ids))
    .groupBy(hosting.id)
  const lastApplied = new Map(finished.map((row) => [row.hostingId, row.finishedAt]))
  const stale = new Set<string>()
  for (const row of rows) {
    const at = lastApplied.get(row.id)
    if (at === null || at === undefined || Date.parse(at) < Date.parse(row.updatedAt)) {
      stale.add(row.id)
    }
  }
  return stale
}

/**
 * The derived certificate block for each hosting. One query per kind (the
 * organization's switch, the pinned certificate rows, and the deployments for
 * the few rows still waiting on a first certificate), however many rows.
 */
export async function loadHostingCertificates(
  db: Db,
  organizationId: string,
  rows: readonly HostingCertificateRow[],
  now: Date = new Date()
): Promise<Map<string, HostingCertificate>> {
  const acmeEnabled = await loadAcmeEnabled(db, organizationId)
  const tlsIds = [...new Set(rows.flatMap((row) => (row.tlsId === null ? [] : [row.tlsId])))]
  const tlsRows =
    tlsIds.length === 0
      ? []
      : await db
          .select({
            id: tls.id,
            source: tls.source,
            status: tls.status,
            notAfter: tls.notAfter,
            metadata: tls.metadata,
          })
          .from(tls)
          .where(and(eq(tls.organizationId, organizationId), inArray(tls.id, tlsIds)))
  const pinnedById = new Map<string, PinnedCertificateRow>(tlsRows.map((row) => [row.id, row]))
  const firstCertificate = rows.filter((row) => {
    const pinned = row.tlsId === null ? undefined : pinnedById.get(row.tlsId)
    return pinned?.source === 'lets_encrypt'
  })
  const needsDeploy = await loadNeedsDeploy(db, firstCertificate)

  const out = new Map<string, HostingCertificate>()
  for (const row of rows) {
    const options = parseHostingOptions(row.options)
    const hostnames = options?.hostnames ?? []
    const available =
      readHostingComposeOwner(row.metadata) === null &&
      letsEncryptRefusal({
        acmeEnabled,
        protocol: resolveHostingProtocol(options),
        bind: resolveHostingBind(options),
        hostnames,
        www: readHostingWwwMode(row.options),
      }) === null
    const pinned = row.tlsId === null ? null : (pinnedById.get(row.tlsId) ?? null)
    out.set(
      row.id,
      deriveHostingCertificate({
        pinned,
        pending: readPendingLetsEncrypt(row.metadata),
        www: readHostingWwwMode(row.options),
        letsEncryptAvailable: available,
        needsDeploy: needsDeploy.has(row.id),
        now,
      })
    )
  }
  return out
}
