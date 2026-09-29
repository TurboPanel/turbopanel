import { assertEquals } from '@std/assert'
import {
  buildLicenseInstallCommand,
  CDN_INSTALL_HOST,
  encodeLicenseArg,
  formatInstallScriptCurlUrl,
  installScriptHostForChannel,
  STAGING_INSTALL_HOST,
  TESTING_INSTALL_HOST,
} from './daemon-install-command.ts'
import { installOriginNeedsInsecureTls, installOriginTlsOptions } from './install-tls.ts'
import { parseInstallBaseUrl } from './resolve-public-base-url.ts'

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
  assertEquals(formatInstallScriptCurlUrl('https://huey.lan:8443'), 'https://huey.lan:8443/run.sh')
  assertEquals(formatInstallScriptCurlUrl('https://huey.lan:8443'), 'https://huey.lan:8443/run.sh')
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
    command.includes('TURBOPANEL_DL_BASE=https://huey.turbopanel.dev:8443/downloads/daemon'),
    true
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
  assertEquals(command.includes('TURBOPANEL_DL_BASE=https://turbopanel.dev/downloads/daemon'), true)
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

  assertEquals(command, `curl -fsSL ${CDN_INSTALL_HOST} | TURBOPANEL_LICENSE=${encoded} sh`)
  assertEquals(command.includes('TURBOPANEL_HOST'), false)
})

test("composed pipeline omits insecure TLS for a Let's Encrypt hostname", () => {
  const instanceUrl = 'https://panel.example.com:8443'
  const insecureTls = installOriginNeedsInsecureTls(instanceUrl, {
    source: 'lets-encrypt',
  })
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl,
    licenseId: 'license-id',
    licenseToken: 'token',
    insecureTls,
  })
  assertEquals(command.includes('curl -fsSLk'), false)
  assertEquals(command.includes('TURBOPANEL_INSECURE_TLS=1'), false)
})

test('no stored hostnames: a public DNS name on the self-hosted listener bootstraps with Platform CA trust', () => {
  const instanceUrl = parseInstallBaseUrl('panel.example.com')
  if (!instanceUrl) throw new TypeError('expected an install origin')
  const insecureTls = installOriginNeedsInsecureTls(
    instanceUrl,
    installOriginTlsOptions(
      undefined,
      {},
      {
        hostnames: [],
        selfHostedListener: true,
      }
    )
  )
  const command = buildLicenseInstallCommand({
    runtime: 'deno',
    instanceUrl,
    licenseId: 'license-id',
    licenseToken: 'token',
    insecureTls,
  })
  assertEquals(instanceUrl, 'https://panel.example.com:8443')
  assertEquals(insecureTls, true)
  assertEquals(command.includes('curl -fsSLk'), true)
  assertEquals(command.includes('TURBOPANEL_INSECURE_TLS=1'), true)
  assertEquals(command.includes('TURBOPANEL_HOST=https://panel.example.com:8443'), true)
  const hosted = installOriginNeedsInsecureTls(
    instanceUrl,
    installOriginTlsOptions(
      undefined,
      {},
      {
        hostnames: [],
        selfHostedListener: false,
      }
    )
  )
  assertEquals(hosted, false)
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

test('buildLicenseInstallCommand carries the instance channel so enrolled daemons follow it, trunk implicit', () => {
  const base = {
    runtime: 'deno' as const,
    instanceUrl: 'https://panel.example',
    licenseId: 'lic',
    licenseToken: 'tok',
  }
  const release = buildLicenseInstallCommand({
    ...base,
    updateChannel: 'release',
  })
  assertEquals(release.includes(' TURBOPANEL_UPDATE_CHANNEL=release sh'), true)
  const rc = buildLicenseInstallCommand({ ...base, updateChannel: 'rc' })
  assertEquals(rc.includes('TURBOPANEL_UPDATE_CHANNEL=rc'), true)
  // run.sh already defaults to trunk; the command stays as short as it was.
  assertEquals(
    buildLicenseInstallCommand({ ...base, updateChannel: 'trunk' }).includes('UPDATE_CHANNEL'),
    false
  )
  assertEquals(buildLicenseInstallCommand(base).includes('UPDATE_CHANNEL'), false)
  // Workers too.
  const hosted = buildLicenseInstallCommand({
    ...base,
    runtime: 'workers',
    updateChannel: 'release',
  })
  assertEquals(hosted.includes('TURBOPANEL_UPDATE_CHANNEL=release'), true)
})

test('installScriptHostForChannel: rc is staging, the canary rail is testing, everything else the bare host', () => {
  assertEquals(installScriptHostForChannel('rc'), STAGING_INSTALL_HOST)
  for (const channel of ['trunk', 'edge', 'canary']) {
    assertEquals(installScriptHostForChannel(channel), TESTING_INSTALL_HOST)
  }
  assertEquals(installScriptHostForChannel('release'), CDN_INSTALL_HOST)
  assertEquals(installScriptHostForChannel(undefined), CDN_INSTALL_HOST)
  assertEquals(installScriptHostForChannel('nonsense'), CDN_INSTALL_HOST)
})

test("formatInstallScriptCurlUrl keeps each environment's bare installer host", () => {
  for (const host of [CDN_INSTALL_HOST, STAGING_INSTALL_HOST, TESTING_INSTALL_HOST]) {
    assertEquals(formatInstallScriptCurlUrl(host), host)
    assertEquals(formatInstallScriptCurlUrl(`https://${host}`), host)
  }
})

test("buildLicenseInstallCommand curls the installer host for the instance's channel", () => {
  const base = {
    instanceUrl: 'https://turbopanel.app',
    licenseId: 'license-id',
    licenseToken: 'token',
  }
  for (const runtime of ['deno', 'workers'] as const) {
    const canary = buildLicenseInstallCommand({
      ...base,
      runtime,
      updateChannel: 'canary',
    })
    assertEquals(canary.startsWith(`curl -fsSL ${TESTING_INSTALL_HOST} | `), true)
    const rc = buildLicenseInstallCommand({
      ...base,
      runtime,
      updateChannel: 'rc',
    })
    assertEquals(rc.startsWith(`curl -fsSL ${STAGING_INSTALL_HOST} | `), true)
    assertEquals(rc.includes('TURBOPANEL_UPDATE_CHANNEL=rc'), true)
    const release = buildLicenseInstallCommand({
      ...base,
      runtime,
      updateChannel: 'release',
    })
    assertEquals(release.startsWith(`curl -fsSL ${CDN_INSTALL_HOST} | `), true)
  }
})
