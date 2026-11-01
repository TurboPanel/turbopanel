import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { base64urlDecode } from '../../lib/encoding/base64url.ts'
import {
  resolvePanelIdentityFromBinding,
  signWithCurrent,
  type PanelIdentity,
} from '../../lib/panel-identity/identity.ts'
import {
  fixtureBindingJson,
  FIXTURE_NEXT_FINGERPRINT,
} from '../../test-fixtures/panel-identity-fixture.ts'
import {
  buildLicenseInstallCommand,
  encodeInstallToken,
  encodeInstallTokenPayload,
  type InstallTokenFields,
} from './daemon-install-command.ts'
import { buildInstallTokenFor, isInstallTokenV2Enabled } from './install-token-command.ts'

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno)

const decoder = new TextDecoder()

async function fixtureIdentity(json?: string): Promise<PanelIdentity> {
  const identity = await resolvePanelIdentityFromBinding(json ?? (await fixtureBindingJson()))
  if (!identity) throw new TypeError('fixture identity did not resolve')
  return identity
}
const FINGERPRINT = 'a'.repeat(43)

const FIELDS: InstallTokenFields = {
  licenseId: 'license-1',
  licenseToken: 'p:a/s+s=word',
  panelUrls: ['https://panel.example.test', 'https://alt.example.test:8443'],
  panelFingerprint: FINGERPRINT,
  nextFingerprint: null,
  caFingerprint: null,
}

/** Test-side decoder: the same grammar run.sh reads. */
function decodePayload(payload: string): string[] {
  const text = decoder.decode(base64urlDecode(payload))
  assert(text.startsWith('v2:'))
  const parts = text.slice(3).split(':')
  return parts.map((part) => decoder.decode(base64urlDecode(part)))
}

test('the payload is v2 and six base64url fields in the fixed order', () => {
  const fields = decodePayload(encodeInstallTokenPayload(FIELDS))
  assertEquals(fields, [
    'license-1',
    'p:a/s+s=word',
    'https://panel.example.test,https://alt.example.test:8443',
    FINGERPRINT,
    '',
    '',
  ])
})

test('the payload has no padding and empty fields stay empty', () => {
  const payload = encodeInstallTokenPayload({ ...FIELDS, nextFingerprint: FINGERPRINT })
  assertEquals(/^[A-Za-z0-9_-]+$/.test(payload), true)
  assertEquals(decodePayload(payload)[4], FINGERPRINT)
})

test('a URL with a path, a scheme other than https or no URL at all is refused', () => {
  for (const panelUrls of [['https://p.example.test/x'], ['http://p.example.test'], []]) {
    assertThrows(() => encodeInstallTokenPayload({ ...FIELDS, panelUrls }), TypeError)
  }
})

test('the token signature verifies with the panel key over the payload text', async () => {
  const identity = await fixtureIdentity()
  const token = await encodeInstallToken(FIELDS, (bytes) => signWithCurrent(identity, bytes))
  const [payload, sig] = token.split('.')
  const key = await crypto.subtle.importKey(
    'raw',
    identity.current.publicRaw as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify']
  )
  const ok = await crypto.subtle.verify(
    'Ed25519',
    key,
    base64urlDecode(sig) as BufferSource,
    new TextEncoder().encode(payload) as BufferSource
  )
  assertEquals(ok, true)
  const tampered = await crypto.subtle.verify(
    'Ed25519',
    key,
    base64urlDecode(sig) as BufferSource,
    new TextEncoder().encode(`${payload}x`) as BufferSource
  )
  assertEquals(tampered, false)
})

test('the TOKEN command carries one variable and keeps the channel variable', () => {
  const command = buildLicenseInstallCommand({
    runtime: 'workers',
    instanceUrl: 'https://panel.example.test',
    licenseId: 'license-1',
    licenseToken: 'secret',
    updateChannel: 'trunk',
    token: 'abc.def',
  })
  assertEquals(
    command,
    'curl -fsSL https://testing.turbopanel.sh | TOKEN=abc.def TURBOPANEL_UPDATE_CHANNEL=trunk sh'
  )
})

test('the older command is unchanged when no token is given', () => {
  const command = buildLicenseInstallCommand({
    runtime: 'workers',
    instanceUrl: 'https://panel.example.test',
    licenseId: 'license-1',
    licenseToken: 'secret',
  })
  assertEquals(command.startsWith('curl -fsSL https://turbopanel.sh | TURBOPANEL_LICENSE='), true)
  assertEquals(command.includes('TURBOPANEL_HOST=https://panel.example.test'), true)
})

test('the switch reads 1 or true only', () => {
  assertEquals(isInstallTokenV2Enabled({ TURBOPANEL_INSTALL_TOKEN_V2: '1' }), true)
  assertEquals(isInstallTokenV2Enabled({ TURBOPANEL_INSTALL_TOKEN_V2: 'TRUE' }), true)
  assertEquals(isInstallTokenV2Enabled({ TURBOPANEL_INSTALL_TOKEN_V2: '0' }), false)
  assertEquals(isInstallTokenV2Enabled({}), false)
  assertEquals(isInstallTokenV2Enabled(undefined), false)
})

test('the token for a command puts the install URL first and carries both fingerprints', async () => {
  const identity = await fixtureIdentity(
    await fixtureBindingJson({ next: { kid: FIXTURE_NEXT_FINGERPRINT } })
  )
  const hostnames = [{ host: 'one.example.test' }, { host: 'two.example.test:8443' }]
  const result = await buildInstallTokenFor({
    env: { TURBOPANEL_INSTALL_TOKEN_V2: '1' },
    identity,
    licenseId: 'l',
    licenseToken: 't',
    installUrl: 'https://two.example.test:8443/',
    hostnames: () => Promise.resolve(hostnames),
  })
  assert(result)
  assertEquals(result.panelFingerprint, identity.current.kid)
  assertEquals(result.nextFingerprint, FIXTURE_NEXT_FINGERPRINT)
  const fields = decodePayload(result.token.split('.')[0])
  assertEquals(fields[2], 'https://two.example.test:8443,https://one.example.test')
  assertEquals(fields[4], FIXTURE_NEXT_FINGERPRINT)
})

test('no token without the switch, an identity key or a bare https install URL', async () => {
  const identity = await fixtureIdentity()
  const base = {
    env: { TURBOPANEL_INSTALL_TOKEN_V2: '1' },
    identity,
    licenseId: 'l',
    licenseToken: 't',
    installUrl: 'https://p.example.test',
    hostnames: () => Promise.resolve([]),
  }
  assertEquals(await buildInstallTokenFor({ ...base, env: {} }), null)
  assertEquals(await buildInstallTokenFor({ ...base, identity: null }), null)
  assertEquals(await buildInstallTokenFor({ ...base, installUrl: 'http://203.0.113.10' }), null)
  assertEquals(
    await buildInstallTokenFor({ ...base, installUrl: 'https://p.example.test/x' }),
    null
  )
  await assertRejects(() => buildInstallTokenFor({ ...base, caFingerprints: ['not-hex'] }))
})
