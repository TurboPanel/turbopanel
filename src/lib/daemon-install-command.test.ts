import { describe, expect, it } from 'vitest'
import { buildLicenseInstallCommand } from './daemon-install-command.ts'

describe('buildLicenseInstallCommand', () => {
  it('uses run.sh on the instance host in dev', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.turbopanel.dev:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      devRunScript: true,
    })

    expect(command).toContain(
      'curl -fsSL https://huey.turbopanel.dev:8443/run.sh',
    )
    expect(command).not.toContain('/api/install/v1/daemon-install.sh')
    expect(command).toContain('--host https://huey.turbopanel.dev:8443')
    expect(command).toContain(
      '--binary-url https://huey.turbopanel.dev:8443/downloads/daemon',
    )
    expect(command).toContain('license-id:token')
  })

  it('keeps the API install script outside dev run.sh mode', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.lan:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain('/api/install/v1/daemon-install.sh')
    expect(command).toContain('--host https://huey.lan:8443')
  })

  it('uses the CDN installer on Workers', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://turbopanel.app',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain('raw.githubusercontent.com/turbopanel/turbopanel-cdn/trunk/install.sh')
    expect(command).not.toContain('--instance-url')
  })
})
