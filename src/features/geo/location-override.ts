/**
 * Editable location for servers and datacenters.
 *
 * Cloudflare's connect-time geo (`ServerGeo`, captured on `server.metadata.geo`
 * and seeded onto `datacenter.metadata.geo`) only supplies the *initial*
 * values. An operator may override any field; the override lives on the row's
 * `options.location` (operator-controlled jsonb), never on `metadata`, so the
 * daemon connect path — which rewrites `metadata.geo` whenever the connecting
 * IP changes — can never clobber it. Every field the API returns is
 * `override ?? detected ?? null`.
 */

import type { ServerGeo } from './server-geo.ts'
import { parseServerGeo } from './server-geo.ts'

/** The location fields an operator may override. */
export type LocationFields = {
  city?: string
  /** State / province name (Cloudflare `region`). */
  region?: string
  /** State / province code (Cloudflare `regionCode`, e.g. `"TX"`). */
  regionCode?: string
  /** ISO 3166-1 alpha-2 (Cloudflare `country`), upper-case. */
  country?: string
  asn?: number
  /** AS organization name (Cloudflare `asOrganization`). */
  asOrganization?: string
}

export type LocationField = keyof LocationFields

export const LOCATION_FIELDS = [
  'city',
  'region',
  'regionCode',
  'country',
  'asn',
  'asOrganization',
] as const satisfies readonly LocationField[]

const STRING_FIELD_MAX_LENGTH: Record<Exclude<LocationField, 'asn'>, number> = {
  city: 128,
  region: 128,
  regionCode: 16,
  country: 2,
  asOrganization: 256,
}

/** Largest 32-bit ASN (RFC 6793). */
export const MAX_ASN = 4_294_967_295

/**
 * A PATCH `location` body: each present field sets that field's override,
 * `null` (or `""`) clears it back to the detected value. The whole `location`
 * being `null` resets every field.
 */
export type LocationPatch = { [K in LocationField]?: LocationFields[K] | null }

/** One field's value in the resolved view: override, else detected, else null. */
export type ResolvedLocationFields = {
  city: string | null
  region: string | null
  regionCode: string | null
  country: string | null
  asn: number | null
  asOrganization: string | null
}

/** What `GET` returns as `location` for a server or datacenter. */
export type ResolvedLocation = ResolvedLocationFields & {
  /** `custom` when at least one field is overridden, else `detected`. */
  source: 'detected' | 'custom'
  /** The fields currently overridden (the ones a per-field reset applies to). */
  overridden: LocationField[]
  /** Cloudflare's values, untouched by overrides (for "reset to detected"). */
  detected: ResolvedLocationFields
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCountry(value: string): string | null {
  const upper = value.toUpperCase()
  // Cloudflare reports ISO alpha-2 plus its own `XX` (unknown) and `T1` (Tor).
  return /^[A-Z][A-Z0-9]$/.test(upper) ? upper : null
}

function normalizeAsn(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && /^(as)?\d+$/i.test(value.trim())) {
    n = Number(value.trim().replace(/^as/i, ''))
  } else {
    return null
  }
  return Number.isInteger(n) && n > 0 && n <= MAX_ASN ? n : null
}

/** Normalize one string field, or `null` when it is not an acceptable value. */
function normalizeStringField(field: Exclude<LocationField, 'asn'>, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > STRING_FIELD_MAX_LENGTH[field]) return null
  if (field === 'country') return normalizeCountry(trimmed)
  return trimmed
}

/**
 * Lenient parser for a stored `options.location` blob: invalid or unknown
 * keys are dropped. `undefined` when nothing valid remains.
 */
