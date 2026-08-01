export function encodeLicenseArg(
  licenseId: string,
  licenseToken: string,
): string {
  const combined = `${licenseId}:${licenseToken}`
  // `=` only appears as base64 padding, so stripping all equals is safe.
  return btoa(combined)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

/** CDN bootstrap host shown in production install commands (HTTP→HTTPS via CF). */
export const CDN_INSTALL_HOST = 'turbopanel.sh'

/**
 * Bare host[:port] or scheme+host for curl; never includes an install script path.
 */
export function formatInstallScriptCurlUrl(origin: string): string {
  const trimmed = origin.replace(/\/$/, '')
  try {
    const url = new URL(trimmed)
    if (url.hostname === CDN_INSTALL_HOST && !url.port) {
      return CDN_INSTALL_HOST
    }
    if (url.protocol === 'https:') {
      if (!url.port || url.port === '443') {
        return url.hostname
      }
      return `https://${url.host}`
    }
    if (url.protocol === 'http:') {
      if (!url.port || url.port === '80') {
        return url.hostname
      }
      return url.host
    }
  } catch {
    // fall through
  }
  return trimmed
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
  curlInsecure?: boolean
}): string {
  const curl = opts.curlInsecure ? 'curl -fsSLk' : 'curl -fsSL'
  const envParts = [`TURBOPANEL_LICENSE=${opts.licenseArg}`]
  if (opts.host) envParts.push(`TURBOPANEL_HOST=${opts.host}`)
  if (opts.insecureTls) envParts.push('TURBOPANEL_INSECURE_TLS=1')
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
}): string {
  const {
    runtime,
    instanceUrl,
    licenseId,
    licenseToken,
    insecureTls: insecureTlsOpt = false,
  } = opts
  const insecureTls =
    instanceUrl.startsWith('http://') ? false : insecureTlsOpt
  const licenseArg = encodeLicenseArg(licenseId, licenseToken)
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '')
  const host = includeHost ? instanceUrl : undefined

  if (runtime === 'deno') {
    return buildInstallPipeline({
      curlUrl: formatInstallScriptCurlUrl(scriptBase),
      licenseArg,
      host,
      insecureTls,
      curlInsecure: insecureTls,
    })
  }

  return buildInstallPipeline({
    curlUrl: CDN_INSTALL_HOST,
    licenseArg,
    host,
  })
}
