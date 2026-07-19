import { describe, expect, it } from 'vitest'
import {
  buildLicenseInstallCommand,
  CDN_RUN_SCRIPT_DISPLAY,
  encodeLicenseArg,
} from './daemon-install-command.ts'

function extractLicenseArg(command: string): string {
  const match = /TURBOPANEL_LICENSE=([^\s]+)/.exec(command)
  if (!match) throw new Error('no TURBOPANEL_LICENSE in command')
  return match[1]
}

describe('buildLicenseInstallCommand', () => {
  it('uses run.sh on the instance host in dev', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.turbopanel.dev:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
    })

    const encoded = encodeLicenseArg('license-id', 'token')

    expect(command).toContain(
      'curl -fsSLk https://huey.turbopanel.dev:8443/run.sh',
    )
    expect(command).not.toContain('/api/install/v1/daemon-install.sh')
    expect(command).toContain(`| TURBOPANEL_LICENSE=${encoded}`)
    expect(command).toContain('TURBOPANEL_HOST=https://huey.turbopanel.dev:8443')
    expect(command).toContain('TURBOPANEL_INSECURE_TLS=1')
    expect(command).toMatch(/ sh$/)
    expect(command).not.toContain('sh -s --')
    expect(command).not.toContain('--license')
    expect(command).not.toContain('--host')
    expect(command).not.toContain('--insecure-tls')
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('sudo')
    expect(encoded).not.toMatch(/[:+/=]/)
  })

  it('uses plain curl without TLS flags for plaintext HTTP dev control plane', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'http://huey.lan:8880',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
    })

    expect(command).toContain('curl -fsSL http://huey.lan:8880/run.sh')
    expect(command).not.toContain('curl -fsSLk')
    expect(command).not.toContain('TURBOPANEL_INSECURE_TLS')
    expect(command).toContain('TURBOPANEL_HOST=http://huey.lan:8880')
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
    expect(command).toContain('TURBOPANEL_HOST=https://huey.lan:8443')
    expect(command).toContain('TURBOPANEL_INSECURE_TLS=1')
    expect(command).not.toContain('sh -s --')
    expect(command).not.toContain('--binary-url')
  })

  it('uses the CDN installer on Workers', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://turbopanel.app',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    const encoded = encodeLicenseArg('license-id', 'token')

    expect(command).toBe(
      `curl -fsSL ${CDN_RUN_SCRIPT_DISPLAY} | TURBOPANEL_LICENSE=${encoded} sh`,
    )
    expect(command).not.toContain('https://trbp.nl')
    expect(command).not.toContain('TURBOPANEL_INSTALL_SCRIPT_URL')
    expect(command).not.toContain('raw.githubusercontent.com')
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('--instance-url')
    expect(command).not.toContain('TURBOPANEL_HOST')
    expect(command).not.toContain('sh -s --')
    expect(command).not.toContain('sudo')
  })

  it('includes TURBOPANEL_HOST on Workers for non-production instance URLs', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://panel.example.com',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain(`curl -fsSL ${CDN_RUN_SCRIPT_DISPLAY}`)
    expect(command).toContain('TURBOPANEL_HOST=https://panel.example.com')
  })

  it('does not require the operator to prefix sudo', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://node.example.com:8443',
      licenseId: 'abc',
      licenseToken: 'secret',
    })

    const encoded = encodeLicenseArg('abc', 'secret')

    expect(command).toMatch(/curl -fsSL .+ \| TURBOPANEL_LICENSE=/)
    expect(command).toContain(`TURBOPANEL_LICENSE=${encoded}`)
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

    const standard = value.replaceAll('-', '+').replaceAll('_', '/')
    const padLen = (4 - (standard.length % 4)) % 4
    const padded = standard + '='.repeat(padLen)
    expect(atob(padded)).toBe(`${licenseId}:${licenseToken}`)
  })
})
