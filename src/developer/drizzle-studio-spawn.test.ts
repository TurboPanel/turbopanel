import { assertEquals } from '@std/assert'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Alt port so tests avoid a live studio on the default 4983. */
const ALT_STUDIO_PORT = '49831'

const HOST_KEY = 'TURBOPANEL_DRIZZLE_STUDIO_HOST'
const PORT_KEY = 'TURBOPANEL_DRIZZLE_STUDIO_PORT'
const DB_URL_KEY = 'TURBOPANEL_DATABASE_URL'
const NODE_KEY = 'TURBOPANEL_NODE'

function restoreEnv(
  keys: Record<string, string | undefined>,
): void {
  for (const [key, previous] of Object.entries(keys)) {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
}

async function loadStudioModule() {
  return await import('./drizzle-studio.ts')
}

test('drizzleStudioStatus reports not running when alt port is closed', async () => {
  const previous = {
    [HOST_KEY]: Deno.env.get(HOST_KEY),
    [PORT_KEY]: Deno.env.get(PORT_KEY),
  }
  Deno.env.set(HOST_KEY, '127.0.0.1')
  Deno.env.set(PORT_KEY, ALT_STUDIO_PORT)
  try {
    const { drizzleStudioStatus, stopDrizzleStudio } = await loadStudioModule()
    stopDrizzleStudio()
    const status = await drizzleStudioStatus()
    assertEquals(status.running, false)
    assertEquals(status.port, Number(ALT_STUDIO_PORT))
    assertEquals(status.error, undefined)
  } finally {
    restoreEnv(previous)
  }
})

test('startDrizzleStudio rejects missing database URL on alt port', async () => {
  const previous = {
    [HOST_KEY]: Deno.env.get(HOST_KEY),
    [PORT_KEY]: Deno.env.get(PORT_KEY),
    [DB_URL_KEY]: Deno.env.get(DB_URL_KEY),
  }
  Deno.env.set(HOST_KEY, '127.0.0.1')
  Deno.env.set(PORT_KEY, ALT_STUDIO_PORT)
  Deno.env.delete(DB_URL_KEY)
  try {
    const { startDrizzleStudio, stopDrizzleStudio } = await loadStudioModule()
    stopDrizzleStudio()
    const started = await startDrizzleStudio()
    assertEquals(started.ok, false)
    if (started.ok) throw new TypeError('expected failure')
    assertEquals(
      started.error,
      'postgres is not configured (missing TURBOPANEL_DATABASE_URL)',
    )
  } finally {
    restoreEnv(previous)
  }
})

test('startDrizzleStudio spawn path surfaces not-ready when drizzle-kit cannot start', async () => {
  const databaseUrl = Deno.env.get(DB_URL_KEY)
  if (!databaseUrl) {
    console.warn('Skipping spawn test: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const previous = {
    [HOST_KEY]: Deno.env.get(HOST_KEY),
    [PORT_KEY]: Deno.env.get(PORT_KEY),
    [DB_URL_KEY]: Deno.env.get(DB_URL_KEY),
    [NODE_KEY]: Deno.env.get(NODE_KEY),
  }
  Deno.env.set(HOST_KEY, '127.0.0.1')
  Deno.env.set(PORT_KEY, ALT_STUDIO_PORT)
  Deno.env.set(DB_URL_KEY, databaseUrl)
  Deno.env.set(NODE_KEY, '/bin/false')
  try {
    const { startDrizzleStudio, stopDrizzleStudio } = await loadStudioModule()
    stopDrizzleStudio()
    const started = await startDrizzleStudio()
    assertEquals(started.ok, false)
    if (started.ok) throw new TypeError('expected failure')
    assertEquals(typeof started.error, 'string')
    assertEquals(started.error.length > 0, true)
  } finally {
    restoreEnv(previous)
  }
})

test('ensureDrizzleStudioInDev does not throw when Node.js cannot be resolved', async () => {
  // CI coverage has TURBOPANEL_DATABASE_URL but no vendored Node under
  // /opt/turbopanel; PATH discovery is gated off without the developer
  // surface. resolveNodePath must convert to { ok: false }, never throw.
  // Module-load may have already frozen DRIZZLE_STUDIO_PORT; only assert the
  // resolve-failure path when that port is free (so we do not short-circuit).
  const { probeDrizzleStudioPort, DRIZZLE_STUDIO_PORT } = await import(
    '../drizzle-studio-probe.ts'
  )
  if (await probeDrizzleStudioPort('127.0.0.1', DRIZZLE_STUDIO_PORT)) {
    console.warn(
      'Skipping missing-Node studio test: studio port already listening',
    )
    return
  }

  const missingRoot = await Deno.makeTempDir({ prefix: 'tp-studio-no-node-' })
  const previous = {
    [HOST_KEY]: Deno.env.get(HOST_KEY),
    [DB_URL_KEY]: Deno.env.get(DB_URL_KEY),
    [NODE_KEY]: Deno.env.get(NODE_KEY),
    TURBOPANEL_RUNTIMES_DIR: Deno.env.get('TURBOPANEL_RUNTIMES_DIR'),
    TURBOPANEL_UI_MODE: Deno.env.get('TURBOPANEL_UI_MODE'),
    TURBOPANEL_DEV_SURFACE: Deno.env.get('TURBOPANEL_DEV_SURFACE'),
    TURBOPANEL_MODE: Deno.env.get('TURBOPANEL_MODE'),
    PATH: Deno.env.get('PATH'),
  }
  Deno.env.set(HOST_KEY, '127.0.0.1')
  // Presence-only placeholder: startDrizzleStudio fails on Node before drizzle
  // kit / DB connect; avoid `user:pass@` shapes the secret scanner flags.
  Deno.env.set(DB_URL_KEY, Deno.env.get(DB_URL_KEY) ?? 'postgres://test@127.0.0.1/test')
  Deno.env.delete(NODE_KEY)
  Deno.env.set('TURBOPANEL_RUNTIMES_DIR', missingRoot)
  Deno.env.set('TURBOPANEL_UI_MODE', 'static')
  Deno.env.delete('TURBOPANEL_DEV_SURFACE')
  Deno.env.delete('TURBOPANEL_MODE')
  Deno.env.set('PATH', '/nonexistent-bin-dir')
  try {
    const { ensureDrizzleStudioInDev, startDrizzleStudio, stopDrizzleStudio } =
      await loadStudioModule()
    stopDrizzleStudio()
    const started = await startDrizzleStudio()
    assertEquals(started.ok, false)
    if (started.ok) throw new TypeError('expected failure')
    assertEquals(started.error.includes('Node.js not found'), true)
    await ensureDrizzleStudioInDev()
  } finally {
    restoreEnv(previous)
    await Deno.remove(missingRoot, { recursive: true })
  }
})
