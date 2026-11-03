/**
 * Host-free coverage for the co-located credential dir guard and the
 * co-located daemon credential self-repair. Temp dirs and fakes only: no
 * database, and nothing outside `/tmp` is ever written.
 */

import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import {
  assertColocatedCredentialsDirWritable,
  COLOCATED_LICENSE_ID_FILE as LICENSE_ID,
  COLOCATED_LICENSE_TOKEN_FILE as LICENSE_TOKEN,
  COLOCATED_SERVER_ID_FILE as SERVER_ID,
  COLOCATED_SERVER_KEY_FILE as SERVER_KEY,
  COLOCATED_SERVER_KEY_ID_FILE as SERVER_KEY_ID,
  DEFAULT_DAEMON_STATE_DIR,
  isDenoTestRun,
  isStrictlyInside,
  resolveColocatedLicenseCredentialsDir,
  setColocatedCredentialsDirForTesting,
} from './colocated-credentials-dir.ts'
import {
  type ColocatedDiskState,
  type ColocatedRepairDisk,
  type ColocatedRepairQueries,
  type ColocatedRepairStore,
  type ColocatedSeat,
  type StoredDaemonKey,
  createColocatedRepairDisk,
  createColocatedSelfRepair,
  diagnoseColocatedCredentials,
  repairColocatedCredentialsOnce,
  repairColocatedCredentialsOnRequest,
} from './colocated-self-repair.ts'
import {
  clearColocatedDaemonIdentityFiles,
  persistColocatedLicenseCredentials,
} from './install-state.ts'
import { Hono } from 'hono'
import { credentialRefusalMiddleware, isCredentialRefusal } from '../../daemon/api-routes.ts'
import { isDirectLocalSocketRequest } from '../../lib/peer-address.ts'
import { computePublicKeyFingerprint } from '../../daemon/authn/server-key.ts'
import { useColocatedCredentialsTempDir } from '../../test-fixtures/colocated-credentials.test.support.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SEAT: ColocatedSeat = {
  licenseId: '00000000-0000-4000-8000-00000000c0a1',
  serverId: '00000000-0000-4000-8000-00000000c0b1',
}
const FOREIGN_LICENSE = '00000000-0000-4000-8000-00000000f0a1'
const FOREIGN_SERVER = '00000000-0000-4000-8000-00000000f0b1'
const KEY_ID = 'key-current'
const KEY_FINGERPRINT = 'fingerprint-current'
/** A path that is never under the temp dir and never touched: writers refuse first. */
const REAL_LOOKING_DIR = '/var/lib/turbopanel-colocated-guard-never-written'

type FakeState = {
  seat: ColocatedSeat | null
  key: StoredDaemonKey
  /** Stands in for the Argon2 hash: the fake verify compares plaintext. */
  tokenHash: string | null
  knownLicenses: Set<string>
  knownServers: Set<string>
  events: string[]
  /** Runs when the lock is taken, before the locked queries: a racing writer. */
  onLock: () => void
}

function fakeStore(initial: Partial<FakeState> = {}): {
  store: ColocatedRepairStore
  state: FakeState
} {
  const state: FakeState = {
    seat: SEAT,
    key: { id: KEY_ID, fingerprint: KEY_FINGERPRINT, active: true },
    tokenHash: null,
    knownLicenses: new Set([SEAT.licenseId]),
    knownServers: new Set([SEAT.serverId]),
    events: [],
    onLock: () => {},
    ...initial,
  }
  let counter = 0
  const queries: ColocatedRepairQueries = {
    findSeat: () => Promise.resolve(state.seat),
    storedKey: () => Promise.resolve(state.key),
    licenseTokenHash: () => Promise.resolve(state.tokenHash),
    verifyToken: (plaintext, hashed) => Promise.resolve(plaintext === hashed),
    licenseExists: (id) => Promise.resolve(state.knownLicenses.has(id)),
    serverExists: (id) => Promise.resolve(state.knownServers.has(id)),
    rotateToken: () => {
      counter++
      const token = `reissued-token-${counter}`
      state.events.push('rotate')
      state.tokenHash = token
      return Promise.resolve(token)
    },
    clearKey: (_serverId, keyId) => {
      state.events.push(`clear:${keyId}`)
      if (state.key?.id !== keyId) return Promise.resolve(false)
      state.key = null
      return Promise.resolve(true)
    },
  }
  const store: ColocatedRepairStore = {
    ...queries,
    locked: async (fn) => {
      state.events.push('lock')
      state.onLock()
      return await fn(queries)
    },
  }
  return { store, state }
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, body)
  }
}

