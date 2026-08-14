import { assertEquals } from 'jsr:@std/assert'
import {
  buildLicenseInstallCommand,
  CDN_INSTALL_HOST,
  encodeLicenseArg,
  formatInstallScriptCurlUrl,
} from './daemon-install-command.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function extractLicenseArg(command: string): string {
  const match = /TURBOPANEL_LICENSE=([^\s]+)/.exec(command)
  if (!match) throw new TypeError('no TURBOPANEL_LICENSE in command')
  return match[1]
}

test('formatInstallScriptCurlUrl keeps bare CDN host and appends /run.sh elsewhere', () => {
  assertEquals(formatInstallScriptCurlUrl('https://turbopanel.sh'), CDN_INSTALL_HOST)
  assertEquals(formatInstallScriptCurlUrl(CDN_INSTALL_HOST), CDN_INSTALL_HOST)
  assertEquals(
    formatInstallScriptCurlUrl('https://huey.lan:8443'),
    'https://huey.lan:8443/run.sh',
  )
  assertEquals(
    formatInstallScriptCurlUrl('http://huey.lan:8880'),
    'http://huey.lan:8880/run.sh',
  )
})

test('encodeLicenseArg emits base64url without padding', () => {
  const encoded = encodeLicenseArg('license-id', 'token')
  assertEquals(encoded.includes('='), false)
  assertEquals(encoded.includes('+'), false)
  assertEquals(encoded.includes('/'), false)
})

test('buildLicenseInstallCommand uses dev /run.sh with insecure TLS', () => {
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl: 'https://huey.turbopanel.dev:8443',
    licenseId: 'license-id',
    licenseToken: 'token',
    insecureTls: true,
    useInstanceRunScript: true,
  })
  const encoded = encodeLicenseArg('license-id', 'token')

  assertEquals(command.includes('curl -fsSLk https://huey.turbopanel.dev:8443/run.sh'), true)
  assertEquals(command.includes(`TURBOPANEL_LICENSE=${encoded}`), true)
  assertEquals(command.includes('TURBOPANEL_HOST=https://huey.turbopanel.dev:8443'), true)
  assertEquals(command.includes('TURBOPANEL_INSECURE_TLS=1'), true)
  assertEquals(
    command.includes(
      'TURBOPANEL_DL_BASE=https://huey.turbopanel.dev:8443/downloads/daemon',
    ),
    true,
  )
})

test('buildLicenseInstallCommand omits insecure TLS for public overlay HTTPS', () => {
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl: 'https://turbopanel.dev',
    licenseId: 'license-id',
    licenseToken: 'token',
    insecureTls: false,
    useInstanceRunScript: true,
  })
  assertEquals(command.includes('curl -fsSL https://turbopanel.dev/run.sh'), true)
  assertEquals(command.includes('curl -fsSLk'), false)
  assertEquals(command.includes('TURBOPANEL_INSECURE_TLS'), false)
  assertEquals(
    command.includes('TURBOPANEL_DL_BASE=https://turbopanel.dev/downloads/daemon'),
    true,
  )
})

test('buildLicenseInstallCommand self-hosted Deno curls CDN with TURBOPANEL_HOST', () => {
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl: 'https://panel.example.com',
    licenseId: 'license-id',
    licenseToken: 'token',
  })

  assertEquals(command.includes(`curl -fsSL ${CDN_INSTALL_HOST}`), true)
  assertEquals(command.includes('/run.sh'), false)
  assertEquals(command.includes('TURBOPANEL_HOST=https://panel.example.com'), true)
  assertEquals(command.includes('TURBOPANEL_INSECURE_TLS'), false)
})

test('buildLicenseInstallCommand Workers omits host on production URL', () => {
  const encoded = encodeLicenseArg('license-id', 'token')
  const command = buildLicenseInstallCommand({
    runtime: 'workers',
    instanceUrl: 'https://turbopanel.app',
    licenseId: 'license-id',
    licenseToken: 'token',
  })

  assertEquals(
    command,
    `curl -fsSL ${CDN_INSTALL_HOST} | TURBOPANEL_LICENSE=${encoded} sh`,
  )
  assertEquals(command.includes('TURBOPANEL_HOST'), false)
})

test('license arg round-trips through base64url decoding', () => {
  const licenseId = 'license-id'
  const licenseToken = 'token'
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl: 'https://example.com:8443',
    licenseId,
    licenseToken,
  })

  const value = extractLicenseArg(command)
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padLen = (4 - (standard.length % 4)) % 4
  const padded = standard + '='.repeat(padLen)
  assertEquals(atob(padded), `${licenseId}:${licenseToken}`)
})
