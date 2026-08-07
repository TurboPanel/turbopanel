import {
  TLS_SOURCES,
  type TlsMetadata,
  type TlsOptions,
  type TlsSource,
} from '../../lib/tls/index.ts'

export type CreateTlsMaterial = {
  certificatePem: string | null
  privateKeyPemSealed: string | null
  metadata: TlsMetadata
  options: TlsOptions | null
}

export type CreateTlsFailure = {
  error: string
  detail?: string
  status: 400
}

export type CreateTlsResult = CreateTlsMaterial | CreateTlsFailure

export function parseSource(value: unknown): TlsSource | null {
  if (typeof value !== 'string') return null
  return (TLS_SOURCES as readonly string[]).includes(value)
    ? (value as TlsSource)
    : null
}

export function parseHostnames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const names = value
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  return names.length > 0 ? names : null
}

export function isCreateTlsFailure(result: CreateTlsResult): result is CreateTlsFailure {
  return 'status' in result
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

export function isTlsFingerprintUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_tls_organization_fingerprint_sha256')
}

export function createFailure(error: string, detail?: string): CreateTlsFailure {
  if (detail === undefined) {
    return { error, status: 400 }
  }
  return { error, detail, status: 400 }
}

export function materialFromLetsEncrypt(body: Record<string, unknown>): CreateTlsResult {
  const hostnames = parseHostnames(body.hostnames)
  if (!hostnames) {
    return createFailure('Invalid request')
  }
  return {
    certificatePem: null,
    privateKeyPemSealed: null,
    metadata: {
      dnsNames: hostnames,
      hasWildcard: hostnames.some((n) => n.startsWith('*.')),
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      fingerprintSha256: '',
      subject: '',
      issuer: '',
      status: 'pending',
      acme: {
        challengeType:
          body.challengeType === 'dns-01' ? 'dns-01' : 'http-01',
      },
    },
    options: {
      autoRenew: body.autoRenew !== false,
      requestedHostnames: hostnames,
    },
  }
}

export function withPreferOption(
  options: TlsOptions | null,
  prefer: unknown,
): TlsOptions | null {
  if (typeof prefer !== 'number' || !Number.isFinite(prefer)) {
    return options
  }
  if (options) {
    return { ...options, prefer }
  }
  return { prefer }
}

export type OptionsPatchResult =
  | { ok: true; options: TlsOptions; changed: boolean }
  | { ok: false }

export function applyTlsOptionsPatch(
  currentOptions: TlsOptions,
  body: Record<string, unknown>,
): OptionsPatchResult {
  const nextOptions: TlsOptions = { ...currentOptions }
  let changed = false

  if (body.prefer !== undefined) {
    if (body.prefer === null) {
      delete nextOptions.prefer
      changed = true
    } else if (typeof body.prefer === 'number' && Number.isFinite(body.prefer)) {
      nextOptions.prefer = body.prefer
      changed = true
    } else {
      return { ok: false }
    }
  }

  if (body.autoRenew !== undefined) {
    if (typeof body.autoRenew !== 'boolean') {
      return { ok: false }
    }
    nextOptions.autoRenew = body.autoRenew
    changed = true
  }

  return { ok: true, options: nextOptions, changed }
}
