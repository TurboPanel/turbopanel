import { eq } from 'drizzle-orm'
import type { Db } from '../db.ts'
import type { ServerAddresses } from '../server-addresses.ts'
import { organization } from '../lib/db/schema.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function extractAddresses(record: { status: string; result?: unknown }): ServerAddresses {
  if (record.status !== 'done') {
    throw new Error(record.status === 'expired'
      ? 'timeout waiting for addresses'
      : 'failed to fetch addresses')
  }
  const result = record.result as { addresses?: ServerAddresses } | undefined
  if (!result?.addresses) throw new Error('missing addresses in daemon response')
  return result.addresses
}

export type ParsedDisplayName =
  | { ok: true; value: string | null }
  | { ok: false; error: string }

export function parseDisplayNameInput(displayName: unknown): ParsedDisplayName {
  if (displayName === null) return { ok: true, value: null }
  if (typeof displayName !== 'string') {
    return { ok: false, error: 'displayName must be a string or null' }
  }
  const trimmed = displayName.trim()
  if (trimmed.length > 255) {
    return { ok: false, error: 'displayName must be at most 255 characters' }
  }
  return { ok: true, value: trimmed }
}

export type ParsedOrganizationId =
  | { ok: true; value: string | null }
  | { ok: false; error: string; status: 400 | 404 }

export async function parseOrganizationIdInput(
  db: Db,
  organizationId: unknown,
): Promise<ParsedOrganizationId> {
  if (organizationId === null) return { ok: true, value: null }
  if (typeof organizationId === 'string') {
    const trimmed = organizationId.trim()
    if (!UUID_RE.test(trimmed)) {
      return { ok: false, error: 'organizationId must be a valid UUID', status: 400 }
    }
    const org = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, trimmed))
      .limit(1)
    if (org.length === 0) {
      return { ok: false, error: 'Organization not found', status: 404 }
    }
    return { ok: true, value: trimmed }
  }
  return { ok: false, error: 'organizationId must be a string or null', status: 400 }
}

export function resolvePerServerLimit(limitRaw: string | undefined): number {
  const limit = Number(limitRaw ?? 50)
  return Number.isFinite(limit) ? limit : 50
}

export type PayloadBodyParse =
  | { ok: true; payload: unknown }
  | { ok: false; error: string }

export function parsePayloadBody(body: unknown): PayloadBodyParse {
  if (!body || typeof body !== 'object' || !('payload' in body)) {
    return { ok: false, error: 'expected { payload: unknown }' }
  }
  return { ok: true, payload: (body as { payload: unknown }).payload }
}

export function addressesFetchErrorStatus(message: string): 404 | 500 {
  return message === 'daemon not connected' ? 404 : 500
}
