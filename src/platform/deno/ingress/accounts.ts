/**
 * Install-level provider accounts (`ingress` table) for the control plane's
 * own hostnames. The token is sealed in `token_envelope`; it leaves this file
 * only through `openAccountToken`, and the public shape never carries it.
 */
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { ingressAccount } from '../../../db/schema.ts'
import type { IngressProviderId } from '../../../features/install/ingress-modes.ts'
import { decryptSecret } from '../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'

export type ProviderZone = { id: string; name: string }

/** The last preflight, as stored in `ingress.scopes`. */
export type AccountScopes = {
  tunnels: boolean
  dns: boolean
  checkedAt: string
  zones: ProviderZone[]
  /** When the provider says the token stops working; null when it never does. */
  expiresOn: string | null
}

export type IngressAccountRecord = {
  id: string
  provider: IngressProviderId
  label: string
  accountId: string | null
  zoneIds: string[]
  scopes: AccountScopes | null
  lastVerifiedAt: string | null
  lastError: string | null
  createdAt: string
}

type AccountRow = typeof ingressAccount.$inferSelect

function readZones(value: unknown): ProviderZone[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const zone = item as Partial<ProviderZone> | null
    return typeof zone?.id === 'string' && typeof zone.name === 'string'
      ? [{ id: zone.id, name: zone.name }]
      : []
  })
}

export function readScopes(value: unknown): AccountScopes | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  return {
    tunnels: raw.tunnels === true,
    dns: raw.dns === true,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : '',
    zones: readZones(raw.zones),
    expiresOn: typeof raw.expiresOn === 'string' ? raw.expiresOn : null,
  }
}

function toRecord(row: AccountRow): IngressAccountRecord {
  return {
    id: row.id,
    provider: row.provider === 'bunny' ? 'bunny' : 'cloudflare',
    label: row.label,
    accountId: row.accountId,
    zoneIds: Array.isArray(row.zoneIds)
      ? row.zoneIds.filter((id): id is string => typeof id === 'string')
      : [],
    scopes: readScopes(row.scopes),
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  }
}

export async function listIngressAccounts(db: Db): Promise<IngressAccountRecord[]> {
  const rows = await db.select().from(ingressAccount).orderBy(asc(ingressAccount.createdAt))
  return rows.map(toRecord)
}

export async function findIngressAccount(db: Db, id: string): Promise<IngressAccountRecord | null> {
  const rows = await db.select().from(ingressAccount).where(eq(ingressAccount.id, id)).limit(1)
  return rows[0] ? toRecord(rows[0]) : null
}

/** The plaintext token of one account. Callers keep it in the call frame only. */
export async function openAccountToken(
  db: Db,
  secrets: DerivedSecretsConfig,
  account: Pick<IngressAccountRecord, 'id'>
): Promise<string> {
  const rows = await db
    .select({ envelope: ingressAccount.tokenEnvelope })
    .from(ingressAccount)
    .where(eq(ingressAccount.id, account.id))
    .limit(1)
  const envelope = rows[0]?.envelope
  if (!envelope) throw new Error('The provider account no longer exists.')
  return await decryptSecret(secrets, envelope)
}

/** The zone a name belongs to: the longest zone name that is the name or a parent of it. */
export function zoneForName(zones: readonly ProviderZone[], name: string): ProviderZone | null {
  const wanted = name.toLowerCase().replace(/\.$/, '')
  let best: ProviderZone | null = null
  for (const zone of zones) {
    const zoneName = zone.name.toLowerCase()
    const matches = wanted === zoneName || wanted.endsWith(`.${zoneName}`)
    if (matches && (!best || zoneName.length > best.name.length)) best = zone
  }
  return best
}
