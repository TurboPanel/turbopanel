import { describe, expect, it } from 'vitest'
import {
  buildLicenseInstallCommand,
  CDN_INSTALL_HOST,
  encodeLicenseArg,
  formatInstallScriptCurlUrl,
} from './daemon-install-command.ts'

function extractLicenseArg(command: string): string {
  const match = /TURBOPANEL_LICENSE=([^\s]+)/.exec(command)
  if (!match) throw new TypeError('no TURBOPANEL_LICENSE in command')
  return match[1]
}

describe('formatInstallScriptCurlUrl', () => {
  it('uses bare turbopanel.sh for the CDN origin', () => {
    expect(formatInstallScriptCurlUrl('https://turbopanel.sh')).toBe(
      CDN_INSTALL_HOST,
    )
  })

  it('uses bare turbopanel.sh when given the bare CDN host', () => {
    expect(formatInstallScriptCurlUrl(CDN_INSTALL_HOST)).toBe(CDN_INSTALL_HOST)
  })

  it('appends /run.sh for HTTPS on non-default ports', () => {
    expect(formatInstallScriptCurlUrl('https://huey.lan:8443')).toBe(
      'https://huey.lan:8443/run.sh',
    )
  })

  it('appends /run.sh for plaintext HTTP dev control plane', () => {
    expect(formatInstallScriptCurlUrl('http://huey.lan:8880')).toBe(
      'http://huey.lan:8880/run.sh',
    )
  })
})

describe('buildLicenseInstallCommand', () => {
  it('uses the instance host /run.sh in dev with insecure TLS', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.turbopanel.dev:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
      useInstanceRunScript: true,
    })

    const encoded = encodeLicenseArg('license-id', 'token')

    expect(command).toContain(
      'curl -fsSLk https://huey.turbopanel.dev:8443/run.sh',
    )
    expect(command).toContain('/run.sh')
    expect(command).not.toContain('/api/install/v1/daemon-install.sh')
    expect(command).toContain(`| TURBOPANEL_LICENSE=${encoded}`)
    expect(command).toContain(
      'TURBOPANEL_HOST=https://huey.turbopanel.dev:8443',
    )
    expect(command).toContain('TURBOPANEL_INSECURE_TLS=1')
    expect(command).toMatch(/ sh$/)
    expect(command).not.toContain('sh -s --')
    expect(command).not.toContain('--license')
    expect(command).not.toContain('--host')
    expect(command).not.toContain('--insecure-tls')
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('sudo')
    expect(command).not.toContain("'")
    expect(encoded).not.toMatch(/[:+/=]/)
  })

  it('uses plain curl without TLS flags for plaintext HTTP dev control plane', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'http://huey.lan:8880',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
      useInstanceRunScript: true,
    })

    expect(command).toContain('curl -fsSL http://huey.lan:8880/run.sh')
    expect(command).not.toContain('curl -fsSLk')
    expect(command).not.toContain('TURBOPANEL_INSECURE_TLS')
    expect(command).toContain('TURBOPANEL_HOST=http://huey.lan:8880')
  })

  it('self-hosted Deno without dev flag curls CDN and passes TURBOPANEL_HOST', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://panel.example.com',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain(`curl -fsSL ${CDN_INSTALL_HOST}`)
    expect(command).not.toContain('/run.sh')
    expect(command).not.toContain('curl -fsSLk')
    expect(command).not.toContain('TURBOPANEL_INSECURE_TLS')
    expect(command).toContain('TURBOPANEL_HOST=https://panel.example.com')
  })

  it('dev HTTPS with useInstanceRunScript produces curl -k and TURBOPANEL_INSECURE_TLS', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.lan:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
      useInstanceRunScript: true,
    })

    expect(command).toContain('curl -fsSLk https://huey.lan:8443/run.sh')
    expect(command).toContain('TURBOPANEL_INSECURE_TLS=1')
  })

  it('uses the instance host /run.sh on dev Deno installs', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'deno',
      instanceUrl: 'https://huey.lan:8443',
      licenseId: 'license-id',
      licenseToken: 'token',
      insecureTls: true,
      useInstanceRunScript: true,
    })

    expect(command).toContain('curl -fsSLk https://huey.lan:8443/run.sh')
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
      `curl -fsSL ${CDN_INSTALL_HOST} | TURBOPANEL_LICENSE=${encoded} sh`,
    )
    expect(command).not.toContain('https://trbp.nl')
    expect(command).not.toContain('TURBOPANEL_INSTALL_SCRIPT_URL')
    expect(command).not.toContain('raw.githubusercontent.com')
    expect(command).not.toContain('--binary-url')
    expect(command).not.toContain('--instance-url')
    expect(command).not.toContain('TURBOPANEL_HOST')
    expect(command).not.toContain('sh -s --')
    expect(command).not.toContain('sudo')
    expect(command).not.toContain("'")
  })

  it('includes TURBOPANEL_HOST on Workers for non-production instance URLs', () => {
    const command = buildLicenseInstallCommand({
      runtime: 'workers',
      instanceUrl: 'https://panel.example.com',
      licenseId: 'license-id',
      licenseToken: 'token',
    })

    expect(command).toContain(`curl -fsSL ${CDN_INSTALL_HOST}`)
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
    expect(command).toContain(`curl -fsSL ${CDN_INSTALL_HOST}`)
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
