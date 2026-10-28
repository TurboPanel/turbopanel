/**
 * Peer certificates: the Organization CA certificate a server's web server
 * (Caddy) presents when another server of the same organization forwards a
 * request to it over the datacenter address.
 *
 * One `peer` leaf per server, 90 days, signed by the active Organization CA.
 * Like the other leaf kinds the panel keeps no copy of the certificate or its
 * key: it mints the pair, seals the key for the one server's daemon
 * (`resealSecretForDaemon`) and records expiry and signing generation in
 * `leaf` only once the delivery succeeded (`pendingTlsLeaf` command metadata,
 * committed by `commitPendingTlsLeafTracking`). The leaf is for the fixed
 * name {@link PEER_LEAF_NAME}: the sending Caddy dials the datacenter address
 * but verifies that name, and trusts the Organization CA only for that hop.
 *
 * Server-auth use only (no client-auth purpose): nothing presents it as a
 * client certificate.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { ip, leaf, server as serverTable, tls } from '../../db/schema.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import {
  decryptSecret,
  encryptSecret,
  resealSecretForDaemon,
} from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { issueLeafCertificate } from '../../lib/tls/index.ts'
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from '../../lib/tls/self-signed.ts'
import { ensureActiveOrganizationCa } from '../managed/apply-prepare.ts'
import { getServerDaemonStateByServerId, isDaemonKeyActive } from '../servers/server-identity-db.ts'
import type { UpsertTlsLeafTrackingParams } from './leaf-tracking.ts'

/** The name the sending Caddy verifies (`tls_server_name`) and the receiving Caddy serves. */
export const PEER_LEAF_NAME = 'tp-peer.internal'

const MS_PER_DAY = 86_400_000

/** A peer leaf with less than this left (a third of its lifetime) is replaced. */
export const PEER_LEAF_RENEW_BEFORE_MS = (ORGANIZATION_CA_LEAF_VALID_DAYS * MS_PER_DAY) / 3

/** What a server's daemon needs to serve and trust the peer hop. */
export type PeerLeafMaterial = {
  /** PEM leaf certificate for {@link PEER_LEAF_NAME}. */
  certificatePem: string
  /** Leaf private key sealed for this server's daemon only. */
  privateKeyEnvelope: string
  /** Active plus retired Organization CA certificates, for the sending side to trust. */
  caCertPem: string
  /** ISO expiry of the leaf. */
  notAfter: string
}

export type PeerLeafIssue = {
  material: PeerLeafMaterial
  /** Commit with `commitPendingTlsLeafTracking` once the daemon confirmed the files. */
  pendingTlsLeaf: UpsertTlsLeafTrackingParams
}

export type PeerLeafError =
  | { kind: 'daemon_key_unavailable'; serverId: string }
  | { kind: 'organization_ca_unavailable' }
  | { kind: 'server_not_in_organization'; serverId: string }

export type PeerLeafOutcome =
  | { status: 'current'; notAfter: string; caGeneration: number }
  | ({ status: 'issued' } & PeerLeafIssue)
  | { status: 'failed'; error: PeerLeafError }

/** Tracked state of a server's deployed peer leaf. */
export type PeerLeafTracking = {
  notAfter: string
  caGeneration: number
  state: string
}

/** True when a tracked peer leaf can stay: active, on the active CA generation and not near expiry. */
export function peerLeafIsCurrent(
  tracked: PeerLeafTracking | null,
  activeCaGeneration: number,
  nowMs = Date.now()
): boolean {
  if (!tracked || tracked.state !== 'active') return false
  if (tracked.caGeneration !== activeCaGeneration) return false
  const notAfterMs = Date.parse(tracked.notAfter)
  return Number.isFinite(notAfterMs) && notAfterMs - nowMs >= PEER_LEAF_RENEW_BEFORE_MS
}

