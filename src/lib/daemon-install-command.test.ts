import { describe, expect, it } from 'vitest'
import {
  buildLicenseInstallCommand,
  encodeLicenseArg,
} from './daemon-install-command.ts'

function extractLicenseArg(command: string): string {
  const match = command.match(/--license ([^\s]+)/)
  if (!match) throw new Error('no --license in command')
  return match[1]
}

describe('buildLicenseInstallCommand', () => {
  it('uses run.sh on the instance host in dev', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.turbopanel.dev:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      devRunScript: true,
      insecureTls: true,
    })

    const encoded = encodeLicenseArg('license-id', 'token')

    expect(command).toContain(
      'curl -fsSLk https://huey.turbopanel.dev:8443/run.sh',
    )
    expect(command).not.toContain('/api/install/v1/daemon-install.sh')
    expect(command).toContain('| sh -s --')
    expect(command).not.toContain('sudo sh -s --')
    expect(command).toContain('--host https://huey.turbopanel.dev:8443')
    expect(command).not.toContain('--binary-url')
    expect(command).toContain('--insecure-tls')
    expect(command).toContain(`--license ${encoded}`)
    expect(encoded).not.toMatch(/[:+/=]/)
  })

  it('uses run.sh on self-hosted Deno installs', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.lan:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
    })

    expect(command).toContain(
      'curl -fsSLk https://huey.lan:8443/run.sh',
    )
    expect(command).not.toContain('/api/install/v1/daemon-install.sh')
    expect(command).not.toContain('raw.githubusercontent.com')
    expect(command).toContain('| sh -s --')
    expect(command).not.toContain('sudo sh -s --')
    expect(command).toContain('--host https://huey.lan:8443')
    expect(command).not.toContain('--binary-url')
    expect(command).toContain('--insecure-tls')
  })

  it('uses the CDN installer on Workers', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://turbopanel.app',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    const encoded = encodeLicenseArg('license-id', 'token')

    expect(command).toContain('curl -fsSL https://trbp.nl/run.sh | sh -s --')
    expect(command).not.toContain('TURBOPANEL_INSTALL_SCRIPT_URL')
    expect(command).not.toContain('raw.githubusercontent.com')
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('--instance-url')
    expect(command).not.toContain('--host')
    expect(command).toContain(`--license ${encoded}`)
    expect(command).toContain('| sh -s --')
    expect(command).not.toContain('sudo')
  })

  it('includes --host on Workers for non-production instance URLs', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://panel.example.com',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain('--host https://panel.example.com')
  })

  it('does not require the operator to prefix sudo', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://node.example.com:8443',
      licenseId: 'abc',
      licenseToken: 'secret',
    })

    const encoded = encodeLicenseArg('abc', 'secret')

    expect(command).toMatch(/curl -fsSL .+ \| sh -s --/)
    expect(command).toContain(`--license ${encoded}`)
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('sudo')
  })

  it('encodes the license arg as base64url with no padding', () => {
    const licenseId = 'license-id'
    const licenseToken = 'token'
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://example.com:8443',
      licenseId,
      licenseToken,
    })

    const value = extractLicenseArg(command)
    expect(value).not.toMatch(/[:+/=]/)

    const standard = value.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (standard.length % 4)) % 4
    const padded = standard + '='.repeat(padLen)
    expect(atob(padded)).toBe(`${licenseId}:${licenseToken}`)
  })
})
