/** POSIX single-quote escaping for shell arguments and env values. */
export function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`)
  return `'${escaped}'`
}

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

/** CDN bootstrap URL shown in production install commands (HTTP→HTTPS via CF 301). */
export const CDN_RUN_SCRIPT_DISPLAY = 'trbp.nl/run.sh'

function buildInstallPipeline(opts: {
  curlUrl: string
  licenseArg: string
  host?: string
  insecureTls?: boolean
  curlInsecure?: boolean
}): string {
  const curl = opts.curlInsecure ? 'curl -fsSLk' : 'curl -fsSL'
  const envParts = [`TURBOPANEL_LICENSE=${shellQuote(opts.licenseArg)}`]
  if (opts.host) envParts.push(`TURBOPANEL_HOST=${shellQuote(opts.host)}`)
  if (opts.insecureTls) envParts.push('TURBOPANEL_INSECURE_TLS=1')
  return `${curl} ${shellQuote(opts.curlUrl)} | ${envParts.join(' ')} sh`
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
      curlUrl: `${scriptBase}/run.sh`,
      licenseArg,
      host,
      insecureTls,
      curlInsecure: insecureTls,
    })
  }

  return buildInstallPipeline({
    curlUrl: CDN_RUN_SCRIPT_DISPLAY,
    licenseArg,
    host,
  })
}
