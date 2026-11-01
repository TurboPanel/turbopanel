/**
 * What a daemon's `licenseId` + `licenseToken` pair on `POST /enroll` is.
 *
 * Three kinds share the two slots, told apart by lookup (the licence table
 * first, then the `ticket` table): a registration key (legacy form), a join
 * ticket that stands in for the key's own token, and a re-enroll ticket bound
 * to one server. Nothing is consumed here; the caller spends a ticket only
 * after the daemon's signature has checked out, so a bad signature cannot
 * burn one.
 *
 * Workers-bundleable: nothing at module load.
 */
import type { Db } from '../../db/connection.ts'
import { lookupActiveLicense } from './license.ts'
import { checkTicket, type TicketRow } from './tickets.ts'
import { verifyDaemonLicense, type VerifiedDaemonLicense } from './verify-daemon-license.ts'

export type EnrollCredential =
  | { kind: 'license'; licenseId: string; verified: VerifiedDaemonLicense }
  | { kind: 'join'; licenseId: string; ticket: TicketRow; verified: VerifiedDaemonLicense }
  | { kind: 'reenroll'; ticket: TicketRow }

/** The key a join ticket binds: active, unexpired, unbound, in the ticket's organization. */
async function joinTargetLicense(db: Db, ticket: TicketRow): Promise<VerifiedDaemonLicense | null> {
  if (!ticket.licenseId) return null
  const target = await lookupActiveLicense(db, ticket.licenseId)
  // A missing key gives `undefined`, which is not `null`, so it is refused here.
  if (target?.serverId !== null || target.organizationId !== ticket.organizationId) return null
  return { organizationId: target.organizationId }
}

/** Resolve the credential pair, or null when it is none of the three. */
export async function resolveEnrollCredential(
  db: Db,
  id: string,
  secret: string
): Promise<EnrollCredential | null> {
  const verified = await verifyDaemonLicense(db, id, secret)
  if (verified) return { kind: 'license', licenseId: id, verified }

  const checked = await checkTicket(db, id, secret)
  if (!checked.ok) return null
  const { ticket } = checked
  if (ticket.serverId) return { kind: 'reenroll', ticket }
  const target = await joinTargetLicense(db, ticket)
  if (!target || !ticket.licenseId) return null
  return { kind: 'join', licenseId: ticket.licenseId, ticket, verified: target }
}
