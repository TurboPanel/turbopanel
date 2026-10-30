import { isInstallCaFingerprint } from './install-ca-pin.ts'
import { formatInstanceDlBase } from './install-tls.ts'

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
function caFingerprintEnvValue(fingerprints: readonly string[] | undefined): string | null {
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
  licenseArg: string
  host?: string
  insecureTls?: boolean
  caFingerprints?: readonly string[]
  curlInsecure?: boolean
  dlBase?: string
  updateChannel?: string
}): string {
  const curl = opts.curlInsecure ? 'curl -fsSLk' : 'curl -fsSL'
  const envParts = [`TURBOPANEL_LICENSE=${opts.licenseArg}`]
  if (opts.host) envParts.push(`TURBOPANEL_HOST=${opts.host}`)
  if (opts.insecureTls) {
    envParts.push('TURBOPANEL_INSECURE_TLS=1')
    const pin = caFingerprintEnvValue(opts.caFingerprints)
    if (pin) envParts.push(`TURBOPANEL_INSTANCE_CA_FINGERPRINT=${pin}`)
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
    licenseArg,
    host,
    updateChannel,
  })
}