async function readTrimmed(path: string): Promise<string> {
  return (await Deno.readTextFile(path)).trim()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

/** Disk adapter on the temp credentials dir. */
function tempDisk(): ColocatedRepairDisk {
  return createColocatedRepairDisk()
}

/** In-memory disk for scheduling tests. */
function memoryDisk(
  state: ColocatedDiskState,
  write: () => Promise<boolean> = () => Promise.resolve(true)
): ColocatedRepairDisk {
  return {
    assertWritable: () => {},
    hasDaemonFiles: () => Promise.resolve(true),
    read: () => Promise.resolve(state),
    write,
  }
}

const HEALTHY_DISK: ColocatedDiskState = {
  licenseId: SEAT.licenseId,
  licenseToken: 'old-token-the-bind-erased',
  serverId: SEAT.serverId,
  keyId: KEY_ID,
  keyFingerprint: KEY_FINGERPRINT,
}
const ACTIVE_KEY = { id: KEY_ID, fingerprint: KEY_FINGERPRINT, active: true }

// ── Guard ────────────────────────────────────────────────────────────────

test('isDenoTestRun recognizes test modules and not the control plane entry', () => {
  assertEquals(isDenoTestRun(), true)
  assertEquals(isDenoTestRun('file:///repo/src/x.hostfree.test.ts'), true)
  assertEquals(isDenoTestRun('file:///repo/src/x_test.ts'), true)
  assertEquals(isDenoTestRun('file:///repo/src/deno.ts'), false)
  assertEquals(isDenoTestRun('file:///opt/turbopanel/bin/turbopanel'), false)
})

test('isStrictlyInside rejects the root itself, siblings and dot segments', () => {
  assertEquals(isStrictlyInside('/tmp/a', '/tmp'), true)
  assertEquals(isStrictlyInside('/tmp/a/b/', '/tmp/'), true)
  assertEquals(isStrictlyInside('/tmp', '/tmp'), false)
  assertEquals(isStrictlyInside('/tmpx/a', '/tmp'), false)
  assertEquals(isStrictlyInside('/tmp/../var/lib/turbopanel', '/tmp'), false)
  assertEquals(isStrictlyInside('/tmp/./a', '/tmp'), false)
})

test('the guard refuses a real state dir in a test run and allows it in production', () => {
  assertThrows(() => assertColocatedCredentialsDirWritable(DEFAULT_DAEMON_STATE_DIR))
  assertThrows(() =>
    assertColocatedCredentialsDirWritable('/var/lib/turbopanel', {
      testRun: true,
      tempRoot: '/tmp',
    })
  )
  assertColocatedCredentialsDirWritable('/var/lib/turbopanel', { testRun: false })
})

test('the guard resolves symlinks: a link in /tmp to a real dir is refused', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    // Targets that exist outside /tmp; nothing is ever written through them.
    await Deno.symlink('/etc', `${credentials.dir}/to-etc`)
    await Deno.symlink('/var/lib/turbopanel-never-there', `${credentials.dir}/dangling`)
    await Deno.mkdir(`${credentials.dir}/plain`)
    assertThrows(() => assertColocatedCredentialsDirWritable(`${credentials.dir}/to-etc`))
    assertThrows(() => assertColocatedCredentialsDirWritable(`${credentials.dir}/to-etc/sub`))
    assertThrows(() => assertColocatedCredentialsDirWritable(`${credentials.dir}/dangling`))
    assertColocatedCredentialsDirWritable(`${credentials.dir}/plain`)
    assertColocatedCredentialsDirWritable(`${credentials.dir}/not-made-yet`)
  } finally {
    await credentials.restore()
  }
})