/** Every datacenter address pinned to the server, oldest first, as text. */
export async function loadServerDatacenterAddresses(db: Db, serverId: string): Promise<string[]> {
  const rows = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'datacenter'), isNotNull(ip.datacenterId)))
    .orderBy(asc(ip.createdAt))
  const out: string[] = []
  for (const row of rows) {
    const text = inetAddressToString(row.address)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * Mint a peer leaf for one server and seal its key for that server's daemon.
 * Always mints; use {@link ensurePeerLeaf} to keep a leaf that is still good.
 * The key is sealed for `recipient` alone, so no other server can open it.
 */
export async function buildPeerLeafMaterial(
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  recipient: { serverId: string; keyId: string },
  ca: { certificatePem: string; privateKeyPem: string; trustBundlePem: string },
  ipAddresses: readonly string[] = []
): Promise<PeerLeafMaterial> {
  const issued = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, [PEER_LEAF_NAME], {
    commonName: PEER_LEAF_NAME,
    ...(ipAddresses.length > 0 ? { ipAddresses: [...ipAddresses] } : {}),
  })
  const sealedKey = await encryptSecret(dataEncryptionSecrets, issued.privateKeyPem)
  const privateKeyEnvelope = await resealSecretForDaemon(
    secretsConfig,
    dataEncryptionSecrets,
    recipient,
    sealedKey
  )
  return {
    certificatePem: issued.certificatePem,
    privateKeyEnvelope,
    caCertPem: ca.trustBundlePem,
    notAfter: issued.parsed.notAfter.toISOString(),
  }
}

type PeerLeafParams = { organizationId: string; serverId: string; nowMs?: number }

/**
 * Mint the material for the server's peer leaf, whatever is tracked. Used by
 * the renewal sweep and whenever a server needs the files again.
 */
export async function issuePeerLeaf(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: PeerLeafParams
): Promise<({ ok: true } & PeerLeafIssue) | { ok: false; error: PeerLeafError }> {
  const { organizationId, serverId } = params
  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return { ok: false, error: { kind: 'daemon_key_unavailable', serverId } }
  }
  const [owner] = await db
    .select({ organizationId: serverTable.organizationId })
    .from(serverTable)
    .where(eq(serverTable.id, serverId))
    .limit(1)
  if (owner?.organizationId !== organizationId) {
    return { ok: false, error: { kind: 'server_not_in_organization', serverId } }
  }
  const ca = await ensureActiveOrganizationCa(db, dataEncryptionSecrets, organizationId)
  if ('kind' in ca) return { ok: false, error: { kind: 'organization_ca_unavailable' } }

  const caPrivateKeyPem = await decryptSecret(dataEncryptionSecrets, ca.signer.privateKeyPemSealed)
  const addresses = await loadServerDatacenterAddresses(db, serverId)
  const material = await buildPeerLeafMaterial(
    secretsConfig,
    dataEncryptionSecrets,
    { serverId, keyId: daemonState.key.id },
    {
      certificatePem: ca.signer.certificatePem,
      privateKeyPem: caPrivateKeyPem,
      trustBundlePem: ca.trustBundlePem,
    },
    addresses
  )
  return {
    ok: true,
    material,
    pendingTlsLeaf: {
      kind: 'peer',
      organizationId,
      serverId,
      caId: ca.signer.id,
      caGeneration: ca.signer.caGeneration,
      notAfter: material.notAfter,
    },
  }
}

/**
 * Idempotent on-demand issue: when the server's tracked peer leaf is active,
 * signed by the active Organization CA generation and not within a third of
 * its lifetime of expiry, nothing is minted (`current`); otherwise a fresh
 * leaf is minted (`issued`).
 */
export async function ensurePeerLeaf(
  db: Db,
  secretsConfig: SecretsConfig,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: PeerLeafParams
): Promise<PeerLeafOutcome> {
  const [tracked] = await db
    .select({
      notAfter: leaf.notAfter,
      caGeneration: leaf.caGeneration,
      state: leaf.state,
      activeGeneration: tls.caGeneration,
    })
    .from(leaf)
    .leftJoin(
      tls,
      and(
        eq(tls.organizationId, leaf.organizationId),
        eq(tls.source, 'organization_ca'),
        eq(tls.caState, 'active')
      )
    )
    .where(
      and(
        eq(leaf.kind, 'peer'),
        eq(leaf.serverId, params.serverId),
        eq(leaf.organizationId, params.organizationId)
      )
    )
    .limit(1)
  if (
    tracked?.activeGeneration != null &&
    peerLeafIsCurrent(tracked, tracked.activeGeneration, params.nowMs)
  ) {
    return { status: 'current', notAfter: tracked.notAfter, caGeneration: tracked.caGeneration }
  }
  const issued = await issuePeerLeaf(db, secretsConfig, dataEncryptionSecrets, params)
  if (!issued.ok) return { status: 'failed', error: issued.error }
  return { status: 'issued', material: issued.material, pendingTlsLeaf: issued.pendingTlsLeaf }
}
