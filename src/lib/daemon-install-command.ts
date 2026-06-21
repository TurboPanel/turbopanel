const DEFAULT_CDN_INSTALLER_URL = 'https://cdn.turbopanel.app/daemon/install.sh'
const LICENSE_STAGING_DIR = '/opt/turbopanel/platform/config/daemon-license-staging'

export function buildLicenseInstallCommand(opts: {
  runtime: 'deno' | 'workers'
  origin: string
  licenseId: string
  licenseToken: string
}): string {
  const { runtime, origin, licenseId, licenseToken } = opts
  const licenseArg = `${licenseId}:${licenseToken}`
  const includeHost = origin !== 'https://turbopanel.app'

  if (runtime === 'deno') {
    const hostFlag = includeHost ? ` --host ${origin}` : ''
    return (
      `curl -fsSL ${origin}/api/install/v1/daemon-install.sh | ` +
      `sh -s -- --license ${licenseArg}${hostFlag}`
    )
  }

  const instanceUrlFlag = includeHost ? ` --instance-url ${origin}` : ''
  return (
    `mkdir -p ${LICENSE_STAGING_DIR} && ` +
    `printf '%s' '${licenseId}' > ${LICENSE_STAGING_DIR}/license.id && ` +
    `printf '%s' '${licenseToken}' > ${LICENSE_STAGING_DIR}/license.token && ` +
    `curl -fsSL ${DEFAULT_CDN_INSTALLER_URL} | sh -s --${instanceUrlFlag}`
  )
}
