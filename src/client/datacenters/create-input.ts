import { buildSeededDatacenterMetadata } from '../../lib/datacenter-metadata.ts'
import { parseDatacenterOptions } from '../../lib/datacenter-options.ts'
import { suggestDatacenterDisplayNameFromGeo } from '../../lib/datacenter-name-suggestions.ts'
import { parseServerGeo } from '../../lib/geo/server-geo.ts'
import {
  isValidCidr,
  isValidIpAddress,
  stripInetPrefixSuffix,
} from '../../lib/ip-address.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MAX_MEMBERS = 64

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false }

export function parseOptionalUuid(value: unknown): ParseResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null }
  }
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

export function parseRequiredCidr(value: unknown): ParseResult<string> {
  if (typeof value !== 'string' || !isValidCidr(value.trim())) {
    return { ok: false }
  }
  return { ok: true, value: value.trim() }
}

export type ParsedMemberPin = {
  serverId: string
  address: string
}

export function parseMemberPins(value: unknown): ParseResult<ParsedMemberPin[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEMBERS) {
    return { ok: false }
  }
  const pins: ParsedMemberPin[] = []
  const seenServers = new Set<string>()
  const seenAddresses = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false }
    }
    const record = entry as Record<string, unknown>
    if (typeof record.serverId !== 'string' || !UUID_RE.test(record.serverId)) {
      return { ok: false }
    }
    if (typeof record.address !== 'string') return { ok: false }
    const address = stripInetPrefixSuffix(record.address.trim())
    if (!address || !isValidIpAddress(address)) return { ok: false }
    if (seenServers.has(record.serverId) || seenAddresses.has(address)) {
      return { ok: false }
    }
    seenServers.add(record.serverId)
    seenAddresses.add(address)
    pins.push({ serverId: record.serverId, address })
  }
  return { ok: true, value: pins }
}

export function mergeDatacenterMetadata(
  seededMetadata: Record<string, unknown> | null,
  requestMetadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!seededMetadata) return requestMetadata
  if (!requestMetadata) return seededMetadata
  return { ...seededMetadata, ...requestMetadata }
}

export type CreateDatacenterInput = {
  name: string | null
  description: string | null
  metadata: Record<string, unknown> | null
  options: ReturnType<typeof parseDatacenterOptions> | null
  members: ParsedMemberPin[]
  sourceServerId: string | null
}

export type SelectedServerRow = {
  id: string
  metadata: unknown
}

export function resolveSeededFields(
  input: CreateDatacenterInput,
  rows: SelectedServerRow[],
): {
  name: string | null
  metadata: Record<string, unknown> | null
} {
  const sourceServerId = input.sourceServerId ?? input.members[0]?.serverId ??
    null
  if (!sourceServerId) {
    return { name: input.name, metadata: input.metadata }
  }

  const sourceRow = rows.find((row) => row.id === sourceServerId)
  const rawMetadata = sourceRow?.metadata
  const geo = parseServerGeo(
    typeof rawMetadata === 'object' &&
      rawMetadata !== null &&
      !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>).geo
      : null,
  )
  if (!geo) {
    return { name: input.name, metadata: input.metadata }
  }

  const seededMetadata = buildSeededDatacenterMetadata(
    geo,
    sourceServerId,
  )
  return {
    name: input.name ??
      suggestDatacenterDisplayNameFromGeo(geo),
    metadata: mergeDatacenterMetadata(seededMetadata, input.metadata),
  }
}

export function attachPrivateCidrs<T extends { id: string }>(
  rows: readonly T[],
  cidrsByDc: ReadonlyMap<string, string[]>,
): Array<T & { privateCidrs: string[] }> {
  return rows.map((row) => ({
    ...row,
    privateCidrs: cidrsByDc.get(row.id) ?? [],
  }))
}

export function parseNameSuggestionsQuery(
  unassignedOnlyRaw: string | undefined,
  limitRaw: string | undefined,
):
  | { unassignedOnly: boolean; limit: number }
  | 'invalid' {
  const unassignedOnly = unassignedOnlyRaw !== '0'
  const limit = limitRaw === undefined ? 8 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 0 || limit > 32) {
    return 'invalid'
  }
  return { unassignedOnly, limit }
}
