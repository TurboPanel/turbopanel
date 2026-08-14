import { formatInstanceDlBase } from './install-tls.ts'

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
 * Curl target for the installer script: bare `turbopanel.sh` on the CDN, otherwise
 * the validated origin with `/run.sh` appended (dev overlay only).
 */
export function formatInstallScriptCurlUrl(origin: string): string {
  const trimmed = origin.replace(/\/$/, '')
  // Bare CDN host must stay bare — `new URL('turbopanel.sh')` throws and the
  // catch path would otherwise append `/run.sh` (invalid CDN contract).
  if (trimmed === CDN_INSTALL_HOST) {
    return CDN_INSTALL_HOST
  }
  try {
    const url = new URL(trimmed)
    if (url.hostname === CDN_INSTALL_HOST && !url.port) {
      return CDN_INSTALL_HOST
    }
    return `${trimmed}/run.sh`
  } catch {
    // fall through
  }
  return `${trimmed}/run.sh`
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
  dlBase?: string
}): string {
  const curl = opts.curlInsecure ? 'curl -fsSLk' : 'curl -fsSL'
  const envParts = [`TURBOPANEL_LICENSE=${opts.licenseArg}`]
  if (opts.host) envParts.push(`TURBOPANEL_HOST=${opts.host}`)
  if (opts.insecureTls) envParts.push('TURBOPANEL_INSECURE_TLS=1')
  if (opts.dlBase) envParts.push(`TURBOPANEL_DL_BASE=${opts.dlBase}`)
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
}): string {
  const {
    runtime,
    instanceUrl,
    licenseId,
    licenseToken,
    insecureTls: insecureTlsOpt = false,
    useInstanceRunScript = false,
    dlBase,
  } = opts
  const insecureTls =
    instanceUrl.startsWith('http://') ? false : insecureTlsOpt
  const licenseArg = encodeLicenseArg(licenseId, licenseToken)
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '') // origin for curl URL + TURBOPANEL_HOST
  const host = includeHost ? instanceUrl : undefined
  const overlayDlBase = useInstanceRunScript
    ? (dlBase ?? formatInstanceDlBase(scriptBase))
    : dlBase

  if (runtime === 'deno') {
    const curlUrl = useInstanceRunScript
      ? formatInstallScriptCurlUrl(scriptBase)
      : CDN_INSTALL_HOST
    return buildInstallPipeline({
      curlUrl,
      licenseArg,
      host,
      insecureTls,
      curlInsecure: insecureTls,
      dlBase: overlayDlBase,
    })
  }

  return buildInstallPipeline({
    curlUrl: CDN_INSTALL_HOST,
    licenseArg,
    host,
  })
}
