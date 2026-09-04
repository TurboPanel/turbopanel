/**
 * GitHub App authentication (Workers-safe).
 *
 * Two hops, exactly as GitHub specifies:
 *   1. Sign a short-lived **RS256 App JWT** with the App private key.
 *   2. Exchange it for an **installation access token** scoped to one install.
 *
 * Web APIs only — `crypto.subtle`, `fetch`, `TextEncoder`, `atob`/`btoa`. No
 * `@std/*`, no Node `Buffer`, so the module stays reachable from
 * `src/workers.ts` (`pnpm check:workers-bundle`). The base64url helpers are
 * duplicated locally (rather than imported) for the same reason — see
 * `src/daemon/authn/daemon-jwt.ts`, which uses the identical shape for EdDSA.
 *
 * **Installation tokens are never persisted.** They are returned to the caller
 * in memory and discarded; nothing in this module writes them anywhere.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { gitConnection } from '../db/schema.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import { type Forge, loadForgeForConnection } from './forge-records.ts'
import { stripTrailingSlashes } from './origin.ts'

const textEncoder = new TextEncoder()

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_API_ACCEPT = 'application/vnd.github+json'
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_USER_AGENT = 'TurboPanel'

/** GitHub caps App JWT lifetime at 10 minutes; stay under it for clock skew. */
export const GITHUB_APP_JWT_LIFETIME_MS = 9 * 60 * 1000
/** Backdate `iat` so a slightly fast instance clock is still accepted. */
const GITHUB_APP_JWT_BACKDATE_MS = 60 * 1000

export class GithubAppTokenError extends Error {
  /** HTTP status from GitHub, when the failure came from the API. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GithubAppTokenError'
    this.status = status
  }
}

/**
 * A token plus the origin it is valid against.
 *
 * The pair travels together because an installation token minted on one GitHub
 * origin means nothing on another, and every API helper needs both.
 */
export type GithubApiAuth = {
  token: string
  /**
   * `api.github.com` for a github.com App, or the App's own API origin when it
   * lives on a GitHub Enterprise Server.
   */
  apiBase: string
}

export type GithubInstallationToken = GithubApiAuth & {
  /** ISO-8601 expiry as reported by GitHub. */
  expiresAt: string
}

/**
 * API origin for one registered App.
 *
 * Explicit `apiUrl` wins. Otherwise github.com gets the documented
 * `api.github.com`, and a GitHub Enterprise Server gets its documented
 * `<host>/api/v3` form.
 */
export function githubApiBaseFor(app: Pick<Forge, 'apiUrl' | 'baseUrl'>): string {
  if (app.apiUrl) return stripTrailingSlashes(app.apiUrl)
  const baseUrl = stripTrailingSlashes(app.baseUrl)
  if (baseUrl === 'https://github.com') return GITHUB_API_BASE
  return `${baseUrl}/api/v3`
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64Decode(input: string): Uint8Array {
  const binary = atob(input)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0
  }
  return bytes
}

/** DER length prefix (short form under 128, else long form). */
function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}

/** `SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING … }`. */
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]

/**
 * Wrap a PKCS#1 `RSAPrivateKey` body in a PKCS#8 `PrivateKeyInfo`.
 *
 * GitHub hands out App private keys in the PKCS#1 form
 * (`-----BEGIN RSA PRIVATE KEY-----`), which `crypto.subtle.importKey` cannot
 * read — it only accepts `pkcs8`. The wrapper is a fixed, deterministic ASN.1
 * prefix, so no crypto library is needed.
 */
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octetString = [0x04, ...derLength(pkcs1.length)]
  const bodyLength =
    3 + RSA_ALGORITHM_IDENTIFIER.length + octetString.length + pkcs1.length
  const header = [
    0x30,
    ...derLength(bodyLength),
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM_IDENTIFIER,
    ...octetString,
  ]
  const out = new Uint8Array(header.length + pkcs1.length)
  out.set(header, 0)
  out.set(pkcs1, header.length)
  return out
}

const PEM_BLOCK_RE = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/

/** PEM → PKCS#8 DER bytes. Accepts both PKCS#8 and GitHub's PKCS#1 form. */
export function privateKeyPemToPkcs8Der(pem: string): Uint8Array {
  const match = PEM_BLOCK_RE.exec(pem.trim())
  if (!match) {
    throw new GithubAppTokenError('github app private key is not a PEM block')
  }
  const label = match[1]!.trim()
  const body = match[2]!.replace(/\s+/g, '')
  if (body.length === 0) {
    throw new GithubAppTokenError('github app private key PEM body is empty')
  }

  let der: Uint8Array
  try {
    der = base64Decode(body)
  } catch {
    throw new GithubAppTokenError('github app private key PEM is not valid base64')
  }

  if (label === 'PRIVATE KEY') return der
  if (label === 'RSA PRIVATE KEY') return wrapPkcs1AsPkcs8(der)
  throw new GithubAppTokenError(
    `unsupported github app private key PEM label "${label}"`,
  )
}

