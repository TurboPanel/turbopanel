export type LicenseCreateFields = {
  displayName?: string
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

  if (record.displayName !== undefined) {
    if (typeof record.displayName !== 'string') {
      return 'invalid'
    }
    fields.displayName = record.displayName
  }
  if (record.installBaseUrl !== undefined) {
    if (typeof record.installBaseUrl !== 'string') {
      return 'invalid'
    }
    fields.installBaseUrl = record.installBaseUrl
  }

  return fields
}
