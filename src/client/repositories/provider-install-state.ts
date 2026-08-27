/**
 * CSRF-safe `state` for a Git provider's connect redirect.
 *
 * Both flows leave the instance and come back on a URL the provider controls:
 * GitHub's App installation redirect and GitLab's OAuth authorize redirect. In
 * both, `state` is the only thing tying the callback to the organization that
 * started it — so it must be signed, not trusted. Keys come from the same HKDF
 * root as sessions (`deriveSecretsConfig(config, purpose)` in
 * `../authn/secrets.ts`), and the wire format uses the shared envelope grammar
 * (`tpinstall.v<version>.<payloadB64u>.<sigB64u>`).
 *
 * One module, two providers: the envelope scheme is identical and only the HKDF
 * **purpose** differs, so a state minted for one provider's flow cannot be
 * replayed into the other's callback — the derived key simply does not verify.
 * That separation is the reason the purpose is a parameter rather than a
 * constant, and the reason this file replaced the GitHub-only `install-state.ts`
 * instead of being copied alongside it.
 */

import {
  ENVELOPE_SCHEME_INSTALL_STATE,
  formatEnvelope,
  parseEnvelope,
} from '../authn/envelope.ts'
import {
  deriveSecretsConfig,
  findKeyForVersion,
  type SecretsConfig,
} from '../authn/secrets.ts'

/** Per-provider HKDF purpose — distinct so states are not interchangeable. */
export const INSTALL_STATE_PURPOSES = {
  github: 'github-app-install-state',
  gitlab: 'gitlab-oauth-connect-state',
} as const

/**
 * The manifest flow's own purpose.
 *
 * Separate from the install purposes above for the same reason those are
 * separate from each other: a state minted to *create* an App carries different
 * claims than one minted to *install* an existing App, and a key that does not
 * verify is a stronger guarantee than a runtime shape check.
 */
export const GITHUB_MANIFEST_STATE_PURPOSE = 'github-app-manifest-state'

export type InstallStateProvider = keyof typeof INSTALL_STATE_PURPOSES

/** Short window: the operator is mid-redirect, not sitting on the link. */
export const INSTALL_STATE_TTL_MS = 10 * 60 * 1000

/** Back-compat alias for the GitHub-only constants this module replaced. */
export const GITHUB_INSTALL_STATE_PURPOSE = INSTALL_STATE_PURPOSES.github
export const GITHUB_INSTALL_STATE_TTL_MS = INSTALL_STATE_TTL_MS

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

type InstallStatePayload = {
  organizationId: string
  /**
   * The registered app the flow was started against.
   *
   * Carried in the signed state rather than re-derived on the callback because
   * the provider's redirect does not echo it back, and an instance may now hold
   * several apps for the same provider — without it the callback would have to
   * guess which one the resulting installation belongs to.
   */
  appId: string
  exp: number
}

/** What a verified state proves. */
export type InstallStateClaims = {
  organizationId: string
  appId: string
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  const base64 = padded.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0
  }
  return bytes
}

/**
 * What a verified manifest state proves.
 *
 * The App does not exist yet, so there is no row id to carry — instead the
 * state holds everything the callback needs to create one, including the
 * `webhookRef` that was already written into the manifest's
 * `hook_attributes.url`. Signing it is what keeps a caller from redirecting the
 * conversion of someone else's App into their own organization.
 */
export type GithubManifestStateClaims = {
  /** `null` for the instance-wide (admin) flow. */
  organizationId: string | null
  webhookRef: string
  baseUrl: string
  name: string
  /**
   * Everything else the wizard collected.
   *
   * It rides in the signed state because the row does not exist yet and GitHub
   * does not hand any of it back: the conversion response carries credentials
   * and nothing about how the operator configured the app. Signed rather than
   * echoed through a query param so a tampered return cannot, say, flip an
   * organization-owned app to instance-wide.
   */
  webhookOrigin?: string | null
  apiUrl?: string | null
  isPublic?: boolean
  pullRequestAccess?: 'read' | 'write'
  customGitUser?: string | null
  customGitPort?: number | null
}

type ManifestStatePayload = GithubManifestStateClaims & { exp: number }

export async function signGithubManifestState(
  secretsConfig: SecretsConfig,
  claims: GithubManifestStateClaims,
  nowMs: number = Date.now(),
): Promise<string> {
  const derived = await deriveSecretsConfig(
    secretsConfig,
    GITHUB_MANIFEST_STATE_PURPOSE,
  )
  const payload: ManifestStatePayload = {
    ...claims,
    exp: Math.floor((nowMs + INSTALL_STATE_TTL_MS) / 1000),
  }
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    derived.current.key,
    textEncoder.encode(encodedPayload),
  )
  return formatEnvelope(
    ENVELOPE_SCHEME_INSTALL_STATE,
    derived.current.version,
    encodedPayload,
    base64urlEncode(new Uint8Array(signature)),
  )
}

