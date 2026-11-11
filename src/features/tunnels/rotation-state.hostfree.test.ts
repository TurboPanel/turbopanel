import { assert, assertEquals } from '@std/assert'
import {
  readRotation,
  rotationActive,
  rotationWarnings,
  runSecretFor,
  toApiRotation,
} from './rotation-state.ts'
import { connectorConnected } from './run-token-rotation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

function rotating(fields: Record<string, unknown>) {
  return {
    runTokenRotation: {
      phase: 'rolling',
      step: 3,
      startedAt: '2026-11-11T00:00:00.000Z',
      newSecretId: 'new-secret',
      pending: [B],
      moved: [A],
      ...fields,
    },
  }
}

test('the stored rotation is read back, and anything malformed reads as none', () => {
  const state = readRotation(rotating({ current: { serverId: A, since: 'x', listInPlace: true } }))
  assertEquals(state?.phase, 'rolling')
  assertEquals(state?.step, 3)
  assertEquals(state?.pending, [B])
  assertEquals(state?.current, { serverId: A, since: 'x', listInPlace: true })
  assertEquals(readRotation(null), null)
  assertEquals(readRotation({}), null)
  assertEquals(readRotation(rotating({ phase: 'later' })), null)
  assertEquals(readRotation(rotating({ startedAt: '' })), null)
})

test('only starting, rolling and finishing are still under way', () => {
  for (const phase of ['starting', 'rolling', 'finishing']) {
    assert(rotationActive(readRotation(rotating({ phase }))))
  }
  for (const phase of ['done', 'stopped']) {
    assert(!rotationActive(readRotation(rotating({ phase }))))
  }
  assert(!rotationActive(null))
})

test('each server gets the old token while it waits its turn, the new one once moved or when it joined later', () => {
  const row = { secretId: 'old-secret', metadata: rotating({}) }
  assertEquals(runSecretFor(row, B), 'old-secret')
  assertEquals(runSecretFor(row, A), 'new-secret')
  // A server that started carrying the tunnel after the rotation began: the old token cannot connect.
  assertEquals(runSecretFor(row, C), 'new-secret')
  // Before the new token exists, and after the rotation is done, the tunnel's own token is used.
  assertEquals(
    runSecretFor({ secretId: 'old-secret', metadata: rotating({ newSecretId: undefined }) }, A),
    'old-secret'
  )
  assertEquals(
    runSecretFor({ secretId: 'adopted', metadata: rotating({ phase: 'done' }) }, B),
    'adopted'
  )
  assertEquals(runSecretFor({ secretId: 'plain', metadata: null }, A), 'plain')
})

test('the warning says connectors briefly reconnect, and a lone server also names the short outage', () => {
  const many = rotationWarnings([A, B])
  assertEquals(many.length, 1)
  assert(many[0]!.includes('briefly reconnect'))
  assert(!many[0]!.includes('Only one server'))
  const one = rotationWarnings([A])
  assert(one[0]!.startsWith('Only one server runs this Tunnel'))
  assert(one[0]!.includes('briefly reconnect'))
})

test('the API shows where the rotation is, never a secret id', () => {
  const shown = toApiRotation(readRotation(rotating({ current: { serverId: A, since: 'x' } })))
  assertEquals(shown, {
    phase: 'rolling',
    startedAt: '2026-11-11T00:00:00.000Z',
    finishedAt: null,
    movedServerIds: [A],
    pendingServerIds: [B],
    currentServerId: A,
    stoppedReason: null,
  })
  assert(!JSON.stringify(shown).includes('secret'))
  assertEquals(toApiRotation(null), null)
})

test('a status answer counts as connected only for this tunnel connected; connecting is not yet known', () => {
  const answer = (status: string) => ({
    pinnedVersion: '2026.10.7',
    connectors: [{ tunnelId: A, status, version: '2026.10.7', slot: 'a' }],
  })
  assertEquals(connectorConnected(answer('connected'), A), true)
  assertEquals(connectorConnected(answer('connecting'), A), null)
  assertEquals(connectorConnected(answer('failed'), A), false)
  assertEquals(connectorConnected(answer('connected'), B), false)
  assertEquals(connectorConnected('not an answer', A), null)
})
