/**
 * Single canonical server geolocation contract consumed by the daemon connect
 * path, Postgres projection, read model, client API, and UI.
 */

export type ServerGeo = {
  asOrganization?: string
  country?: string
  city?: string
  continent?: string
  region?: string
  regionCode?: string
  timezone?: string
  longitude?: string
  latitude?: string
  postalCode?: string
  metroCode?: string
  asn?: number
  /** Cloudflare edge colo (IATA code), e.g. `"DFW"`. */
  datacenter?: string
  capturedAt?: string
}

const STRING_GEO_FIELDS = [
  'asOrganization',
  'country',
  'city',
  'continent',
  'region',
  'regionCode',
  'timezone',
  'longitude',
  'latitude',
  'postalCode',
  'metroCode',
  'datacenter',
] as const satisfies readonly (keyof ServerGeo)[]

type StringGeoField = (typeof STRING_GEO_FIELDS)[number]

const GEO_EQUALITY_FIELDS = [
  'asOrganization',
  'country',
  'city',
  'continent',
  'region',
  'regionCode',
  'timezone',
  'longitude',
  'latitude',
  'postalCode',
  'metroCode',
  'asn',
  'datacenter',
] as const satisfies readonly (keyof ServerGeo)[]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isGeoRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function copyStringGeoField(
  source: Record<string, unknown>,
  target: ServerGeo,
  field: StringGeoField,
): boolean {
  const value = source[field]
  if (!isNonEmptyString(value)) return false
  target[field] = value.trim()
  return true
}

function copyAsn(source: Record<string, unknown>, target: ServerGeo): boolean {
  if (source.asn === undefined || source.asn === null) return false
  const asn = Number(source.asn)
  if (!Number.isFinite(asn)) return false
  target.asn = asn
  return true
}

/** Cloudflare `request.cf.colo` is exposed as `datacenter` in the server geo contract. */
function copyDatacenter(
  source: Record<string, unknown>,
  target: ServerGeo,
): boolean {
  const value = source.datacenter ?? source.colo
  if (!isNonEmptyString(value)) return false
  target.datacenter = value.trim()
  return true
}

function narrowGeoRecord(
  source: Record<string, unknown>,
  options?: { preserveCapturedAt?: boolean },
): ServerGeo | null {
  const geo: ServerGeo = {}
  let hasGeoField = false

  for (const field of STRING_GEO_FIELDS) {
    if (copyStringGeoField(source, geo, field)) {
      hasGeoField = true
    }
  }

  if (copyAsn(source, geo)) {
    hasGeoField = true
  }

  if (copyDatacenter(source, geo)) {
    hasGeoField = true
  }

  if (options?.preserveCapturedAt && isNonEmptyString(source.capturedAt)) {
    geo.capturedAt = source.capturedAt.trim()
  }

  return hasGeoField ? geo : null
}

export function extractCloudflareGeo(cf: unknown): ServerGeo | null {
  if (!isGeoRecord(cf)) return null

  const geo = narrowGeoRecord(cf)
  if (!geo) return null

  geo.capturedAt = new Date().toISOString()
  return geo
}

/**
 * Compares two geo snapshots for equality. Ignores `capturedAt` so timestamp
 * churn does not trigger spurious writes during projection.
 */
export function geoEquals(
  a: ServerGeo | null | undefined,
  b: ServerGeo | null | undefined,
): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false

  for (const field of GEO_EQUALITY_FIELDS) {
    if (a[field] !== b[field]) return false
  }

  return true
}

export function parseServerGeo(raw: unknown): ServerGeo | null {
  if (!isGeoRecord(raw)) return null
  return narrowGeoRecord(raw, { preserveCapturedAt: true })
}
