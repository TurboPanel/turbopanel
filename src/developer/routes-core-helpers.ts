import { eq } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'
import { organization } from '../db/schema.ts'
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameCodePointLength,
  isValidDisplayName,
  normalizeDisplayName,
} from '../lib/display-name-format.ts'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedDisplayName = { ok: true; value: string | null } | { ok: false; error: string }

export function parseDisplayNameInput(displayName: unknown): ParsedDisplayName {
  if (displayName === null) return { ok: true, value: null }
  if (typeof displayName !== 'string') {
    return { ok: false, error: 'displayName must be a string or null' }
  }
  const value = normalizeDisplayName(displayName)
  if (displayNameCodePointLength(value) > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `displayName must be at most ${String(DISPLAY_NAME_MAX_LENGTH)} characters`,
    }
  }
  if (value.length > 0 && !isValidDisplayName(value)) {
    return { ok: false, error: 'displayName must not contain control characters' }
  }
  return { ok: true, value }
}

export type ParsedOrganizationId =
  { ok: true; value: string | null } | { ok: false; error: string; status: 400 | 404 }

export async function parseOrganizationIdInput(
  db: Db,
  organizationId: unknown
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

export type PayloadBodyParse = { ok: true; payload: unknown } | { ok: false; error: string }

export function parsePayloadBody(body: unknown): PayloadBodyParse {
  if (!body || typeof body !== 'object' || !('payload' in body)) {
    return { ok: false, error: 'expected { payload: unknown }' }
  }
  return { ok: true, payload: (body as { payload: unknown }).payload }
}