test('a temp dir from the fixture is accepted and becomes the resolved dir', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    assertEquals(resolveColocatedLicenseCredentialsDir(), credentials.dir)
    assertColocatedCredentialsDirWritable(credentials.dir)
  } finally {
    await credentials.restore()
  }
  assertEquals(await pathExists(credentials.dir), false)
})

test('install writers throw before touching a non-temp dir in a test run', async () => {
  setColocatedCredentialsDirForTesting(REAL_LOOKING_DIR)
  try {
    await assertRejects(() => persistColocatedLicenseCredentials('lic', 'tok', 'srv'))
    await assertRejects(() => clearColocatedDaemonIdentityFiles())
    const repair = await repairColocatedCredentialsOnce(
      fakeStore().store,
      createColocatedRepairDisk()
    )
      .then(() => 'ran')
      .catch(() => 'refused')
    assertEquals(repair, 'refused')
  } finally {
    setColocatedCredentialsDirForTesting(null)
  }
  assertEquals(await pathExists(REAL_LOOKING_DIR), false)
})

test('install writers write into the temp dir from the fixture', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeFiles(credentials.dir, { [SERVER_KEY]: '{}', [SERVER_KEY_ID]: 'k' })
    await clearColocatedDaemonIdentityFiles()
    assertEquals(await pathExists(`${credentials.dir}/${SERVER_KEY}`), false)
    assertEquals(await persistColocatedLicenseCredentials('lic', 'tok', 'srv'), true)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), 'lic')
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_TOKEN}`), 'tok')
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), 'srv')
  } finally {
    await credentials.restore()
  }
})

// ── Ownership ────────────────────────────────────────────────────────────

test('repair: files whose ids are both unknown here are never written', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    // The original incident: another database's license and server ids.
    await writeFiles(credentials.dir, {
      [LICENSE_ID]: FOREIGN_LICENSE,
      [LICENSE_TOKEN]: 'token-from-a-throwaway-db',
      [SERVER_ID]: FOREIGN_SERVER,
    })
    const { store, state } = fakeStore()
    const outcome = await repairColocatedCredentialsOnce(store, tempDisk())
    assertEquals(outcome.status, 'not-ours')
    assertEquals(state.events, [])
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), FOREIGN_LICENSE)
  } finally {
    await credentials.restore()
  }
})

// ── Diagnosis ────────────────────────────────────────────────────────────

test('diagnosis: an enrolled daemon with matching files is ok without a token check', () => {
  assertEquals(diagnoseColocatedCredentials(SEAT, HEALTHY_DISK, ACTIVE_KEY), { kind: 'ok' })
})

test('diagnosis: a wrong license.id alone keeps the daemon key', () => {
  const result = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, licenseId: 'other-license' },
    ACTIVE_KEY
  )
  assertEquals(result.kind, 'mismatch')
  if (result.kind === 'mismatch') assertEquals(result.clearKeyId, null)
})

test('diagnosis: a wrong server.id or another key clears exactly the stored key', () => {
  for (const disk of [
    { ...HEALTHY_DISK, serverId: 'other-server' },
    { ...HEALTHY_DISK, keyFingerprint: 'a-newer-key' },
    { ...HEALTHY_DISK, keyFingerprint: null, keyId: null },
    { ...HEALTHY_DISK, keyFingerprint: undefined, keyId: 'a-newer-key-id' },
  ]) {
    const result = diagnoseColocatedCredentials(SEAT, disk, ACTIVE_KEY)
    assertEquals(result.kind, 'mismatch')
    if (result.kind === 'mismatch') assertEquals(result.clearKeyId, KEY_ID)
  }
})

test('diagnosis: the key file fingerprint wins and a missing key id alone clears nothing', () => {
  // Readable key file holding the stored key: healthy, whatever the id file says.
  assertEquals(diagnoseColocatedCredentials(SEAT, { ...HEALTHY_DISK, keyId: null }, ACTIVE_KEY), {
    kind: 'ok',
  })
  assertEquals(
    diagnoseColocatedCredentials(SEAT, { ...HEALTHY_DISK, keyId: 'stale-id' }, ACTIVE_KEY),
    { kind: 'ok' }
  )
  // Unreadable key file and no key id file: not counted.
  assertEquals(
    diagnoseColocatedCredentials(
      SEAT,
      { ...HEALTHY_DISK, keyFingerprint: undefined, keyId: null },
      ACTIVE_KEY
    ),
    { kind: 'ok' }
  )
})

test('diagnosis: a revoked key blocks the repair', () => {
  const result = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, licenseId: 'other' },
    { ...ACTIVE_KEY, active: false }
  )
  assertEquals(result.kind, 'blocked')
})

test('diagnosis: before enrollment the token is checked, and a missing one is a mismatch', () => {
  assertEquals(diagnoseColocatedCredentials(SEAT, HEALTHY_DISK, null), { kind: 'check-token' })
  const missing = diagnoseColocatedCredentials(SEAT, { ...HEALTHY_DISK, licenseToken: null }, null)
  assertEquals(missing.kind, 'mismatch')
  if (missing.kind === 'mismatch') assertEquals(missing.clearKeyId, null)
})

// ── Repair ───────────────────────────────────────────────────────────────

test('repair: a known license id with a lost key is re-issued, then the next pass is a no-op', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    // The license id is this database's; the server id and key are gone.
    await writeFiles(credentials.dir, {
      [LICENSE_ID]: SEAT.licenseId,
      [LICENSE_TOKEN]: 'stale-token',
      [SERVER_ID]: FOREIGN_SERVER,
    })
    const { store, state } = fakeStore()
    const disk = tempDisk()

    const first = await repairColocatedCredentialsOnce(store, disk)
    assertEquals(first.status, 'repaired')
    if (first.status === 'repaired') {
      assertEquals(first.serverId, SEAT.serverId)
      assertEquals(first.clearedKey, true)
    }
    assertEquals(state.events, ['lock', 'rotate', `clear:${KEY_ID}`])
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), SEAT.licenseId)
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), SEAT.serverId)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_TOKEN}`), 'reissued-token-1')

    const second = await repairColocatedCredentialsOnce(store, disk)
    assertEquals(second, { status: 'ok' })
    assertEquals(state.events.length, 3)
  } finally {
    await credentials.restore()
  }
})