export async function verifyGithubManifestState(
  secretsConfig: SecretsConfig,
  state: string,
  nowMs: number = Date.now(),
): Promise<GithubManifestStateClaims | null> {
  const parsed = parseEnvelope(ENVELOPE_SCHEME_INSTALL_STATE, state, 2)
  if (!parsed) return null

  const derived = await deriveSecretsConfig(
    secretsConfig,
    GITHUB_MANIFEST_STATE_PURPOSE,
  )
  const key = findKeyForVersion(derived, parsed.version)
  if (!key) return null

  const [encodedPayload, encodedSignature] = parsed.fields
  let signature: Uint8Array
  let payload: ManifestStatePayload
  try {
    signature = base64urlDecode(encodedSignature!)
    payload = JSON.parse(
      textDecoder.decode(base64urlDecode(encodedPayload!)),
    ) as ManifestStatePayload
  } catch {
    return null
  }

  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    textEncoder.encode(encodedPayload!),
  )
  if (!verified) return null

  if (payload.organizationId !== null && typeof payload.organizationId !== 'string') {
    return null
  }
  for (const field of ['webhookRef', 'baseUrl', 'name'] as const) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) return null
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null

  return {
    organizationId: payload.organizationId,
    webhookRef: payload.webhookRef,
    baseUrl: payload.baseUrl,
    name: payload.name,
    webhookOrigin: payload.webhookOrigin ?? null,
    apiUrl: payload.apiUrl ?? null,
    isPublic: payload.isPublic === true,
    pullRequestAccess: payload.pullRequestAccess === 'write' ? 'write' : 'read',
    customGitUser: payload.customGitUser ?? null,
    customGitPort: typeof payload.customGitPort === 'number'
      ? payload.customGitPort
      : null,
  }
}

export async function signProviderInstallState(
  secretsConfig: SecretsConfig,
  provider: InstallStateProvider,
  claims: InstallStateClaims,
  nowMs: number = Date.now(),
): Promise<string> {
  const derived = await deriveSecretsConfig(
    secretsConfig,
    INSTALL_STATE_PURPOSES[provider],
  )
  const payload: InstallStatePayload = {
    organizationId: claims.organizationId,
    appId: claims.appId,
    exp: Math.floor((nowMs + INSTALL_STATE_TTL_MS) / 1000),
  }
  const encodedPayload = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    derived.current.key,
    textEncoder.encode(encodedPayload),
  )
  return formatEnvelope(
    ENVELOPE_SCHEME_INSTALL_STATE,
    derived.current.version,
    encodedPayload,
    base64urlEncode(new Uint8Array(signature)),
  )
}

/**
 * Verify the signature and expiry. Returns the claims, or `null` for any
 * malformed / unsigned / expired state — never a partially trusted value.
 */
export async function verifyProviderInstallState(
  secretsConfig: SecretsConfig,
  provider: InstallStateProvider,
  state: string,
  nowMs: number = Date.now(),
): Promise<InstallStateClaims | null> {
  const parsed = parseEnvelope(ENVELOPE_SCHEME_INSTALL_STATE, state, 2)
  if (!parsed) return null

  const derived = await deriveSecretsConfig(
    secretsConfig,
    INSTALL_STATE_PURPOSES[provider],
  )
  const key = findKeyForVersion(derived, parsed.version)
  if (!key) return null

  const [encodedPayload, encodedSignature] = parsed.fields
  let signature: Uint8Array
  let payload: InstallStatePayload
  try {
    signature = base64urlDecode(encodedSignature!)
    payload = JSON.parse(
      textDecoder.decode(base64urlDecode(encodedPayload!)),
    ) as InstallStatePayload
  } catch {
    return null
  }

  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    textEncoder.encode(encodedPayload!),
  )
  if (!verified) return null

  if (typeof payload.organizationId !== 'string' || !payload.organizationId) {
    return null
  }
  if (typeof payload.appId !== 'string' || !payload.appId) return null
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) {
    return null
  }

  return { organizationId: payload.organizationId, appId: payload.appId }
}

/** GitHub App installation redirect state. */
export function signGithubInstallState(
  secretsConfig: SecretsConfig,
  claims: InstallStateClaims,
  nowMs: number = Date.now(),
): Promise<string> {
  return signProviderInstallState(secretsConfig, 'github', claims, nowMs)
}

export function verifyGithubInstallState(
  secretsConfig: SecretsConfig,
  state: string,
  nowMs: number = Date.now(),
): Promise<InstallStateClaims | null> {
  return verifyProviderInstallState(secretsConfig, 'github', state, nowMs)
}

/** GitLab OAuth authorize redirect state. */
export function signGitlabConnectState(
  secretsConfig: SecretsConfig,
  claims: InstallStateClaims,
  nowMs: number = Date.now(),
): Promise<string> {
  return signProviderInstallState(secretsConfig, 'gitlab', claims, nowMs)
}

export function verifyGitlabConnectState(
  secretsConfig: SecretsConfig,
  state: string,
  nowMs: number = Date.now(),
): Promise<InstallStateClaims | null> {
  return verifyProviderInstallState(secretsConfig, 'gitlab', state, nowMs)
}
