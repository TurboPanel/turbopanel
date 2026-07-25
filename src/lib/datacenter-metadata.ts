import type { ServerGeo } from './geo/server-geo.ts'
import { parseServerGeo } from './geo/server-geo.ts'

/** Documented shape for `datacenter.metadata` jsonb. */
export type DatacenterMetadata = {
  /** Geo / ASN snapshot captured when the datacenter was seeded from a server. */
  geo?: ServerGeo
  seededFromServerId?: string
  seededAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDatacenterMetadata(value: unknown): DatacenterMetadata {
  if (!isRecord(value)) return {}
  const metadata: DatacenterMetadata = {}
  const geo = parseServerGeo(value.geo)
  if (geo) metadata.geo = geo
  if (typeof value.seededFromServerId === 'string' && value.seededFromServerId.trim()) {
    metadata.seededFromServerId = value.seededFromServerId.trim()
  }
  if (typeof value.seededAt === 'string' && value.seededAt.trim()) {
    metadata.seededAt = value.seededAt.trim()
  }
  return metadata
}

export function buildSeededDatacenterMetadata(
  geo: ServerGeo,
  seededFromServerId: string,
): DatacenterMetadata {
  return {
    geo,
    seededFromServerId,
    seededAt: new Date().toISOString(),
  }
}