test('repair: the key file fingerprint is read from disk and a matching key is kept', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'test-public-x' }
    const fingerprint = await computePublicKeyFingerprint(publicJwk)
    await writeFiles(credentials.dir, {
      [LICENSE_ID]: 'not-a-uuid-from-an-old-ticket',
      [LICENSE_TOKEN]: 'whatever',
      [SERVER_ID]: SEAT.serverId,
      [SERVER_KEY]: JSON.stringify({ publicJwk }),
    })
    const { store, state } = fakeStore({
      key: { id: KEY_ID, fingerprint, active: true },
    })
    const outcome = await repairColocatedCredentialsOnce(store, tempDisk())
    // Only the license id was wrong: files rewritten, key left in place.
    assertEquals(outcome.status, 'repaired')
    assertEquals(state.events, ['lock', 'rotate'])
    assertEquals(state.key?.id, KEY_ID)
  } finally {
    await credentials.restore()
  }
})

test('repair: the diagnosis is repeated under the lock and a fixed race changes nothing', async () => {
  const { store, state } = fakeStore()
  const disk = memoryDisk({ ...HEALTHY_DISK, keyFingerprint: 'a-key-the-daemon-just-made' })
  // Between the first look and the lock, the daemon registered that key.
  state.onLock = () => {
    state.key = { id: 'key-new', fingerprint: 'a-key-the-daemon-just-made', active: true }
  }
  assertEquals(await repairColocatedCredentialsOnce(store, disk), { status: 'ok' })
  assertEquals(state.events, ['lock'])
})