export function parseLocationOverride(value: unknown): LocationFields | undefined {
  if (!isRecord(value)) return undefined
  const out: LocationFields = {}
  for (const field of LOCATION_FIELDS) {
    if (field === 'asn') {
      const asn = normalizeAsn(value.asn)
      if (asn !== null) out.asn = asn
      continue
    }
    const text = normalizeStringField(field, value[field])
    if (text !== null) out[field] = text
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export type LocationPatchParseResult =
  { ok: true; value: LocationPatch | null } | { ok: false; error: string }

function isLocationField(key: string): key is LocationField {
  return (LOCATION_FIELDS as readonly string[]).includes(key)
}

type LocationPatchFieldParse =
  { ok: true; value: string | number | null } | { ok: false; error: string }

/** One present field of a PATCH body: `null` / blank text clears, else it must be valid. */
function parseLocationPatchField(field: LocationField, value: unknown): LocationPatchFieldParse {
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, value: null }
  }
  const parsed = field === 'asn' ? normalizeAsn(value) : normalizeStringField(field, value)
  if (parsed === null) return { ok: false, error: `Invalid location.${field}` }
  return { ok: true, value: parsed }
}

/**
 * Strict parser for a request's `location`: unknown keys and invalid values
 * are refused (400) rather than silently dropped. `null` → reset everything.
 */
export function parseLocationPatchInput(raw: unknown): LocationPatchParseResult {
  if (raw === null) return { ok: true, value: null }
  if (!isRecord(raw)) return { ok: false, error: 'Invalid location' }
  const unknownKey = Object.keys(raw).find((key) => !isLocationField(key))
  if (unknownKey !== undefined) {
    return { ok: false, error: `Invalid location field: ${unknownKey}` }
  }
  const patch: Record<string, string | number | null> = {}
  for (const field of LOCATION_FIELDS) {
    if (!(field in raw)) continue
    const parsed = parseLocationPatchField(field, raw[field])
    if (!parsed.ok) return parsed
    patch[field] = parsed.value
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Invalid location' }
  return { ok: true, value: patch as LocationPatch }
}

/**
 * The override to store after applying `patch` to `previous`: set fields
 * replace, `null` fields are removed, `patch === null` resets everything.
 * Returns `null` when no override remains (the key should be removed).
 */
export function applyLocationPatch(
  previous: LocationFields | undefined,
  patch: LocationPatch | null
): LocationFields | null {
  if (patch === null) return null
  const next: Record<string, unknown> = { ...previous }
  for (const field of LOCATION_FIELDS) {
    if (!(field in patch)) continue
    const value = patch[field]
    if (value === null || value === undefined) delete next[field]
    else next[field] = value
  }
  return parseLocationOverride(next) ?? null
}

function detectedFields(geo: ServerGeo | null): ResolvedLocationFields {
  return {
    city: geo?.city ?? null,
    region: geo?.region ?? null,
    regionCode: geo?.regionCode ?? null,
    country: geo?.country ?? null,
    asn: geo?.asn ?? null,
    asOrganization: geo?.asOrganization ?? null,
  }
}

/**
 * The `location` a server or datacenter DTO carries. `rawOptions` is the row's
 * `options` jsonb as stored (the override is read from `options.location`);
 * `detectedGeo` is Cloudflare's snapshot — a server's live `metadata.geo`, a
 * datacenter's seeded `metadata.geo` (see {@link datacenterDetectedGeo}).
 */
export function resolveLocation(
  rawOptions: unknown,
  detectedGeo: ServerGeo | null | undefined
): ResolvedLocation {
  const override = parseLocationOverride(isRecord(rawOptions) ? rawOptions.location : undefined)
  const detected = detectedFields(detectedGeo ?? null)
  const overridden = LOCATION_FIELDS.filter((field) => override?.[field] !== undefined)
  return {
    city: override?.city ?? detected.city,
    region: override?.region ?? detected.region,
    regionCode: override?.regionCode ?? detected.regionCode,
    country: override?.country ?? detected.country,
    asn: override?.asn ?? detected.asn,
    asOrganization: override?.asOrganization ?? detected.asOrganization,
    source: overridden.length > 0 ? 'custom' : 'detected',
    overridden,
    detected,
  }
}

/**
 * A datacenter's detected location: the geo snapshot seeded onto
 * `datacenter.metadata.geo` from its source (or first member) server when the
 * datacenter was created. A datacenter created before that server reported
 * any geo has none, and every field starts empty until an operator sets it.
 */
export function datacenterDetectedGeo(rawMetadata: unknown): ServerGeo | null {
  return parseServerGeo(isRecord(rawMetadata) ? rawMetadata.geo : null)
}
