export type LicenseCreateFields = {
  name?: string
  installBaseUrl?: string
}

export function parseLicenseCreateFields(
  rawBody: string,
): LicenseCreateFields | 'invalid' {
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
  const fields: LicenseCreateFields = {}

  if (record.name !== undefined) {
    if (typeof record.name !== 'string') {
      return 'invalid'
    }
    fields.name = record.name
  }
  if (record.installBaseUrl !== undefined) {
    if (typeof record.installBaseUrl !== 'string') {
      return 'invalid'
    }
    fields.installBaseUrl = record.installBaseUrl
  }

  return fields
}

export function isReservedColocatedLicenseName(
  name: string | undefined,
  reservedName: string,
): boolean {
  return name?.trim() === reservedName
}

export function reservedColocatedLicenseNameError(reservedName: string): string {
  return `'${reservedName}' is reserved for the co-located control plane`
}

export function installBaseUrlValidationError(devSurface: boolean): string {
  if (devSurface) {
    return 'installBaseUrl must be a valid http(s) URL'
  }
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

export function serverCapacityExceededBody(capacity: {
  maxServers: number | null
  usedSeats: number
  serverCount: number
  reservedSeatCount: number
}, errorCode: string) {
  return {
    error: errorCode,
    maxServers: capacity.maxServers,
    usedSeats: capacity.usedSeats,
    serverCount: capacity.serverCount,
    reservedSeatCount: capacity.reservedSeatCount,
  }
}