test('repair: only the diagnosed key id is cleared', async () => {
  const { store, state } = fakeStore()
  const disk = memoryDisk({ ...HEALTHY_DISK, serverId: FOREIGN_SERVER })
  assertEquals((await repairColocatedCredentialsOnce(store, disk)).status, 'repaired')
  assertEquals(state.events, ['lock', 'rotate', `clear:${KEY_ID}`])
})

test('repair: the database is updated before the files are written', async () => {
  const { store, state } = fakeStore()
  const disk = memoryDisk({ ...HEALTHY_DISK, licenseId: 'wrong' }, () => {
    state.events.push('write')
    return Promise.resolve(true)
  })
  assertEquals((await repairColocatedCredentialsOnce(store, disk)).status, 'repaired')
  assertEquals(state.events, ['lock', 'rotate', 'write'])
})

test('repair: nothing happens without a bound seat, daemon files or with a revoked key', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    const disk = tempDisk()
    const noFiles = fakeStore()
    assertEquals((await repairColocatedCredentialsOnce(noFiles.store, disk)).status, 'skipped')

    await writeFiles(credentials.dir, { [LICENSE_ID]: SEAT.licenseId, [SERVER_ID]: 'wrong' })
    const noSeat = fakeStore({ seat: null })
    assertEquals((await repairColocatedCredentialsOnce(noSeat.store, disk)).status, 'skipped')

    const revoked = fakeStore({ key: { ...ACTIVE_KEY, active: false } })
    assertEquals((await repairColocatedCredentialsOnce(revoked.store, disk)).status, 'blocked')

    assertEquals([...noFiles.state.events, ...noSeat.state.events, ...revoked.state.events], [])
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), 'wrong')
  } finally {
    await credentials.restore()
  }
})

test('repair: before enrollment a token that verifies is left alone', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeFiles(credentials.dir, {
      [LICENSE_ID]: SEAT.licenseId,
      [LICENSE_TOKEN]: 'install-token',
      [SERVER_ID]: SEAT.serverId,
    })
    const good = fakeStore({ key: null, tokenHash: 'install-token' })
    assertEquals(await repairColocatedCredentialsOnce(good.store, tempDisk()), {
      status: 'ok',
    })
    const bad = fakeStore({ key: null, tokenHash: 'some-other-token' })
    const outcome = await repairColocatedCredentialsOnce(bad.store, tempDisk())
    assertEquals(outcome.status, 'repaired')
    assertEquals(bad.state.events, ['lock', 'rotate'])
  } finally {
    await credentials.restore()
  }
})

// ── Scheduling ───────────────────────────────────────────────────────────

test('self-repair runs at most once per interval and shares a check in flight', async () => {
  let clock = 1_000_000
  const { store } = fakeStore()
  let reads = 0
  const disk = memoryDisk({ ...HEALTHY_DISK, licenseId: 'wrong' })
  const read = disk.read
  disk.read = () => {
    reads++
    return read()
  }
  const repair = createColocatedSelfRepair({ store, disk, minIntervalMs: 60_000, now: () => clock })

  const [a, b] = await Promise.all([repair.run('refusal'), repair.run('refusal')])
  assertEquals(a.status, 'repaired')
  assertEquals(b.status, 'repaired')
  assertEquals((await repair.run('refusal')).status, 'rate-limited')
  // First look plus the look under the lock.
  assertEquals(reads, 2)
  // Nothing failed, so nothing is queued for retry.
  assertEquals(await repair.tick(), null)
  clock += 60_000
  assertEquals((await repair.run('refusal')).status, 'repaired')
})

