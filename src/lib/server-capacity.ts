/**
 * Organization server seat capacity — enrolled servers plus unconsumed
 * registration keys count against `organization.options.maxServers`.
 *
 * Omitted / null maxServers = unlimited (self-hosted default).
 */

import { and, count, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { license, organization, server } from './db/schema.ts'
import { parseOrganizationOptions } from './organization-options.ts'

export const SERVER_CAPACITY_EXCEEDED_ERROR = 'server_capacity_exceeded'

export type OrgServerCapacity = {
  /** Cap from org options; `null` means unlimited. */
  maxServers: number | null
  /** Rows in `server` for this organization. */
  serverCount: number
  /** Active licenses not yet latched to a server (reserved seats). */
  reservedSeatCount: number
  /** serverCount + reservedSeatCount. */
  usedSeats: number
  /** Remaining seats, or `null` when unlimited. */
  availableSeats: number | null
}

function toCount(value: unknown): number {
  return Number(value ?? 0)
}

/** Load seat usage and the configured cap for an organization. */
export async function loadOrgServerCapacity(
  db: Db,
  organizationId: string,
): Promise<OrgServerCapacity | null> {
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!orgRow) return null

  const options = parseOrganizationOptions(orgRow.options)
  const maxServers = typeof options.maxServers === 'number'
    ? options.maxServers
    : null

  const [[serverCountRow], [reservedSeatRow]] = await Promise.all([
    db
      .select({ value: count() })
      .from(server)
      .where(eq(server.organizationId, organizationId)),
    db
      .select({ value: count() })
      .from(license)
      .where(
        and(
          eq(license.organizationId, organizationId),
          isNull(license.revokedAt),
          isNull(license.serverId),
        ),
      ),
  ])

  const serverCount = toCount(serverCountRow?.value)
  const reservedSeatCount = toCount(reservedSeatRow?.value)
  const usedSeats = serverCount + reservedSeatCount
  const availableSeats = maxServers === null
    ? null
    : Math.max(0, maxServers - usedSeats)

  return {
    maxServers,
    serverCount,
    reservedSeatCount,
    usedSeats,
    availableSeats,
  }
}

/** Whether minting one more registration key is allowed. */
export function canReserveServerSeat(capacity: OrgServerCapacity): boolean {
  if (capacity.maxServers === null) return true
  return capacity.usedSeats < capacity.maxServers
}
