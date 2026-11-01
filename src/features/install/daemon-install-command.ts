import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import { isInstallCaFingerprint } from './install-ca-pin.ts'
import { formatInstanceDlBase } from './install-tls.ts'

const textEncoder = new TextEncoder()

/** The six values a v2 install `TOKEN` carries, in wire order. Any may be empty. */
export type InstallTokenFields = {
  /**
   * The license id, or (join-ticket enrolment) the join ticket id. The next
   * field is the matching secret; the panel tells the two apart by lookup.
   */
  licenseId: string
  licenseToken: string
  /** `https://host[:port]` origins; URL 0 is the admin's chosen install URL. */
  panelUrls: readonly string[]
  panelFingerprint: string
  nextFingerprint: string | null
  /** Comma-joined CA fingerprints, only for a private-certificate panel. */
  caFingerprint: string | null
}

const fieldEncoding = (value: string) => base64urlEncode(textEncoder.encode(value))

/** True for `https://host[:port]` with nothing after the authority. */
export function isInstallTokenOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    )
  } catch {
    return false
  }
}

/**
 * The text before the dot of a v2 `TOKEN`: base64url of `v2:` and the six
 * fields (each base64url too, so `:` and `,` in a URL or secret never clash)
 * joined by `:`. Throws on a URL that is not a bare https origin.
 */
export function encodeInstallTokenPayload(fields: InstallTokenFields): string {
  if (fields.panelUrls.length === 0) {
    throw new TypeError('an install token needs at least one panel URL')
  }
  for (const url of fields.panelUrls) {
    if (!isInstallTokenOrigin(url)) {
      throw new TypeError('install token panel URLs must be https origins without a path')
    }
  }
  const parts = [
    fields.licenseId,
    fields.licenseToken,
    fields.panelUrls.join(','),
    fields.panelFingerprint,
    fields.nextFingerprint ?? '',
    fields.caFingerprint ?? '',
  ].map(fieldEncoding)
  return base64urlEncode(textEncoder.encode(`v2:${parts.join(':')}`))
}

/**
 * The full v2 `TOKEN` value: payload, a dot, and the panel identity key's
 * signature over the payload text. `sign` is `signWithCurrent` bound to the
 * panel identity.
 */
export async function encodeInstallToken(
  fields: InstallTokenFields,
  sign: (bytes: Uint8Array) => Promise<string>
): Promise<string> {
  const payload = encodeInstallTokenPayload(fields)
  return `${payload}.${await sign(textEncoder.encode(payload))}`
}