test('self-repair retries a failed write with backoff, without waiting for a restart', async () => {
  let clock = 1_000_000
  const { store } = fakeStore()
  let writes = 0
  const disk = memoryDisk({ ...HEALTHY_DISK, licenseId: 'wrong' }, () => {
    writes++
    return Promise.resolve(writes >= 3)
  })
  const repair = createColocatedSelfRepair({
    store,
    disk,
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    now: () => clock,
  })

  assertEquals((await repair.run('refusal')).status, 'failed')
  assertEquals(await repair.tick(), null)
  clock += 1_000
  assertEquals((await repair.tick())?.status, 'failed')
  clock += 1_000
  // Second failure doubled the wait.
  assertEquals(await repair.tick(), null)
  clock += 1_000
  assertEquals((await repair.tick())?.status, 'repaired')
  clock += 60_000
  assertEquals(await repair.tick(), null)
})

test('self-repair retries after a database error and never throws', async () => {
  let clock = 1_000_000
  const { store } = fakeStore()
  let down = true
  const failing: ColocatedRepairStore = {
    ...store,
    locked: async (fn) => {
      if (down) throw new Error('database down')
      return await store.locked(fn)
    },
  }
  const repair = createColocatedSelfRepair({
    store: failing,
    disk: memoryDisk({ ...HEALTHY_DISK, licenseId: 'wrong' }),
    retryBaseMs: 1_000,
    now: () => clock,
  })
  assertEquals(await repair.run('refusal'), { status: 'skipped', reason: 'error' })
  down = false
  clock += 1_000
  assertEquals((await repair.tick())?.status, 'repaired')
})

test('only enroll and session refusals a stale co-located daemon gets trigger a check', () => {
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 401), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 409), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/auth/session', 404), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 200), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 429), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/auth/session', 401), false)
  assertEquals(isCredentialRefusal('GET', '/api/daemon/v1/enroll', 401), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/x/enroll', 401), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/commands/lease', 401), false)
})

// ── Direct socket refusals only ──────────────────────────────────────────

test('isDirectLocalSocketRequest: any proxy header means proxied', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name]
  assertEquals(isDirectLocalSocketRequest(headers({})), true)
  for (const name of [
    'x-real-ip',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'forwarded',
    'via',
    'cf-connecting-ip',
    'true-client-ip',
  ]) {
    assertEquals(isDirectLocalSocketRequest(headers({ [name]: '' })), false, name)
  }
})

/** A daemon API stand-in: every enroll is refused 401, as for stale files. */
function refusingDaemonApp(onRefusal: () => void): Hono {
  const app = new Hono()
  app.use('*', credentialRefusalMiddleware(onRefusal))
  app.post('/api/daemon/v1/enroll', (c) => c.json({ ok: false, error: 'Invalid license' }, 401))
  return app
}

/** The co-located seat's server id on disk with the key gone: a repair case. */
async function writeRepairableFiles(dir: string, licenseId: string, serverId: string) {
  await writeFiles(dir, {
    [LICENSE_ID]: licenseId,
    [LICENSE_TOKEN]: 'stale-token',
    [SERVER_ID]: serverId,
  })
}

async function enrollThrough(
  app: Hono,
  headers: Record<string, string>,
  pending: Promise<unknown>[]
): Promise<void> {
  const response = await app.request('/api/daemon/v1/enroll', { method: 'POST', headers })
  assertEquals(response.status, 401)
  await Promise.all(pending)
}

test('a refusal Caddy proxied never starts a repair', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeRepairableFiles(credentials.dir, SEAT.licenseId, FOREIGN_SERVER)
    const { store, state } = fakeStore()
    const repair = createColocatedSelfRepair({ store, disk: tempDisk() })
    const pending: Promise<unknown>[] = []
    const app = refusingDaemonApp(() => pending.push(repair.run('refusal')))
    await enrollThrough(
      app,
      { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' },
      pending
    )
    assertEquals(pending.length, 0)
    assertEquals(state.events, [])
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), FOREIGN_SERVER)
  } finally {
    await credentials.restore()
  }
})

