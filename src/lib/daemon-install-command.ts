const DEFAULT_CDN_INSTALLER_URL =
  'https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh'

export function buildLicenseInstallCommand(opts: {
  runtime: 'deno' | 'workers'
  instanceUrl: string
  licenseId: string
  licenseToken: string
  binaryBaseUrl?: string
  /** @deprecated Deno installs always use run.sh from the instance host. */
  devRunScript?: boolean
  /** Dev/self-signed installs: curl -k and pass --insecure-tls to run.sh. */
  insecureTls?: boolean
}): string {
  const {
    runtime,
    instanceUrl,
    licenseId,
    licenseToken,
    binaryBaseUrl,
    insecureTls = false,
  } = opts
  const licenseArg = `${licenseId}:${licenseToken}`
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '')

  if (runtime === 'deno') {
    const binaryUrl = binaryBaseUrl ?? `${scriptBase}/downloads/daemon`
    const hostFlag = includeHost ? ` --host ${instanceUrl}` : ''
    const tlsFlag = insecureTls ? ' --insecure-tls' : ''
    const curl = insecureTls ? 'curl -fsSLk' : 'curl -fsSL'
    return (
      `${curl} ${scriptBase}/run.sh | ` +
      `sh -s -- --license ${licenseArg}${hostFlag} --binary-url ${binaryUrl}${tlsFlag}`
    )
  }

  const instanceUrlFlag = includeHost ? ` --instance-url ${instanceUrl}` : ''
  return (
    `TURBOPANEL_INSTALL_SCRIPT_URL=${DEFAULT_CDN_INSTALLER_URL} ` +
    `curl -fsSL ${DEFAULT_CDN_INSTALLER_URL} | ` +
    `sh -s -- --license ${licenseArg}${instanceUrlFlag}`
  )
}
