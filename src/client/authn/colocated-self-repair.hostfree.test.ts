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
  type ColocatedRepairDisk,
  type ColocatedRepairStore,
  type ColocatedSeat,
  type StoredDaemonKey,
  createColocatedRepairDisk,
  createColocatedSelfRepair,
  diagnoseColocatedCredentials,
  repairColocatedCredentialsOnce,
} from './colocated-self-repair.ts'
import {
  clearColocatedDaemonIdentityFiles,
  persistColocatedLicenseCredentials,
} from './install-state.ts'
import { isCredentialRefusal } from '../../daemon/api-routes.ts'
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
const KEY_ID = 'key-current'
/** A path that is never under the temp dir and never touched: writers refuse first. */
const REAL_LOOKING_DIR = '/var/lib/turbopanel-colocated-guard-never-written'

type FakeStoreState = {
  seat: ColocatedSeat | null
  key: StoredDaemonKey
  /** Stands in for the Argon2 hash: the fake verify compares plaintext. */
  tokenHash: string | null
  reissued: { clearKey: boolean }[]
  events: string[]
}

function fakeStore(initial: Partial<FakeStoreState> = {}): {
  store: ColocatedRepairStore
  state: FakeStoreState
} {
  const state: FakeStoreState = {
    seat: SEAT,
    key: { id: KEY_ID, active: true },
    tokenHash: null,
    reissued: [],
    events: [],
    ...initial,
  }
  let counter = 0
  const store: ColocatedRepairStore = {
    findSeat: () => Promise.resolve(state.seat),
    storedKey: () => Promise.resolve(state.key),
    licenseTokenHash: () => Promise.resolve(state.tokenHash),
    verifyToken: (plaintext, hashed) => Promise.resolve(plaintext === hashed),
    reissue: (_seat, opts) => {
      counter++
      const token = `reissued-token-${counter}`
      state.reissued.push(opts)
      state.events.push('reissue')
      state.tokenHash = token
      if (opts.clearKey) state.key = null
      return Promise.resolve(token)
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
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

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
  assertColocatedCredentialsDirWritable('/tmp/tp-x', { testRun: true, tempRoot: '/tmp' })
  assertColocatedCredentialsDirWritable('/var/lib/turbopanel', { testRun: false })
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

// ── Diagnosis ────────────────────────────────────────────────────────────

const HEALTHY_DISK = {
  licenseId: SEAT.licenseId,
  licenseToken: 'old-token-the-bind-erased',
  serverId: SEAT.serverId,
  keyId: KEY_ID,
}

test('diagnosis: an enrolled daemon with matching files is ok without a token check', () => {
  const result = diagnoseColocatedCredentials(SEAT, HEALTHY_DISK, { id: KEY_ID, active: true })
  assertEquals(result, { kind: 'ok' })
})

test('diagnosis: a wrong license.id alone keeps the daemon key', () => {
  const result = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, licenseId: 'other-license' },
    { id: KEY_ID, active: true }
  )
  assertEquals(result.kind, 'mismatch')
  if (result.kind === 'mismatch') assertEquals(result.clearKey, false)
})

test('diagnosis: a wrong server.id or a lost key clears the stored key', () => {
  const key = { id: KEY_ID, active: true }
  for (const disk of [
    { ...HEALTHY_DISK, serverId: 'other-server' },
    { ...HEALTHY_DISK, keyId: null },
    { ...HEALTHY_DISK, keyId: 'a-newer-key' },
  ]) {
    const result = diagnoseColocatedCredentials(SEAT, disk, key)
    assertEquals(result.kind, 'mismatch')
    if (result.kind === 'mismatch') assertEquals(result.clearKey, true)
  }
})

test('diagnosis: a revoked key blocks the repair', () => {
  const result = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, licenseId: 'other' },
    { id: KEY_ID, active: false }
  )
  assertEquals(result.kind, 'blocked')
})

test('diagnosis: an unreadable key id is not counted as a mismatch', () => {
  const result = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, keyId: undefined },
    { id: KEY_ID, active: true }
  )
  assertEquals(result, { kind: 'ok' })
})

test('diagnosis: before enrollment the token is checked, and a missing one is a mismatch', () => {
  assertEquals(diagnoseColocatedCredentials(SEAT, { ...HEALTHY_DISK, keyId: null }, null), {
    kind: 'check-token',
  })
  const missing = diagnoseColocatedCredentials(
    SEAT,
    { ...HEALTHY_DISK, keyId: null, licenseToken: null },
    null
  )
  assertEquals(missing.kind, 'mismatch')
  if (missing.kind === 'mismatch') assertEquals(missing.clearKey, false)
})

// ── Repair ───────────────────────────────────────────────────────────────