test('a direct socket refusal with a known id on disk repairs the files', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeRepairableFiles(credentials.dir, SEAT.licenseId, FOREIGN_SERVER)
    const { store, state } = fakeStore()
    const repair = createColocatedSelfRepair({ store, disk: tempDisk() })
    const pending: Promise<unknown>[] = []
    const app = refusingDaemonApp(() => pending.push(repair.run('refusal')))
    await enrollThrough(app, {}, pending)
    assertEquals(pending.length, 1)
    assertEquals(state.events, ['lock', 'rotate', `clear:${KEY_ID}`])
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), SEAT.serverId)
  } finally {
    await credentials.restore()
  }
})

test('a direct socket refusal with only unknown ids on disk writes nothing', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeRepairableFiles(credentials.dir, FOREIGN_LICENSE, FOREIGN_SERVER)
    const { store, state } = fakeStore()
    const repair = createColocatedSelfRepair({ store, disk: tempDisk() })
    const pending: Promise<unknown>[] = []
    const app = refusingDaemonApp(() => pending.push(repair.run('refusal')))
    await enrollThrough(app, {}, pending)
    assertEquals(pending.length, 1)
    assertEquals(await pending[0], {
      status: 'not-ours',
      reason: 'no id on disk names a row in this database',
    })
    assertEquals(state.events, [])
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), FOREIGN_LICENSE)
  } finally {
    await credentials.restore()
  }
})

test('retries stop once no socket refusal has come in for the window', async () => {
  let clock = 1_000_000
  const { store } = fakeStore()
  const repair = createColocatedSelfRepair({
    store,
    disk: memoryDisk({ ...HEALTHY_DISK, licenseId: 'wrong' }, () => Promise.resolve(false)),
    retryBaseMs: 1_000,
    refusalWindowMs: 5_000,
    now: () => clock,
  })
  assertEquals((await repair.run('refusal')).status, 'failed')
  clock += 1_000
  assertEquals((await repair.tick())?.status, 'failed')
  clock += 10_000
  // The daemon stopped asking: the pending retry is dropped.
  assertEquals(await repair.tick(), null)
  clock += 60_000
  assertEquals(await repair.tick(), null)
})

// ── On request ───────────────────────────────────────────────────────────

/** The 2026-11-03 incident: both ids on disk come from another database. */
const FOREIGN_FILES = {
  [LICENSE_ID]: FOREIGN_LICENSE,
  [LICENSE_TOKEN]: 'token-from-a-throwaway-db',
  [SERVER_ID]: FOREIGN_SERVER,
  [SERVER_KEY_ID]: 'key-from-a-throwaway-db',
}

