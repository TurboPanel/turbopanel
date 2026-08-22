import { assertEquals } from '@std/assert'
import {
  DRIZZLE_STUDIO_PORT,
  probeDrizzleStudioPort,
} from '../drizzle-studio-probe.ts'
import {
  drizzleStudioStatus,
  ensureDrizzleStudioInDev,
  startDrizzleStudio,
  stopDrizzleStudio,
} from './drizzle-studio.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HOST_KEY = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
const DB_URL_KEY = 'TURBOPANEL_DATABASE_URL'

test('drizzleStudioStatus reports bind failure for non-loopback host', async () => {
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, '192.168.1.5')
  try {
    const status = await drizzleStudioStatus()
    assertEquals(status.running, false)
    assertEquals(status.port, DRIZZLE_STUDIO_PORT)
    assertEquals(status.error?.includes('loopback'), true)
    assertEquals(status.browserUrl.includes(String(DRIZZLE_STUDIO_PORT)), true)
  } finally {
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('drizzleStudioStatus probes localhost when configured', async () => {
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, 'localhost')
  try {
    const status = await drizzleStudioStatus()
    assertEquals(status.port, DRIZZLE_STUDIO_PORT)
    assertEquals(typeof status.running, 'boolean')
    assertEquals(status.browserUrl.includes('localhost'), true)
  } finally {
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('startDrizzleStudio rejects invalid bind host', async () => {
  stopDrizzleStudio()
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, '0.0.0.0')
  try {
    const started = await startDrizzleStudio()
    assertEquals(started.ok, false)
    if (started.ok) throw new TypeError('expected failure')
    assertEquals(started.error.includes('loopback'), true)
  } finally {
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('ensureDrizzleStudioInDev logs bind failure without throwing', async () => {
  stopDrizzleStudio()
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, 'example.com')
  try {
    await ensureDrizzleStudioInDev()
  } finally {
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('drizzleStudioStatus marks running when port is already open', async () => {
  stopDrizzleStudio()
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, '127.0.0.1')
  try {
    if (!(await probeDrizzleStudioPort('127.0.0.1', DRIZZLE_STUDIO_PORT))) {
      console.warn('Skipping open-port status test: studio port is closed')
      return
    }
    const status = await drizzleStudioStatus()
    assertEquals(status.running, true)
    assertEquals(status.port, DRIZZLE_STUDIO_PORT)
  } finally {
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('startDrizzleStudio returns early when studio port is already open', async () => {
  stopDrizzleStudio()
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, '127.0.0.1')
  try {
    if (!(await probeDrizzleStudioPort('127.0.0.1', DRIZZLE_STUDIO_PORT))) {
      console.warn('Skipping open-port start test: studio port is closed')
      return
    }
    const started = await startDrizzleStudio()
    assertEquals(started.ok, true)
    if (!started.ok) throw new TypeError('expected success')
    assertEquals(started.port, DRIZZLE_STUDIO_PORT)
  } finally {
    stopDrizzleStudio()
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('startDrizzleStudio rejects missing database URL', async () => {
  stopDrizzleStudio()
  const previousDb = Deno.env.get(DB_URL_KEY)
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.delete(DB_URL_KEY)
  Deno.env.set(HOST_KEY, '127.0.0.1')
  try {
    if (await probeDrizzleStudioPort('127.0.0.1', DRIZZLE_STUDIO_PORT)) {
      console.warn(
        'Skipping startDrizzleStudio missing-db test: studio port already listening',
      )
      return
    }
    const started = await startDrizzleStudio()
    assertEquals(started.ok, false)
    if (started.ok) throw new TypeError('expected failure')
    assertEquals(
      started.error,
      'postgres is not configured (missing TURBOPANEL_DATABASE_URL)',
    )
  } finally {
    stopDrizzleStudio()
    if (previousDb === undefined) Deno.env.delete(DB_URL_KEY)
    else Deno.env.set(DB_URL_KEY, previousDb)
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})

test('stopDrizzleStudio is safe when no child process is tracked', () => {
  stopDrizzleStudio()
  assertEquals(typeof stopDrizzleStudio, 'function')
})

test('ensureDrizzleStudioInDev completes without throwing', async () => {
  const previousHost = Deno.env.get(HOST_KEY)
  Deno.env.set(HOST_KEY, '127.0.0.1')
  try {
    await ensureDrizzleStudioInDev()
  } finally {
    stopDrizzleStudio()
    if (previousHost === undefined) Deno.env.delete(HOST_KEY)
    else Deno.env.set(HOST_KEY, previousHost)
  }
})
