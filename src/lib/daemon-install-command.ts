export function encodeLicenseArg(
  licenseId: string,
  licenseToken: string,
): string {
  const combined = `${licenseId}:${licenseToken}`
  return btoa(combined)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function buildLicenseInstallCommand(opts: {
  runtime: 'deno' | 'workers'
  instanceUrl: string
  licenseId: string
  licenseToken: string
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
    insecureTls = false,
  } = opts
  const licenseArg = encodeLicenseArg(licenseId, licenseToken)
  const includeHost = instanceUrl !== 'https://turbopanel.app'
  const scriptBase = instanceUrl.replace(/\/$/, '')

  if (runtime === 'deno') {
    const hostFlag = includeHost ? ` --host ${instanceUrl}` : ''
    const tlsFlag = insecureTls ? ' --insecure-tls' : ''
    const curl = insecureTls ? 'curl -fsSLk' : 'curl -fsSL'
    return (
      `${curl} ${scriptBase}/run.sh | ` +
      `sh -s -- --license ${licenseArg}${hostFlag}${tlsFlag}`
    )
  }

  const hostFlag = includeHost ? ` --host ${instanceUrl}` : ''
  return (
    `curl -fsSL https://trbp.nl/run.sh | ` +
    `sh -s -- --license ${licenseArg}${hostFlag}`
  )
}
