export type ServerDaemonKey = {
  id: string
  algorithm: "Ed25519"
  publicJwk: JsonWebKey
  fingerprint: string
  createdAt: string
  revokedAt?: string | null
}

export type ServerDaemonState = {
  key: ServerDaemonKey
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isOptionalTimestamp(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isNonEmptyString(value)
}

function isPublicJwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const jwk = value as JsonWebKey
  return isNonEmptyString(jwk.kty) && isNonEmptyString(jwk.crv) && isNonEmptyString(jwk.x)
}

function parseServerDaemonKey(raw: unknown): ServerDaemonKey | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null
  }
  const key = raw as Record<string, unknown>
  if (
    !isNonEmptyString(key.id) ||
    key.algorithm !== "Ed25519" ||
    !isPublicJwk(key.publicJwk) ||
    !isNonEmptyString(key.fingerprint) ||
    !isNonEmptyString(key.createdAt) ||
    !isOptionalTimestamp(key.revokedAt)
  ) {
    return null
  }
  return {
    id: key.id,
    algorithm: "Ed25519",
    publicJwk: key.publicJwk,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt ?? null,
  }
}

export function parseServerDaemonState(raw: unknown): ServerDaemonState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null
  }
  const state = raw as Record<string, unknown>
  const parsedKey = parseServerDaemonKey(state.key)
  if (!parsedKey) {
    return null
  }
  return {
    key: parsedKey,
  }
}

export function isDaemonKeyActive(key: ServerDaemonKey): boolean {
  return key.revokedAt === null || key.revokedAt === undefined
}

export function buildServerDaemonState(params: {
  publicJwk: JsonWebKey
  fingerprint: string
  algorithm?: "Ed25519"
}): ServerDaemonState {
  const now = new Date().toISOString()
  return {
    key: {
      id: crypto.randomUUID(),
      algorithm: params.algorithm ?? "Ed25519",
      publicJwk: params.publicJwk,
      fingerprint: params.fingerprint,
      createdAt: now,
      revokedAt: null,
    },
  }
}