/** Legacy `TURBOPANEL_LICENSE` value. Kept until the daemon floor moves past the TOKEN installer. */
export function encodeLicenseArg(licenseId: string, licenseToken: string): string {
  const combined = `${licenseId}:${licenseToken}`
  // `=` only appears as base64 padding, so stripping all equals is safe.
  return btoa(combined).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * CDN bootstrap host in production install commands. Always emitted as
 * `https://` (see {@link installScriptUrl}): a bare host makes curl ask over
 * plain HTTP first, and whoever answers that request picks the script that
 * runs as root.
 */
export const CDN_INSTALL_HOST = 'turbopanel.sh'

/**
 * Installer hosts per environment. All three behave like `turbopanel.sh` (a
 * redirect to that branch's `run.sh`); they differ only in which branch: the
 * bare host serves the release, `staging.` the staging branch, `testing.` trunk.
 */
export const STAGING_INSTALL_HOST = 'staging.turbopanel.sh'
export const TESTING_INSTALL_HOST = 'testing.turbopanel.sh'

const INSTALL_HOSTS: ReadonlySet<string> = new Set([
  CDN_INSTALL_HOST,
  STAGING_INSTALL_HOST,
  TESTING_INSTALL_HOST,
])

/**
 * The installer host for an update channel: `rc` (staging) gets `staging.`,
 * the canary rail (`trunk`, `edge`, `canary`; testing) gets `testing.`, and a
 * release, or a channel we do not know, gets the bare host. Same mapping as
 * the daemon's `installerHostForChannel`.
 */
export function installScriptHostForChannel(channel: string | undefined): string {
  switch (channel) {
    case 'rc':
      return STAGING_INSTALL_HOST
    case 'trunk':
    case 'edge':
    case 'canary':
      return TESTING_INSTALL_HOST
    default:
      return CDN_INSTALL_HOST
  }
}

/** The HTTPS URL curl fetches an installer host's script from. */
export function installScriptUrl(host: string): string {
  return `https://${host}`
}

/** HTTPS installer URL for an update channel (see {@link installScriptHostForChannel}). */
export function installScriptUrlForChannel(channel: string | undefined): string {
  return installScriptUrl(installScriptHostForChannel(channel))
}

/** True when `curlUrl` is a public installer host, which always verifies TLS. */
function isInstallerHostUrl(curlUrl: string): boolean {
  try {
    return INSTALL_HOSTS.has(new URL(curlUrl).hostname)
  } catch {
    return false
  }
}

/**
 * Curl target for the installer script: `https://turbopanel.sh` (or its
 * staging/testing host) on the CDN, otherwise the validated origin with
 * `/run.sh` appended (dev overlay only).
 */
export function formatInstallScriptCurlUrl(origin: string): string {
  const trimmed = origin.replace(/\/$/, '')
  // A bare installer host has no scheme — `new URL('turbopanel.sh')` throws
  // and the catch path would otherwise append `/run.sh` (invalid CDN contract).
  if (INSTALL_HOSTS.has(trimmed)) {
    return installScriptUrl(trimmed)
  }
  try {
    const url = new URL(trimmed)
    if (INSTALL_HOSTS.has(url.hostname) && !url.port) {
      return installScriptUrl(url.hostname)
    }
    return `${trimmed}/run.sh`
  } catch {
    // fall through
  }
  return `${trimmed}/run.sh`
}

/**
 * Comma-joined expected CA fingerprints, or null when there are none. Values
 * are emitted unquoted, so anything but 64 lowercase hex digits is refused.
 */
export function caFingerprintEnvValue(fingerprints: readonly string[] | undefined): string | null {
  if (!fingerprints || fingerprints.length === 0) return null
  for (const value of fingerprints) {
    if (!isInstallCaFingerprint(value)) {
      throw new TypeError('install CA fingerprint must be 64 lowercase hex digits')
    }
  }
  return fingerprints.join(',')
}

/**
 * Build the install pipeline. Callers must pass a validated origin / host and a
 * base64url license (no shell metacharacters) — values are emitted unquoted.
 */
function buildInstallPipeline(opts: {
  curlUrl: string
  /** A v2 `TOKEN` value; replaces the license, host and CA variables. */
  token?: string
  licenseArg: string
  host?: string
  insecureTls?: boolean
  caFingerprints?: readonly string[]
  curlInsecure?: boolean
  dlBase?: string
  updateChannel?: string
}): string {
  const curl = opts.curlInsecure ? 'curl -fsSLk' : 'curl -fsSL'
  const envParts = opts.token ? [`TOKEN=${opts.token}`] : [`TURBOPANEL_LICENSE=${opts.licenseArg}`]
  if (opts.host && !opts.token) envParts.push(`TURBOPANEL_HOST=${opts.host}`)
  if (opts.insecureTls && !opts.token) {
    // Never an insecure-TLS command without the CA it may keep: the installer
    // would trust whatever answered.
    const pin = caFingerprintEnvValue(opts.caFingerprints)
    if (!pin) {
      throw new TypeError('an insecure-TLS install command needs at least one CA fingerprint')
    }
    envParts.push('TURBOPANEL_INSECURE_TLS=1', `TURBOPANEL_INSTANCE_CA_FINGERPRINT=${pin}`)
  }
  if (opts.dlBase) {
    // A dev overlay serves unsigned builds. run.sh skips signature checks only
    // when it is told twice (overlay + opt-in), so a stray TURBOPANEL_DL_BASE
    // alone never disables verification.
    envParts.push(`TURBOPANEL_DL_BASE=${opts.dlBase}`, 'TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST=1')
  }
  // The daemon follows the channel this control plane follows. Said for every
  // channel but release, trunk included: the channel also picks the installer
  // host (testing./staging.), and run.sh re-fetches itself from the host its
  // channel names when it re-runs under sudo, so leaving it out would send a
  // testing install back to the release installer. Release is what run.sh
  // assumes when told nothing, so production commands stay short. A dev overlay
  // (dlBase) makes run.sh default to trunk, so it keeps saying release.
  if (opts.updateChannel && (opts.updateChannel !== 'release' || opts.dlBase)) {
    envParts.push(`TURBOPANEL_UPDATE_CHANNEL=${opts.updateChannel}`)
  }
  return `${curl} ${opts.curlUrl} | ${envParts.join(' ')} sh`
}

export function buildLicenseInstallCommand(opts: {
  runtime: 'deno' | 'workers'
  instanceUrl: string
  licenseId: string
  licenseToken: string
  /**
   * Dev/self-signed installs only: curl -k and pass TURBOPANEL_INSECURE_TLS to
   * run.sh. Callers must not set this for production HTTPS origins.
   */
  insecureTls?: boolean
  /**
   * SHA-256 fingerprints of every CA the installer may fetch over that
   * insecure bootstrap (`TURBOPANEL_INSTANCE_CA_FINGERPRINT`). Emitted only
   * with `insecureTls` on the Deno runtime; the installer refuses a fetched
   * CA outside this list.
   */
  caFingerprints?: readonly string[]
  /**
   * Dev overlay only: fetch the installer from the instance host `/run.sh`
   * (served by the dev Caddyfile). Production / self-hosted Deno installs must
   * leave this unset so the command curls `CDN_INSTALL_HOST` and passes
   * `TURBOPANEL_HOST`.
   */
  useInstanceRunScript?: boolean
  /**
   * Local artifact catalog origin (`…/downloads/daemon`). Set on the developer
   * overlay so remote servers never hit the public CDN.
   */
  dlBase?: string
  /** The channel this control plane follows (TURBOPANEL_UPDATE_CHANNEL); enrolled daemons follow it too. */
  updateChannel?: string
  /**
   * A v2 install `TOKEN` (see {@link encodeInstallToken}). When set the command
   * is `TOKEN=<value>` alone: the license, host and CA fingerprints travel
   * inside it, so `licenseId`, `licenseToken`, `caFingerprints` and the host
   * are not emitted as variables.
   */
  token?: string
}): string {
  const {
    runtime,
    instanceUrl,
    licenseId,
    licenseToken,
    insecureTls: insecureTlsOpt = false,
    caFingerprints,
    useInstanceRunScript = false,
    dlBase,
    updateChannel,
    token,
  } = opts
  const insecureTls = insecureTlsOpt
  const licenseArg = encodeLicenseArg(licenseId, licenseToken)
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '') // origin for curl URL + TURBOPANEL_HOST
  const host = includeHost ? instanceUrl : undefined
  const overlayDlBase = useInstanceRunScript ? (dlBase ?? formatInstanceDlBase(scriptBase)) : dlBase

  if (runtime === 'deno') {
    const curlUrl = useInstanceRunScript
      ? formatInstallScriptCurlUrl(scriptBase)
      : installScriptUrlForChannel(updateChannel)
    return buildInstallPipeline({
      curlUrl,
      token,
      licenseArg,
      host,
      insecureTls,
      caFingerprints,
      // Only the instance's own origin (dev overlay `/run.sh`) may need -k.
      // A public installer host always presents a trusted certificate.
      curlInsecure: insecureTls && !isInstallerHostUrl(curlUrl),
      dlBase: overlayDlBase,
      updateChannel,
    })
  }

  return buildInstallPipeline({
    curlUrl: installScriptUrlForChannel(updateChannel),
    token,
    licenseArg,
    host,
    updateChannel,
  })
}
