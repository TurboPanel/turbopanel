const DEFAULT_CDN_INSTALLER_URL =
  'https://raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh'

export function buildLicenseInstallCommand(opts: {
  runtime: 'deno' | 'workers'
  instanceUrl: string
  licenseId: string
  licenseToken: string
  binaryBaseUrl?: string
  /** Co-located dev: curl run.sh from Caddy (same host as /downloads/daemon). */
  devRunScript?: boolean
}): string {
  const {
    runtime,
    instanceUrl,
    licenseId,
    licenseToken,
    binaryBaseUrl,
    devRunScript,
  } = opts
  const licenseArg = `${licenseId}:${licenseToken}`
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '')

  if (runtime === 'deno' && devRunScript) {
    const binaryUrl = binaryBaseUrl ?? `${scriptBase}/downloads/daemon`
    const hostFlag = includeHost ? ` --host ${instanceUrl}` : ''
    return (
      `curl -fsSL ${scriptBase}/run.sh | ` +
      `sh -s -- --license ${licenseArg}${hostFlag} --binary-url ${binaryUrl}`
    )
  }

  if (runtime === 'deno') {
    const binaryUrl = binaryBaseUrl ?? `${instanceUrl}/downloads/daemon`
    const hostFlag = includeHost ? ` --host ${instanceUrl}` : ''
    return (
      `curl -fsSL ${instanceUrl}/api/install/v1/daemon-install.sh | ` +
      `sh -s -- --license ${licenseArg}${hostFlag} --binary-url ${binaryUrl}`
    )
  }

  const instanceUrlFlag = includeHost ? ` --instance-url ${instanceUrl}` : ''
  return (
    `TURBOPANEL_INSTALL_SCRIPT_URL=${DEFAULT_CDN_INSTALLER_URL} ` +
    `curl -fsSL ${DEFAULT_CDN_INSTALLER_URL} | ` +
    `sh -s -- --license ${licenseArg}${instanceUrlFlag}`
  )
}
