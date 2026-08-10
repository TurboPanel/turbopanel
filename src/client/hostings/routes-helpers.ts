import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { ip } from '../../lib/db/schema.ts'
import { parseHostingOptions, resolveHostingBind } from '../../lib/hosting-options.ts'
import { buildPatchUpdateFields, parseJsonbObject } from '../shared.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'

export const HOSTING_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isHostingUuid(value: unknown): value is string {
  return typeof value === 'string' && HOSTING_UUID_RE.test(value)
}

export type OptionalTlsIdResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: string | null }
  | { kind: 'error'; response: Response }

export async function parseOptionalTlsId(
  c: Context,
  db: Db,
  organizationId: string,
  tlsIdRaw: unknown,
): Promise<OptionalTlsIdResult> {
  if (tlsIdRaw === undefined) return { kind: 'absent' }
  if (tlsIdRaw === null) return { kind: 'value', value: null }
  if (isHostingUuid(tlsIdRaw)) {
    const tlsOrgId = await resolveEntityOrganizationId(db, 'tls', tlsIdRaw)
    if (tlsOrgId !== organizationId) {
      return { kind: 'error', response: c.json({ error: 'Not found' }, 404) }
    }
    return { kind: 'value', value: tlsIdRaw }
  }
  return { kind: 'error', response: c.json({ error: 'Invalid request' }, 400) }
}

export type OptionalIpIdResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: string | null }
  | { kind: 'error'; response: Response }

export async function parseOptionalIpId(
  c: Context,
  db: Db,
  organizationId: string,
  ipIdRaw: unknown,
): Promise<OptionalIpIdResult> {
  if (ipIdRaw === undefined) return { kind: 'absent' }
  if (ipIdRaw === null) return { kind: 'value', value: null }
  if (isHostingUuid(ipIdRaw)) {
    const ipOrgId = await resolveEntityOrganizationId(db, 'ip', ipIdRaw)
    if (ipOrgId !== organizationId) {
      return { kind: 'error', response: c.json({ error: 'Not found' }, 404) }
    }
    return { kind: 'value', value: ipIdRaw }
  }
  return { kind: 'error', response: c.json({ error: 'Invalid request' }, 400) }
}

export async function assertHostingPublicBindScope(
  c: Context,
  db: Db,
  ipId: string,
  options: ReturnType<typeof parseHostingOptions> | null,
): Promise<Response | null> {
  const bind = resolveHostingBind(options ?? undefined)
  if (bind !== 'public') return null
  const [ipRow] = await db
    .select({ scope: ip.scope })
    .from(ip)
    .where(eq(ip.id, ipId))
    .limit(1)
  if (ipRow?.scope !== 'public') {
    return c.json({ error: 'hosting_bind_scope_mismatch' }, 400)
  }
  return null
}

export type OptionalHostingOptionsResult =
  | { kind: 'absent' }
  | { kind: 'value'; value: NonNullable<ReturnType<typeof parseHostingOptions>> }
  | { kind: 'error'; response: Response }

export function parseOptionalHostingOptions(
  c: Context,
  body: Record<string, unknown>,
): OptionalHostingOptionsResult {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return { kind: 'error', response: optionsResult }
  if (optionsResult === null) return { kind: 'absent' }
  const parsed = parseHostingOptions(optionsResult)
  if (parsed === null) {
    return { kind: 'error', response: c.json({ error: 'invalid_hosting_options' }, 400) }
  }
  return { kind: 'value', value: parsed }
}

export type HostingFkResult =
  | { kind: 'error'; response: Response }
  | {
    kind: 'ok'
    tlsId: Extract<OptionalTlsIdResult, { kind: 'absent' | 'value' }>
    ipId: Extract<OptionalIpIdResult, { kind: 'absent' | 'value' }>
  }

export async function resolveOptionalHostingFks(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<HostingFkResult> {
  const tlsIdResult = await parseOptionalTlsId(c, db, organizationId, body.tlsId)
  if (tlsIdResult.kind === 'error') {
    return { kind: 'error', response: tlsIdResult.response }
  }
  const ipIdResult = await parseOptionalIpId(c, db, organizationId, body.ipId)
  if (ipIdResult.kind === 'error') {
    return { kind: 'error', response: ipIdResult.response }
  }
  return { kind: 'ok', tlsId: tlsIdResult, ipId: ipIdResult }
}

export type HostingPatchFields = {
  displayName?: string | null
  description?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  tlsId?: string | null
  ipId?: string | null
  updatedAt: string
}

export async function buildHostingPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<HostingPatchFields | Response> {
  let patchFields: HostingPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsResult = parseOptionalHostingOptions(c, body)
  if (optionsResult.kind === 'error') return optionsResult.response
  if (optionsResult.kind === 'value') patchFields.options = optionsResult.value

  const fks = await resolveOptionalHostingFks(c, db, organizationId, body)
  if (fks.kind === 'error') return fks.response
  if (fks.tlsId.kind === 'value') patchFields.tlsId = fks.tlsId.value
  if (fks.ipId.kind === 'value') patchFields.ipId = fks.ipId.value

  return patchFields
}

export async function assertCreateHostingBindScope(
  c: Context,
  db: Db,
  ipIdResult: Extract<OptionalIpIdResult, { kind: 'absent' | 'value' }>,
  options: ReturnType<typeof parseHostingOptions> | null,
): Promise<Response | null> {
  if (ipIdResult.kind !== 'value' || !ipIdResult.value) return null
  return assertHostingPublicBindScope(c, db, ipIdResult.value, options)
}

export async function assertMergedHostingBindScope(
  c: Context,
  db: Db,
  existing: Readonly<{ ipId: string | null; options: unknown }>,
  patchFields: Readonly<{ ipId?: string | null; options?: Record<string, unknown> | null }>,
): Promise<Response | null> {
  const mergedOptions = patchFields.options === undefined
    ? parseHostingOptions(existing.options)
    : parseHostingOptions(patchFields.options)
  // Prefer assignment over `??`: null clears the pin; only undefined keeps existing.
  let effectiveIpId = existing.ipId
  if (patchFields.ipId !== undefined) {
    effectiveIpId = patchFields.ipId
  }
  if (!effectiveIpId) return null
  return assertHostingPublicBindScope(c, db, effectiveIpId, mergedOptions)
}

export function parseCreateServiceId(body: Record<string, unknown>): string | null {
  const serviceIdRaw = body.serviceId
  if (typeof serviceIdRaw !== 'string' || serviceIdRaw.trim().length === 0) {
    return null
  }
  return serviceIdRaw.trim()
}
