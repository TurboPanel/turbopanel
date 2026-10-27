import {
  isValidDisplayName,
  normalizeDisplayName,
  normalizeDisplayNameKey,
} from '../../lib/display-name-format.ts'
import {
  isUnusedKeyExpired,
  LICENSE_KEY_UNUSED_TTL_DAYS,
} from '../../features/licenses/key-expiry.ts'

export type LicenseCreateFields = {
  name?: string
  installBaseUrl?: string
  /** Hosted Add Server: the tier the manager chose; the key holds a seat there for its server. */
  tierId?: string
}

const TIER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function optionalStringField(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string') return { ok: false }
  return { ok: true, value }
}

/**
 * Optional license labels: blank/whitespace is omitted; non-empty values use
 * the shared display-name contract (trim, NFC, apostrophe-fold, length, no
 * control characters).
 */
function parseOptionalLicenseName(
  value: string | undefined
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  const name = normalizeDisplayName(value)
  if (!name) return { ok: true }
  if (!isValidDisplayName(name)) return { ok: false }
  return { ok: true, value: name }
}

export function parseLicenseCreateFields(rawBody: string): LicenseCreateFields | 'invalid' {
  if (!rawBody.trim()) {
    return {}
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return 'invalid'
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }

  const record = body as Record<string, unknown>
  const nameField = optionalStringField(record.name)
  if (!nameField.ok) return 'invalid'
  const installBaseUrl = optionalStringField(record.installBaseUrl)
  if (!installBaseUrl.ok) return 'invalid'
  const tierId = optionalStringField(record.tierId)
  if (!tierId.ok || (tierId.value !== undefined && !TIER_ID_RE.test(tierId.value))) return 'invalid'

  const parsedName = parseOptionalLicenseName(nameField.value)
  if (!parsedName.ok) return 'invalid'

  const fields: LicenseCreateFields = {}
  if (parsedName.value !== undefined) {
    fields.name = parsedName.value
  }
  if (installBaseUrl.value !== undefined) {
    fields.installBaseUrl = installBaseUrl.value
  }
  if (tierId.value !== undefined) {
    fields.tierId = tierId.value
  }

  return fields
}

export const NO_LICENSE_AVAILABLE_ERROR = 'no_license_available'

/**
 * Refusal message when the tier chosen in Add Server has no free seat for one
 * more server. `heldByKeys` is how many of that tier's licenses unused install
 * commands hold, which deleting one (or letting it expire) gives back.
 */
export function tierSeatExhaustionMessage(label: string, heldByKeys = 0): string {
  if (heldByKeys > 0) {
    const held =
      heldByKeys === 1
        ? `1 is held by an unused install command`
        : `${heldByKeys} are held by unused install commands`
    return `No ${label} license is free for this server — ${held} (delete it on Pending keys, or it expires ${LICENSE_KEY_UNUSED_TTL_DAYS} days after it was made), or restore one that is ending or buy one.`
  }
  return `No ${label} license is free for this server — restore one that is ending or buy one, then continue.`
}

/** One tier's counts in the hosted mint refusal — `summarizeTiers` rows, trimmed. */
export type LicenseTierCounts = {
  tierId: string
  label: string
  purchased: number
  inUse: number
  ending: number
  endsAt: string | null
  available: number
}

type ExhaustedSummary = {
  purchased: number
  releasing: number
  held: number
  inUse: number
  provisioning: number
  unusedKeys: number
  ending: number
  endsAt: string | null
  available: number
}

/**
 * The hosted mint refusal: every purchased license is bound to a server,
 * held by an unused registration key, or ending at the boundary. Carries the
 * counts — per tier too, and `unusedKeys` organization-wide (a key has no
 * tier until its server connects) — and a `message` that never calls an
 * ending license or an unused key "in use", so the console can say "use or
 * delete the key", "restore one" or "buy one" truthfully.
 */
export function noLicenseAvailableBody(
  summary: ExhaustedSummary,
  tiers: readonly LicenseTierCounts[],
  message: string
) {
  // Destructured, not spread: the route's summary also carries `granted`
  // and `bound`, which are not part of this refusal's contract.
  const { purchased, releasing, held, inUse, provisioning, unusedKeys, ending, endsAt, available } =
    summary
  return {
    error: NO_LICENSE_AVAILABLE_ERROR,
    message,
    purchased,
    inUse,
    provisioning,
    unusedKeys,
    ending,
    endsAt,
    available,
    tiers: tiers.map(({ tierId, label, purchased, inUse, ending, endsAt, available }) => ({
      tierId,
      label,
      purchased,
      inUse,
      ending,
      endsAt,
      available,
    })),
    // Deprecated aliases, kept one release for the console: `releasing`
    // (use `ending`) and `held` (use `inUse` + `unusedKeys`).
    releasing,
    held,
  }
}

/** True when the client sent a base URL that failed `parseInstallBaseUrl`. */
export function isInvalidInstallBaseUrl(
  installBaseUrl: string | undefined,
  parsedInstallBaseUrl: string | null
): boolean {
  if (!installBaseUrl?.trim()) return false
  return parsedInstallBaseUrl == null
}

export function isReservedColocatedLicenseName(
  name: string | undefined,
  reservedName: string
): boolean {
  if (name == null) return false
  return normalizeDisplayNameKey(name) === normalizeDisplayNameKey(reservedName)
}

export function reservedColocatedLicenseNameError(reservedName: string): string {
  return `'${reservedName}' is reserved for the co-located control plane`
}

export function installBaseUrlValidationError(): string {
  return 'installBaseUrl must be a valid https URL'
}

export type LicenseListBoundServer = {
  id: string
  name: string | null
}

export type LicenseListStatus = {
  serverId: string
  connected: boolean
}

/** A key whose daemon has started enrolling: its server is being provisioned. */
export type LicenseListProvisioning = {
  /** When the daemon last tried to enrol with this key (ISO). */
  since: string
  hostname: string | null
}

export function serializeLicenseListEntry(params: {
  id: string
  name: string | null
  createdAt: string
  /** The tier chosen in Add Server that this unused key holds; null when none. */
  tier?: { id: string; label: string } | null
  /** When an unused key stops working; null never expires. */
  expiresAt?: string | null
  revocable: boolean
  bound: LicenseListBoundServer | undefined
  status: LicenseListStatus | undefined
  provisioning?: LicenseListProvisioning
}) {
  return {
    id: params.id,
    name: params.name,
    createdAt: params.createdAt,
    // Once a server is bound the key never expires and its tier is the server's.
    tier: params.bound ? null : (params.tier ?? null),
    expiresAt: params.bound ? null : (params.expiresAt ?? null),
    expired: isUnusedKeyExpired({
      serverId: params.bound?.id ?? null,
      expiresAt: params.expiresAt ?? null,
    }),
    revocable: params.revocable,
    // Only for an unbound key: once its server binds, `boundServer` says it all.
    provisioning:
      !params.bound && params.provisioning
        ? { since: params.provisioning.since, hostname: params.provisioning.hostname }
        : null,
    boundServer: params.bound
      ? {
          id: params.bound.id,
          name: params.bound.name,
          connected: params.status?.connected ?? false,
        }
      : null,
  }
}

export function serverCapacityExceededBody(
  capacity: {
    maxServers: number | null
    usedSeats: number
    serverCount: number
    reservedSeatCount: number
  },
  errorCode: string
) {
  return {
    error: errorCode,
    maxServers: capacity.maxServers,
    usedSeats: capacity.usedSeats,
    serverCount: capacity.serverCount,
    reservedSeatCount: capacity.reservedSeatCount,
  }
}
