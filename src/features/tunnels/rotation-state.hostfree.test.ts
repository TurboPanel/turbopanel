import { assert, assertEquals } from '@std/assert'
import {
  readRotation,
  rotationActive,
  rotationWarnings,
  claimHeld,
  dueForRetry,
  runSecretFor,
  settling,
  toApiRotation,
} from './rotation-state.ts'
import { connectorConnected, listHoldsToken } from './run-token-rotation.ts'

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
  const state = readRotation(
    rotating({ current: { serverId: A, since: 'x', connectorsCommandId: 'c1', unknown: true } })
  )
  assertEquals(state?.phase, 'rolling')
  assertEquals(state?.step, 3)
  assertEquals(state?.pending, [B])
  assertEquals(state?.current, { serverId: A, since: 'x', connectorsCommandId: 'c1' })
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

test('moved servers that went out of reach are read back, and keep the new token', () => {
  const row = { secretId: 'old-secret', metadata: rotating({ unconfirmed: [A, 7] }) }
  assertEquals(readRotation(row.metadata)?.unconfirmed, [A])
  assertEquals(runSecretFor(row, A), 'new-secret')
  assertEquals(readRotation(rotating({}))?.unconfirmed, undefined)
})

test('stopped after the secret was chosen, every server may still hold the old token', () => {
  const stopped = toApiRotation(
    readRotation(
      rotating({
        phase: 'stopped',
        newSecretId: undefined,
        tunnelSecretId: 'chosen',
        pending: [A, B],
        moved: [],
        retryable: true,
      })
    )
  )
  assertEquals(stopped?.oldTokenServerIds, [A, B])
  assertEquals(stopped?.resumesOnItsOwn, true)
  // Not started at the provider yet (no secret chosen): nobody is on an old token.
  assertEquals(
    toApiRotation(readRotation(rotating({ phase: 'starting', newSecretId: undefined })))
      ?.oldTokenServerIds,
    []
  )
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
    // The provider issued the new token: B still runs on the old one.
    oldTokenServerIds: [B],
    resumesOnItsOwn: false,
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

test('only a list answer that names this tunnel installed or unchanged confirms the new token', () => {
  assertEquals(listHoldsToken({ installed: [A], unchanged: [], removed: [] }, A), true)
  assertEquals(listHoldsToken({ installed: [], unchanged: [A], removed: [] }, A), true)
  assertEquals(listHoldsToken({ installed: [B], unchanged: [], removed: [A] }, A), false)
  assertEquals(listHoldsToken(null, A), false)
  assertEquals(listHoldsToken({ installed: 'A' }, A), false)
})

test('the next server waits until traffic had time to settle on the last moved one', () => {
  const state = readRotation(rotating({ lastConnectedAt: '2026-11-11T00:00:00.000Z' }))!
  const at = Date.parse('2026-11-11T00:00:00.000Z')
  assert(settling(state, at + 9 * 60_000, 10 * 60_000))
  assert(!settling(state, at + 10 * 60_000, 10 * 60_000))
  assert(!settling(readRotation(rotating({}))!, at, 10 * 60_000))
})

test('a provider attempt holds the rotation for a short lease, and a stop for an unreachable server retries', () => {
  const at = Date.parse('2026-11-11T00:00:00.000Z')
  const claimed = readRotation(
    rotating({ phase: 'starting', claimedAt: '2026-11-11T00:00:00.000Z' })
  )!
  assert(claimHeld(claimed, at + 60_000))
  assert(!claimHeld(claimed, at + 2 * 60_000))
  assert(!claimHeld(readRotation(rotating({}))!, at))
  const stopped = readRotation(
    rotating({ phase: 'stopped', retryable: true, stoppedAt: '2026-11-11T00:00:00.000Z' })
  )!
  assert(!dueForRetry(stopped, at + 60_000))
  assert(dueForRetry(stopped, at + 2 * 60_000))
  assertEquals(toApiRotation(stopped)?.resumesOnItsOwn, true)
  // A stop a person has to look at never goes again on its own.
  assert(!dueForRetry(readRotation(rotating({ phase: 'stopped' }))!, at + 60 * 60_000))
  assert(!dueForRetry(readRotation(rotating({ phase: 'rolling', retryable: true }))!, at))
})