async function importAppSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  const der = privateKeyPemToPkcs8Der(privateKeyPem)
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } catch {
    throw new GithubAppTokenError('github app private key could not be imported')
  }
}

/**
 * Sign the App-level JWT GitHub expects on `/app/*` endpoints
 * (`{ iat, exp, iss }`, RS256).
 */
export async function signGithubAppJwt(
  forgeId: string,
  privateKeyPem: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const trimmedAppId = forgeId.trim()
  if (trimmedAppId.length === 0) {
    throw new GithubAppTokenError('github app id is not configured')
  }

  const iat = Math.floor((nowMs - GITHUB_APP_JWT_BACKDATE_MS) / 1000)
  const exp = Math.floor((nowMs + GITHUB_APP_JWT_LIFETIME_MS) / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat, exp, iss: trimmedAppId }

  const encodedHeader = base64urlEncode(textEncoder.encode(JSON.stringify(header)))
  const encodedPayload = base64urlEncode(textEncoder.encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const key = await importAppSigningKey(privateKeyPem)
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    textEncoder.encode(signingInput),
  )

  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`
}

/** Standard headers for every GitHub REST call made from the instance. */
export function githubApiHeaders(token: string, scheme: 'Bearer' | 'token'): HeadersInit {
  const headers: Record<string, string> = {
    accept: GITHUB_API_ACCEPT,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': GITHUB_USER_AGENT,
  }
  // An empty token is anonymous public REST — GitHub rejects `Authorization`
  // with a blank credential, so omit the header entirely.
  if (token.length > 0) headers.authorization = `${scheme} ${token}`
  return headers
}

async function readGithubError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `github request failed (${response.status})`
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return `github request failed (${response.status}): ${parsed.message}`
    }
  } catch {
    // Non-JSON error body — fall through to the status-only message.
  }
  return `github request failed (${response.status})`
}

/**
 * Exchange an App JWT for an installation access token.
 *
 * Deliberately a bare `fetch` with explicit error mapping: the codebase has no
 * generic third-party HTTP client, and inventing one here would be a larger
 * change than this call needs.
 */
export async function exchangeInstallationTokenAt(
  apiBase: string,
  appJwt: string,
  externalInstallationId: string,
): Promise<GithubInstallationToken> {
  const id = encodeURIComponent(externalInstallationId)
  let response: Response
  try {
    response = await fetch(`${apiBase}/app/installations/${id}/access_tokens`, {
      method: 'POST',
      headers: githubApiHeaders(appJwt, 'Bearer'),
    })
  } catch (error) {
    throw new GithubAppTokenError(
      `github token exchange failed: ${error instanceof Error ? error.message : 'network error'}`,
    )
  }

  if (!response.ok) {
    throw new GithubAppTokenError(await readGithubError(response), response.status)
  }

  const payload = (await response.json().catch(() => null)) as
    | { token?: unknown; expires_at?: unknown }
    | null
  if (!payload || typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new GithubAppTokenError('github token exchange returned no token')
  }

  return {
    token: payload.token,
    expiresAt:
      typeof payload.expires_at === 'string'
        ? payload.expires_at
        : new Date(Date.now() + GITHUB_APP_JWT_LIFETIME_MS).toISOString(),
    apiBase,
  }
}

/**
 * Load the installation row **and the App it was granted through**, sign that
 * App's JWT, and exchange it for an installation token.
 *
 * The app is resolved from `installation.app_id` rather than from a single
 * instance-wide config, which is what allows several Apps to coexist: two
 * installations can name the same external id and still mint against different
 * private keys, on different origins.
 *
 * The token is returned to the caller only — this function never writes it.
 */
export async function mintGithubInstallationToken(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  connectionId: string,
): Promise<GithubInstallationToken> {
  const [row] = await db
    .select({
      provider: gitConnection.provider,
      externalInstallationId: gitConnection.externalInstallationId,
      suspendedAt: gitConnection.suspendedAt,
    })
    .from(gitConnection)
    .where(eq(gitConnection.id, connectionId))
    .limit(1)

  if (!row) {
    throw new GithubAppTokenError('installation not found', 404)
  }
  if (row.provider !== 'github') {
    throw new GithubAppTokenError(`unsupported installation provider "${row.provider}"`)
  }
  if (row.suspendedAt) {
    throw new GithubAppTokenError('installation is suspended', 409)
  }

  const app = await loadForgeForConnection(db, dataEncryptionSecrets, connectionId)
  if (app?.provider !== 'github') {
    throw new GithubAppTokenError('github app is not configured')
  }
  if (!app.privateKeyPem) {
    throw new GithubAppTokenError('github app has no private key configured')
  }

  const appJwt = await signGithubAppJwt(app.externalAppId, app.privateKeyPem)
  return await exchangeInstallationTokenAt(
    githubApiBaseFor(app),
    appJwt,
    row.externalInstallationId,
  )
}
