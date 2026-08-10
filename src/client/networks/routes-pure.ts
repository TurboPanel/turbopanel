import type { Context } from 'hono'
import { isValidCidr } from '../../lib/ip-address.ts'
import { normalizeDockerNetworkOptions } from '../../lib/docker-network-name.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { buildPatchUpdateFields, parseDisplayName, parseJsonbObject } from '../shared.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NETWORK_KINDS = new Set(['datacenter', 'docker'])

export function parseUuidQueryParam(
  c: Context,
  raw: string | undefined,
): string | undefined | Response {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  if (!UUID_RE.test(trimmed)) return c.json({ error: 'Invalid request' }, 400)
  return trimmed
}

export function resolveKindQueryFilter(c: Context): string | undefined | Response {
  const kindFilter = c.req.query('kind')?.trim()
  if (!kindFilter) return undefined
  if (!NETWORK_KINDS.has(kindFilter)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindFilter
}

export function parseCreateOrganizationId(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const orgIdRaw = body.organizationId
  if (typeof orgIdRaw !== 'string' || !UUID_RE.test(orgIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const contextOrgId = c.req.header(ORG_ID_HEADER)?.trim() ||
    c.req.query('organizationId')?.trim()
  if (contextOrgId && contextOrgId !== orgIdRaw) {
    return c.json({ error: 'organizationId mismatch' }, 400)
  }

  return orgIdRaw
}

export function parseNetworkKind(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  const kindRaw = body.kind
  if (typeof kindRaw !== 'string' || !NETWORK_KINDS.has(kindRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return kindRaw
}

export function parseOptionalDisplayNameField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.displayName === undefined) return null
  try {
    return parseDisplayName(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
}

export function parseOptionalCidrField(
  c: Context,
  body: Record<string, unknown>,
): string | null | Response {
  if (body.cidr === undefined || body.cidr === null) return null
  if (typeof body.cidr !== 'string' || !isValidCidr(body.cidr)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body.cidr.trim()
}

export type NetworkPatchFields = {
  displayName?: string | null
  name?: string | null
  cidr?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

export function applyCidrPatch(
  c: Context,
  body: Record<string, unknown>,
  patchFields: NetworkPatchFields,
): Response | null {
  if (body.cidr === undefined) return null
  if (body.cidr === null) {
    patchFields.cidr = null
    return null
  }
  if (typeof body.cidr === 'string' && isValidCidr(body.cidr)) {
    patchFields.cidr = body.cidr.trim()
    return null
  }
  return c.json({ error: 'Invalid request' }, 400)
}

/**
 * `kind: docker` rows register long-lived host Docker networks for compose
 * `networks.*.external`. Require a valid `options.dockerNetworkName`.
 */
export function requireDockerNetworkOptions(
  c: Context,
  options: Record<string, unknown> | null,
): Record<string, unknown> | Response {
  const normalized = normalizeDockerNetworkOptions(options)
  if (!normalized) {
    return c.json({ error: 'docker_network_name_required' }, 400)
  }
  return normalized
}

export function parseNetworkPatchFields(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
): NetworkPatchFields | Response {
  let patchFields: NetworkPatchFields
  try {
    patchFields = buildPatchUpdateFields(body)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (body.displayName !== undefined) {
    try {
      patchFields.name = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }
  }

  const cidrDenied = applyCidrPatch(c, body, patchFields)
  if (cidrDenied) return cidrDenied

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult !== null) {
    if (kind === 'docker') {
      const dockerOptions = requireDockerNetworkOptions(c, optionsResult)
      if (dockerOptions instanceof Response) return dockerOptions
      patchFields.options = dockerOptions
    } else {
      patchFields.options = optionsResult
    }
  }

  return patchFields
}

export function parseCreateNetworkOptions(
  c: Context,
  body: Record<string, unknown>,
  kind: string,
): Record<string, unknown> | null | Response {
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (kind !== 'docker') return optionsResult
  return requireDockerNetworkOptions(c, optionsResult)
}

export function rejectImmutableNetworkScopePatch(
  c: Context,
  body: Record<string, unknown>,
): Response | null {
  if (body.datacenterId !== undefined || body.serverId !== undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return null
}
