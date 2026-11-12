import { assert, assertEquals } from '@std/assert'
import {
  type PanelIdentity,
  resolvePanelIdentityFromBinding,
} from '../../lib/panel-identity/identity.ts'
import {
  FIXTURE_NEXT_FINGERPRINT,
  fixtureBindingJson,
} from '../../test-fixtures/panel-identity-fixture.ts'
import {
  buildAuthPayloadV2,
  buildEnrollmentPayloadV2,
  checkProofVersion,
  parseProofVersion,
} from './proof-version.ts'
import { buildAuthPayload } from './server-key.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-02T12:00:00.000Z')
const NOW_S = NOW_MS / 1000

async function identity(): Promise<PanelIdentity> {
  const loaded = await resolvePanelIdentityFromBinding(
    await fixtureBindingJson({ next: { kid: FIXTURE_NEXT_FINGERPRINT } })
  )
  assert(loaded)
  return loaded
}

test('no payloadVersion, or 1, is a v1 proof', () => {
  assertEquals(parseProofVersion({}), { ok: true, value: { version: 1 } })
  assertEquals(parseProofVersion({ payloadVersion: 1 }), { ok: true, value: { version: 1 } })
})

test('a v2 proof needs a 43-character fingerprint and an integer iat', () => {
  const panelFingerprint = 'F'.repeat(43)
  assertEquals(parseProofVersion({ payloadVersion: 2, panelFingerprint, iat: NOW_S }), {
    ok: true,
    value: { version: 2, panelFingerprint, iat: NOW_S },
  })
  assertEquals(
    parseProofVersion({ payloadVersion: 2, panelFingerprint: 'x', iat: NOW_S }).ok,
    false
  )
  assertEquals(parseProofVersion({ payloadVersion: 2, panelFingerprint, iat: 1.5 }).ok, false)
  assertEquals(parseProofVersion({ payloadVersion: 3 }).ok, false)
})

test('v1 is accepted until the server has used a signed session', async () => {
  const id = await identity()
  assertEquals(checkProofVersion({ version: 1 }, { identity: id, trustLevel: 0, nowMs: NOW_MS }), {
    ok: true,
  })
  assertEquals(checkProofVersion({ version: 1 }, { identity: id, trustLevel: 1, nowMs: NOW_MS }), {
    ok: false,
    status: 403,
    error: 'Signed proof required',
  })
})

test('v2 must name the current or next key and be within five minutes', async () => {
  const id = await identity()
  const ctx = { identity: id, trustLevel: 1, nowMs: NOW_MS }
  for (const kid of [id.current.kid, FIXTURE_NEXT_FINGERPRINT]) {
    assertEquals(
      checkProofVersion({ version: 2, panelFingerprint: kid, iat: NOW_S - 300 }, ctx).ok,
      true
    )
  }
  assertEquals(
    checkProofVersion({ version: 2, panelFingerprint: 'O'.repeat(43), iat: NOW_S }, ctx),
    {
      ok: false,
      status: 403,
      error: 'Panel fingerprint mismatch',
    }
  )
  assertEquals(
    checkProofVersion({ version: 2, panelFingerprint: id.current.kid, iat: NOW_S + 301 }, ctx),
    { ok: false, status: 400, error: 'Proof clock skew' }
  )
  assertEquals(
    checkProofVersion(
      { version: 2, panelFingerprint: id.current.kid, iat: NOW_S },
      { identity: null, trustLevel: 0, nowMs: NOW_MS }
    ).ok,
    false
  )
})

test('v2 proof strings add the fingerprint, method, path and iat after the v1 fields', () => {
  const auth = {
    challengeId: 'c',
    nonce: 'n',
    serverId: 's',
    keyId: 'k',
    machineKey: 'm',
    hostname: 'h',
  }
  assertEquals(
    buildAuthPayloadV2({ ...auth, panelFingerprint: 'F', iat: 1700000000 }),
    'turbopanel-daemon-auth-v2\nc\nn\ns\nk\nm\nh\nF\nPOST\n/api/daemon/v1/auth/session\n1700000000'
  )
  assertEquals(buildAuthPayload(auth).startsWith('turbopanel-daemon-auth-v1\n'), true)
  assertEquals(
    buildEnrollmentPayloadV2({
      challengeId: 'c',
      nonce: 'n',
      licenseId: 'l',
      machineKey: 'm',
      hostname: 'h',
      publicKeyFingerprint: 'p',
      panelFingerprint: 'F',
      iat: 1700000000,
    }),
    'turbopanel-daemon-enroll-v2\nc\nn\nl\nm\nh\np\nF\nPOST\n/api/daemon/v1/enroll\n1700000000'
  )
})
