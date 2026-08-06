import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

import {
  DRIZZLE_STUDIO_CONFIG,
  writeDrizzleKitConfig,
} from './drizzle-kit-config.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('DRIZZLE_STUDIO_CONFIG points under .local', () => {
  assertStringIncludes(DRIZZLE_STUDIO_CONFIG, '.local')
  assertStringIncludes(DRIZZLE_STUDIO_CONFIG, 'drizzle-studio.config.mjs')
})

test('writeDrizzleKitConfig rejects invalid URLs', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tp-drizzle-kit-' })
  try {
    await assertRejects(
      () => writeDrizzleKitConfig('not-a-postgres-url', join(dir, 'cfg.mjs')),
      Error,
      'invalid TURBOPANEL_DATABASE_URL',
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

test('writeDrizzleKitConfig emits socket credentials for ?host= URLs', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tp-drizzle-kit-' })
  const configPath = join(dir, 'nested', 'drizzle.config.mjs')
  try {
    await writeDrizzleKitConfig(
      'postgresql://tp:secret@/turbopanel?host=/run/turbopanel/postgres',
      configPath,
    )
    const content = await Deno.readTextFile(configPath)
    assertStringIncludes(content, 'host: "/run/turbopanel/postgres"')
    assertStringIncludes(content, 'user: "tp"')
    assertStringIncludes(content, 'password: "secret"')
    assertStringIncludes(content, 'database: "turbopanel"')
    assertEquals(content.includes('dialect: \'postgresql\''), true)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

test('writeDrizzleKitConfig emits url credentials for TCP URLs', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'tp-drizzle-kit-' })
  const configPath = join(dir, 'drizzle.config.mjs')
  const url = 'postgresql://tp:secret@127.0.0.1:5432/turbopanel'
  try {
    await writeDrizzleKitConfig(url, configPath)
    const content = await Deno.readTextFile(configPath)
    assertStringIncludes(content, `url: ${JSON.stringify(url)}`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