test('repair: clobbered files are re-issued on the same seat, then the second pass is a no-op', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    // What the test run left behind: another database's license and server,
    // no daemon key id.
    await writeFiles(credentials.dir, {
      [LICENSE_ID]: 'license-from-a-throwaway-db',
      [LICENSE_TOKEN]: 'token-from-a-throwaway-db',
      [SERVER_ID]: 'server-from-a-throwaway-db\n',
    })
    const { store, state } = fakeStore()
    const disk = createColocatedRepairDisk()

    const first = await repairColocatedCredentialsOnce(store, disk)
    assertEquals(first.status, 'repaired')
    if (first.status === 'repaired') {
      assertEquals(first.serverId, SEAT.serverId)
      assertEquals(first.clearedKey, true)
    }
    assertEquals(state.reissued, [{ clearKey: true }])
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), SEAT.licenseId)
    assertEquals(await readTrimmed(`${credentials.dir}/${SERVER_ID}`), SEAT.serverId)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_TOKEN}`), 'reissued-token-1')

    const second = await repairColocatedCredentialsOnce(store, disk)
    assertEquals(second, { status: 'ok' })
    assertEquals(state.reissued.length, 1)
  } finally {
    await credentials.restore()
  }
})

test('repair: the database is updated before the files are written', async () => {
  const { store, state } = fakeStore()
  const disk: ColocatedRepairDisk = {
    assertWritable: () => {},
    hasDaemonFiles: () => Promise.resolve(true),
    read: () =>
      Promise.resolve({ licenseId: 'wrong', licenseToken: 'x', serverId: 'wrong', keyId: null }),
    write: () => {
      state.events.push('write')
      return Promise.resolve(true)
    },
  }
  assertEquals((await repairColocatedCredentialsOnce(store, disk)).status, 'repaired')
  assertEquals(state.events, ['reissue', 'write'])
})

test('repair: nothing happens without a bound seat, daemon files or with a revoked key', async () => {
  const credentials = await useColocatedCredentialsTempDir()
  try {
    const disk = createColocatedRepairDisk()
    const noFiles = fakeStore()
    assertEquals((await repairColocatedCredentialsOnce(noFiles.store, disk)).status, 'skipped')

    await writeFiles(credentials.dir, { [LICENSE_ID]: 'wrong', [SERVER_ID]: 'wrong' })
    const noSeat = fakeStore({ seat: null })
    assertEquals((await repairColocatedCredentialsOnce(noSeat.store, disk)).status, 'skipped')

    const revoked = fakeStore({ key: { id: KEY_ID, active: false } })
    assertEquals((await repairColocatedCredentialsOnce(revoked.store, disk)).status, 'blocked')

    assertEquals(noFiles.state.reissued.length + noSeat.state.reissued.length, 0)
    assertEquals(revoked.state.reissued.length, 0)
    assertEquals(await readTrimmed(`${credentials.dir}/${LICENSE_ID}`), 'wrong')
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
    assertEquals(await repairColocatedCredentialsOnce(good.store, createColocatedRepairDisk()), {
      status: 'ok',
    })
    const bad = fakeStore({ key: null, tokenHash: 'some-other-token' })
    const outcome = await repairColocatedCredentialsOnce(bad.store, createColocatedRepairDisk())
    assertEquals(outcome.status, 'repaired')
    assertEquals(bad.state.reissued, [{ clearKey: false }])
  } finally {
    await credentials.restore()
  }
})

test('self-repair runs at most once per interval and never throws', async () => {
  let clock = 1_000_000
  const { store, state } = fakeStore()
  const reads: number[] = []
  const disk: ColocatedRepairDisk = {
    assertWritable: () => {},
    hasDaemonFiles: () => Promise.resolve(true),
    read: () => {
      reads.push(clock)
      return Promise.resolve({ ...HEALTHY_DISK, licenseId: 'wrong' })
    },
    write: () => Promise.resolve(true),
  }
  const repair = createColocatedSelfRepair({
    store,
    disk,
    minIntervalMs: 60_000,
    now: () => clock,
  })

  const [a, b] = await Promise.all([repair.run('boot'), repair.run('refusal')])
  assertEquals(a.status, 'repaired')
  assertEquals(b.status, 'repaired')
  assertEquals((await repair.run('refusal')).status, 'rate-limited')
  assertEquals(reads.length, 1)

  clock += 60_000
  store.reissue = () => Promise.reject(new Error('database down'))
  assertEquals(await repair.run('refusal'), { status: 'skipped', reason: 'error' })
  assertEquals(state.reissued.length, 1)
})

test('only enroll and session refusals a stale co-located daemon gets trigger a check', () => {
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 401), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 409), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/auth/session', 404), true)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 200), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/enroll', 429), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/auth/session', 401), false)
  assertEquals(isCredentialRefusal('GET', '/api/daemon/v1/enroll', 401), false)
  assertEquals(isCredentialRefusal('POST', '/api/daemon/v1/commands/lease', 401), false)
})
