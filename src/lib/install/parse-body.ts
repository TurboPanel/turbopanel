import {
  MAX_AUTH_EMAIL_CHARS,
  MAX_AUTH_PASSWORD_CHARS,
  MAX_AUTH_USERNAME_CHARS,
} from '../../client/authn/auth-body-limits.ts'

export type InstallHostCredentials = {
  username: string
  password: string
}

export type CompleteInstallBody = InstallHostCredentials & {
  superadminEmail: string
  superadminPassword: string
}

type ParseFail = { ok: false; error: 'Invalid request' }
type ParseOk<T> = { ok: true; value: T }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the install bootstrap host-credentials JSON body (no I/O).
 */
export function parseInstallHostCredentialsBody(
  body: unknown,
): ParseOk<InstallHostCredentials> | ParseFail {
  if (!isRecord(body)) {
    return { ok: false, error: 'Invalid request' }
  }

  const { username, password } = body
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > MAX_AUTH_USERNAME_CHARS ||
    typeof password !== 'string' ||
    !password ||
    password.length > MAX_AUTH_PASSWORD_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }

  return { ok: true, value: { username, password } }
}

/**
 * Validate the install complete JSON body (host + superadmin fields; no I/O).
 */
export function parseCompleteInstallBodyRaw(
  body: unknown,
): ParseOk<CompleteInstallBody> | ParseFail {
  if (!isRecord(body)) {
    return { ok: false, error: 'Invalid request' }
  }

  const { username, password, superadminEmail, superadminPassword } = body
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > MAX_AUTH_USERNAME_CHARS ||
    typeof password !== 'string' ||
    !password ||
    password.length > MAX_AUTH_PASSWORD_CHARS ||
    typeof superadminEmail !== 'string' ||
    superadminEmail.length > MAX_AUTH_EMAIL_CHARS ||
    typeof superadminPassword !== 'string' ||
    superadminPassword.length > MAX_AUTH_PASSWORD_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }

  return {
    ok: true,
    value: { username, password, superadminEmail, superadminPassword },
  }
}
