/**
 * Development installs: the maintenance tick never runs the update check, and
 * the co-located daemon (run from source) never counts as behind.
 */
import { assertEquals } from '@std/assert'
import { claimScheduledUpgradeCheck } from './maintenance.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'

const test = Deno.test.bind(Deno)

const COLOCATED = '00000000-0000-4000-8000-000000000000'
const REMOTE = '00000000-0000-4000-8000-0000000000a1'
const TARGET = 'built+1767225600'

function fact(serverId: string, commit: string | null, connected = true): FleetServerFact {
  return {
    serverId,
    name: serverId.slice(-2),
    hostname: null,
    connected,
    commit,
    version: '0.1.0',
    features: [],
    colocated: serverId === COLOCATED,
  }
}

test('a development install never claims the update check', async () => {
  const store = createMemoryUpgradeStore({ checkMinute: 17 })
  const slot = new Date('2026-10-27T10:17:00.000Z')
  const base = { now: slot, intervalMinutes: 60, resolveManifests: true }
  // Before the first hour the check is not due either way; move past it.
  await store.checkSchedule('2026-10-27T09:00:00.000Z')
  assertEquals(await claimScheduledUpgradeCheck(store, { ...base, development: true }), false)
  // Nothing was recorded, so a production pass at the same slot still checks.
  assertEquals(await claimScheduledUpgradeCheck(store, { ...base, development: false }), true)
  assertEquals(
    await claimScheduledUpgradeCheck(store, {
      ...base,
      now: new Date('2026-10-27T11:17:00.000Z'),
      resolveManifests: false,
      development: false,
    }),
    false
  )
})

test('anyDaemonBehind leaves the excluded server out', async () => {
  const store = createMemoryUpgradeStore({
    facts: [fact(COLOCATED, 'source-checkout'), fact(REMOTE, TARGET)],
  })
  assertEquals(await store.anyDaemonBehind(TARGET), true)
  assertEquals(await store.anyDaemonBehind(TARGET, null, null), true)
  assertEquals(await store.anyDaemonBehind(TARGET, null, COLOCATED), false)

  const behindRemote = createMemoryUpgradeStore({
    facts: [fact(COLOCATED, 'source-checkout'), fact(REMOTE, 'old')],
  })
  assertEquals(await behindRemote.anyDaemonBehind(TARGET, null, COLOCATED), true)
})