test('on request: foreign ids on disk are repaired onto the same seat', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeFiles(credentials.dir, FOREIGN_FILES)
    const { store, state } = fakeStore()
    const outcome = await repairColocatedCredentialsOnRequest(store, tempDisk(), SEAT.serverId)
    assertEquals(outcome.status, 'repaired')
    if (outcome.status === 'repaired') {
      assertEquals(outcome.serverId, SEAT.serverId)
      assertEquals(outcome.clearedKey, true)
    }
    // Database first (under the lock), then the files; same license and server.
    assertEquals(state.events, ['lock', 'rotate', `clear:${KEY_ID}`])
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), SEAT.licenseId)
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), SEAT.serverId)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_TOKEN}`), 'reissued-token-1')
  } finally {
    await credentials.restore()
  }
})

test('on request: healthy files still get a new token and keep the key', async () => {
  const { store, state } = fakeStore()
  let written: { seat: ColocatedSeat; token: string } | null = null
  const disk = memoryDisk(HEALTHY_DISK)
  disk.write = (seat, token) => {
    written = { seat, token }
    return Promise.resolve(true)
  }
  const outcome = await repairColocatedCredentialsOnRequest(store, disk, SEAT.serverId)
  assertEquals(outcome, {
    status: 'repaired',
    serverId: SEAT.serverId,
    reasons: ['an owner asked for new credentials'],
    clearedKey: false,
  })
  assertEquals(state.events, ['lock', 'rotate'])
  assertEquals(state.key?.id, KEY_ID)
  assertEquals(written, { seat: SEAT, token: 'reissued-token-1' })
})

test('on request: another server, no seat or no daemon files change nothing', async () => {
  const other = fakeStore()
  assertEquals(
    await repairColocatedCredentialsOnRequest(
      other.store,
      memoryDisk(HEALTHY_DISK),
      FOREIGN_SERVER
    ),
    { status: 'refused', code: 'not_colocated_server' }
  )
  assertEquals(other.state.events, [])

  const noSeat = fakeStore({ seat: null })
  assertEquals(
    await repairColocatedCredentialsOnRequest(
      noSeat.store,
      memoryDisk(HEALTHY_DISK),
      SEAT.serverId
    ),
    { status: 'refused', code: 'no_colocated_seat' }
  )
  assertEquals(noSeat.state.events, [])

  const credentials = await useColocatedCredentialsTempDir()
  try {
    const bare = fakeStore()
    assertEquals(await repairColocatedCredentialsOnRequest(bare.store, tempDisk(), SEAT.serverId), {
      status: 'refused',
      code: 'no_daemon_files',
    })
    assertEquals(bare.state.events, [])
    assertEquals(await pathExists(`${credentials.dir}/${LICENSE_ID}`), false)
  } finally {
    await credentials.restore()
  }
})

test('on request: a revoked key is refused and never touched', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    await writeFiles(credentials.dir, FOREIGN_FILES)
    const { store, state } = fakeStore({ key: { ...ACTIVE_KEY, active: false } })
    assertEquals(await repairColocatedCredentialsOnRequest(store, tempDisk(), SEAT.serverId), {
      status: 'refused',
      code: 'daemon_key_revoked',
    })
    assertEquals(state.events, ['lock'])
    assertEquals(state.key?.active, false)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), FOREIGN_LICENSE)
  } finally {
    await credentials.restore()
  }
})

test('on request: a seat that changed under the lock changes nothing', async () => {
  const { store, state } = fakeStore()
  state.onLock = () => {
    state.seat = { ...SEAT, licenseId: FOREIGN_LICENSE }
  }
  assertEquals(
    await repairColocatedCredentialsOnRequest(store, memoryDisk(HEALTHY_DISK), SEAT.serverId),
    { status: 'refused', code: 'seat_changed' }
  )
  assertEquals(state.events, ['lock'])
})

test('on request: a failed file write is reported after the database changed', async () => {
  const { store, state } = fakeStore()
  const disk = memoryDisk(HEALTHY_DISK, () => Promise.resolve(false))
  const outcome = await repairColocatedCredentialsOnRequest(store, disk, SEAT.serverId)
  assertEquals(outcome, {
    status: 'failed',
    serverId: SEAT.serverId,
    reason: 'could not write license files',
  })
  assertEquals(state.events, ['lock', 'rotate'])
})

test('on request: a non-temp dir is refused in a test run before anything changes', async () => {
  setColocatedCredentialsDirForTesting(REAL_LOOKING_DIR)
  try {
    const { store, state } = fakeStore()
    await assertRejects(() =>
      repairColocatedCredentialsOnRequest(store, createColocatedRepairDisk(), SEAT.serverId)
    )
    assertEquals(state.events, [])
  } finally {
    setColocatedCredentialsDirForTesting(null)
  }
  assertEquals(await pathExists(REAL_LOOKING_DIR), false)
})
