import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

import { resolveNodePath } from './node-path.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ENV_KEYS = [
  'TURBOPANEL_NODE',
  'TURBOPANEL_RUNTIMES_DIR',
  'TURBOPANEL_DEV_SURFACE',
  'TURBOPANEL_MODE',
  'TURBOPANEL_UI_MODE',
  'PATH',
] as const

async function withEnv(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) saved.set(key, Deno.env.get(key))
  try {
    for (const key of ENV_KEYS) {
      if (!(key in overrides)) continue
      const value = overrides[key]
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

test('resolveNodePath returns TURBOPANEL_NODE when set', async () => {
  await withEnv({ TURBOPANEL_NODE: ' /custom/node ' }, async () => {
    assertEquals(await resolveNodePath(), '/custom/node')
  })
})

test('resolveNodePath uses managed node when the binary exists', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-node-path-' })
  const binDir = join(root, 'node', 'current', 'bin')
  await Deno.mkdir(binDir, { recursive: true })
  const managedNode = join(binDir, 'node')
  await Deno.writeTextFile(managedNode, '#!/bin/sh\necho managed\n')
  try {
    await withEnv(
      {
        TURBOPANEL_NODE: undefined,
        TURBOPANEL_RUNTIMES_DIR: root,
        TURBOPANEL_DEV_SURFACE: undefined,
        TURBOPANEL_MODE: undefined,
        TURBOPANEL_UI_MODE: 'static',
      },
      async () => {
        assertEquals(await resolveNodePath(), managedNode)
      },
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('resolveNodePath falls back to PATH only when developer surface is enabled', async () => {
  const pathDir = await Deno.makeTempDir({ prefix: 'tp-node-path-bin-' })
  const pathNode = join(pathDir, 'node')
  await Deno.writeTextFile(pathNode, '#!/bin/sh\necho path\n')
  const missingRoot = await Deno.makeTempDir({ prefix: 'tp-node-missing-' })
  try {
    await withEnv(
      {
        TURBOPANEL_NODE: undefined,
        TURBOPANEL_RUNTIMES_DIR: missingRoot,
        TURBOPANEL_DEV_SURFACE: '1',
        PATH: `${pathDir}:/usr/bin`,
      },
      async () => {
        assertEquals(await resolveNodePath(), pathNode)
      },
    )
  } finally {
    await Deno.remove(pathDir, { recursive: true })
    await Deno.remove(missingRoot, { recursive: true })
  }
})

test('resolveNodePath throws when no node binary is available', async () => {
  const missingRoot = await Deno.makeTempDir({ prefix: 'tp-node-none-' })
  try {
    await withEnv(
      {
        TURBOPANEL_NODE: undefined,
        TURBOPANEL_RUNTIMES_DIR: missingRoot,
        TURBOPANEL_DEV_SURFACE: undefined,
        TURBOPANEL_MODE: undefined,
        TURBOPANEL_UI_MODE: 'static',
        PATH: '/nonexistent-bin-dir',
      },
      async () => {
        await assertRejects(
          () => resolveNodePath(),
          Error,
          'Node.js not found',
        )
      },
    )
  } finally {
    await Deno.remove(missingRoot, { recursive: true })
  }
})

test('resolveNodePath skips empty PATH segments', async () => {
  const pathDir = await Deno.makeTempDir({ prefix: 'tp-node-empty-seg-' })
  const pathNode = join(pathDir, 'node')
  await Deno.writeTextFile(pathNode, '#!/bin/sh\necho path\n')
  const missingRoot = await Deno.makeTempDir({ prefix: 'tp-node-missing2-' })
  try {
    await withEnv(
      {
        TURBOPANEL_NODE: undefined,
        TURBOPANEL_RUNTIMES_DIR: missingRoot,
        TURBOPANEL_DEV_SURFACE: '1',
        PATH: `:${pathDir}:`,
      },
      async () => {
        const resolved = await resolveNodePath()
        assertEquals(resolved, pathNode)
        assertStringIncludes(resolved, 'node')
      },
    )
  } finally {
    await Deno.remove(pathDir, { recursive: true })
    await Deno.remove(missingRoot, { recursive: true })
  }
})
