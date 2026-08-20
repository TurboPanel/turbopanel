/**
 * Organization CA lifecycle loader: active signer + active/retired trust bundle.
 *
 * `status` is the row's own health. Signing and unique-active enforcement use
 * `ca_state` / `ca_generation` only.
 */
import { and, eq, inArray, max } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { tls } from '../../lib/db/schema.ts'
import type { TlsRowForPublic } from './routes-helpers.ts'

/** States that remain in the overlap-window trust bundle. */
export const ORGANIZATION_CA_TRUST_STATES = ['active', 'retired'] as const

export type OrganizationCaSigner = {
  id: string
  certificatePem: string
  privateKeyPemSealed: string
  caGeneration: number
}

export type OrganizationCaSet = {
  signer: OrganizationCaSigner
  trustBundlePem: string
  /** Public columns of the active signer (private key omitted). */
  tls: TlsRowForPublic
}

type OrganizationCaLifecycleRow = TlsRowForPublic & {
  privateKeyPem: string | null
  caState: string | null
  caGeneration: number | null
}

export type OrganizationCaTrustBundleRow = {
  certificatePem: string | null
  caState: string | null
  caGeneration: number | null
}

const ORGANIZATION_CA_LIFECYCLE_SELECT = {
  id: tls.id,
  displayName: tls.name,
  source: tls.source,
  organizationId: tls.organizationId,
  status: tls.status,
  notAfter: tls.notAfter,
  fingerprintSha256: tls.fingerprintSha256,
  metadata: tls.metadata,
  options: tls.options,
  certificatePem: tls.certificatePem,
  createdAt: tls.createdAt,
  updatedAt: tls.updatedAt,
  privateKeyPem: tls.privateKeyPem,
  caState: tls.caState,
  caGeneration: tls.caGeneration,
} as const

function publicTlsRowFromLifecycle(
  row: OrganizationCaLifecycleRow,
): TlsRowForPublic {
  return {
    id: row.id,
    displayName: row.displayName,
    source: row.source,
    organizationId: row.organizationId,
    status: row.status,
    notAfter: row.notAfter,
    fingerprintSha256: row.fingerprintSha256,
    metadata: row.metadata,
    options: row.options,
    certificatePem: row.certificatePem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    caGeneration: row.caGeneration,
  }
}

function compareTrustBundleOrder(
  a: OrganizationCaTrustBundleRow,
  b: OrganizationCaTrustBundleRow,
): number {
  if (a.caState === 'active' && b.caState !== 'active') return -1
  if (a.caState !== 'active' && b.caState === 'active') return 1
  return (b.caGeneration ?? 0) - (a.caGeneration ?? 0)
}

/**
 * Concatenate active then retired Organization CA PEMs (generation descending).
 * Multi-PEM is accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`.
 */
export function concatenateOrganizationCaTrustBundle(
  rows: readonly OrganizationCaTrustBundleRow[],
): string {
  const ordered = [...rows].sort(compareTrustBundleOrder)
  const blocks: string[] = []
  for (const row of ordered) {
    const pem = row.certificatePem?.trim()
    if (!pem?.includes('BEGIN CERTIFICATE')) continue
    blocks.push(`${pem}\n`)
  }
  return blocks.join('')
}

/**
 * Load the active Organization CA signer plus the active+retired trust bundle.
 * Returns null when no `ca_state='active'` row exists (retired-only is not a
 * signer). This is the only Organization-CA reader.
 */
export async function loadOrganizationCaSet(
  db: Pick<Db, 'select'>,
  organizationId: string,
): Promise<OrganizationCaSet | null> {
  const rows = await db
    .select(ORGANIZATION_CA_LIFECYCLE_SELECT)
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
        inArray(tls.caState, ORGANIZATION_CA_TRUST_STATES),
      ),
    )

  const signerRow = rows.find((row) => row.caState === 'active')
  if (!signerRow) return null

  return {
    signer: {
      id: signerRow.id,
      certificatePem: signerRow.certificatePem ?? '',
      privateKeyPemSealed: signerRow.privateKeyPem ?? '',
      caGeneration: signerRow.caGeneration ?? 1,
    },
    trustBundlePem: concatenateOrganizationCaTrustBundle(rows),
    tls: publicTlsRowFromLifecycle(signerRow),
  }
}

/** Next monotonic `ca_generation` for this org (1 when none exist). */
export async function nextOrganizationCaGeneration(
  db: Pick<Db, 'select'>,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: max(tls.caGeneration) })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
      ),
    )
  return (row?.value ?? 0) + 1
}
