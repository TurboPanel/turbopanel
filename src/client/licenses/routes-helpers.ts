import {
  isValidDisplayName,
  normalizeDisplayName,
  normalizeDisplayNameKey,
} from '../../lib/display-name-format.ts'

export type LicenseCreateFields = {
  name?: string
  installBaseUrl?: string
}

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

  const parsedName = parseOptionalLicenseName(nameField.value)
  if (!parsedName.ok) return 'invalid'

  const fields: LicenseCreateFields = {}
  if (parsedName.value !== undefined) {
    fields.name = parsedName.value
  }
  if (installBaseUrl.value !== undefined) {
    fields.installBaseUrl = installBaseUrl.value
  }

  return fields
}

export const NO_LICENSE_AVAILABLE_ERROR = 'no_license_available'

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
  ending: number
  endsAt: string | null
  available: number
}

/**
 * The hosted mint refusal: every purchased license is held (bound or
 * waiting to connect) or ending at the boundary. Carries the counts — per
 * tier too — and a `message` that never calls an ending license "in use",
 * so the console can say "restore one" or "buy one" truthfully.
 */
export function noLicenseAvailableBody(
  summary: ExhaustedSummary,
  tiers: readonly LicenseTierCounts[] = [],
  message: string
) {
  // Destructured, not spread: the route's summary also carries `bound` and
  // `granted`, which are not part of this refusal's contract.
  const { purchased, releasing, held, ending, endsAt, available } = summary
  return {
    error: NO_LICENSE_AVAILABLE_ERROR,
    message,
    purchased,
    inUse: held,
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
    // (use `ending`) and `held` (use `inUse`).
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

export function serializeLicenseListEntry(params: {
  id: string
  name: string | null
  createdAt: string
  revocable: boolean
  bound: LicenseListBoundServer | undefined
  status: LicenseListStatus | undefined
}) {
  return {
    id: params.id,
    name: params.name,
    createdAt: params.createdAt,
    revocable: params.revocable,
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
