import { assertEquals } from '@std/assert'
import { sha256HexUtf8 } from '../compose/desired-hash.ts'
import { parseCacheApplyPayload } from '../../contracts/commands/schemas.ts'
import { cacheWireEntry, cacheWireSet } from './wire.ts'
import {
  CACHE_A,
  CACHE_B,
  cacheRowFixture,
  deriveTestSecrets,
  ENV_1,
  SERVER_1,
  SERVER_2,
} from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

test('the wire entry carries the SHA-256 of the plain password and never the password', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets)
  const entry = await cacheWireEntry(row, secrets, { memoryBytes: 1024 })
  assertEquals(entry.passwordSha256, await sha256HexUtf8('fixture-password'))
  assertEquals(JSON.stringify(entry).includes('fixture-password'), false)
  assertEquals(entry, {
    id: CACHE_A,
    name: 'app-cache',
    username: 'siteowner',
    engine: 'valkey',
    version: '8.1',
    access: 'socket',
    maxMemoryMb: 64,
    passwordSha256: await sha256HexUtf8('fixture-password'),
    accountLimits: { memoryBytes: 1024 },
  })
})

test('a port cache carries its port; a preview without keys still hashes something well formed', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets, { access: 'port', port: 18200 })
  const entry = await cacheWireEntry(row, undefined, undefined)
  assertEquals(entry.port, 18200)
  assertEquals(/^[0-9a-f]{64}$/.test(entry.passwordSha256), true)
  assertEquals('accountLimits' in entry, false)
})

test('the set is only the caches of that server, and parses as a cache.apply payload', async () => {
  const secrets = await deriveTestSecrets()
  const here = await cacheRowFixture(secrets)
  const there = await cacheRowFixture(secrets, { id: CACHE_B, name: 'other', serverId: SERVER_2 })
  const set = await cacheWireSet([here, there], SERVER_1, secrets, undefined)
  assertEquals(
    set.map((entry) => entry.id),
    [CACHE_A]
  )
  const payload = parseCacheApplyPayload({ environmentId: ENV_1, caches: set })
  assertEquals(payload.caches.length, 1)
  assertEquals((await cacheWireSet([here], SERVER_2, secrets, undefined)).length, 0)
})
