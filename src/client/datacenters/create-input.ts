import { buildSeededDatacenterMetadata } from '../../lib/datacenter-metadata.ts'
import { parseDatacenterOptions } from '../../lib/datacenter-options.ts'
import { suggestDatacenterDisplayNameFromGeo } from '../../lib/datacenter-name-suggestions.ts'
import { parseServerGeo } from '../../lib/geo/server-geo.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MAX_ASSIGN_SERVERS = 64

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false }

export function parseAssignServerIds(value: unknown): ParseResult<string[]> {
  if (value === undefined || value === null) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(value) || value.length > MAX_ASSIGN_SERVERS) {
    return { ok: false }
  }
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) {
      return { ok: false }
    }
    ids.push(entry)
  }
  return { ok: true, value: [...new Set(ids)] }
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
  sourceServerId: string | null
  assignServerIds: string[]
}

export type SelectedServerRow = {
  id: string
  datacenterId: string | null
  metadata: unknown
}

export function resolveSeededFields(
  input: CreateDatacenterInput,
  rows: SelectedServerRow[],
): {
  name: string | null
  metadata: Record<string, unknown> | null
} {
  if (!input.sourceServerId) {
    return { name: input.name, metadata: input.metadata }
  }

  const sourceRow = rows.find((row) => row.id === input.sourceServerId)
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
    input.sourceServerId,
  )
  return {
    name: input.name ??
      suggestDatacenterDisplayNameFromGeo(geo),
    metadata: mergeDatacenterMetadata(seededMetadata, input.metadata),
  }
}
