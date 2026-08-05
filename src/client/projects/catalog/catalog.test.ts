import { assertEquals } from 'jsr:@std/assert'
import { getManagedEngineSpec } from '../../../lib/managed/index.ts'
import {
  getCatalogEntry,
  isManagedEngineCatalogEntry,
  listCatalog,
  MANAGED_ENGINE_CODES,
  readManagedEngineOptions,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRINCIPAL_PROVIDERS = new Set([
  'server',
  'postgres',
  'mysql',
  'redis',
  'clickhouse',
])

test('listCatalog includes all managed engine codes as kind managed', () => {
  const byCode = new Map(listCatalog().map((entry) => [entry.code, entry]))
  for (const code of MANAGED_ENGINE_CODES) {
    const summary = byCode.get(code)
    assertEquals(summary?.kind, 'managed', `${code} missing or wrong kind`)
  }
})

test('isManagedEngineCatalogEntry is true for engines and false for templates', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    assertEquals(isManagedEngineCatalogEntry(entry), true)
  }

  const wordpress = getCatalogEntry('wordpress-mysql')
  if (!wordpress) throw new TypeError('missing wordpress-mysql')
  assertEquals(wordpress.kind, 'template')
  assertEquals(isManagedEngineCatalogEntry(wordpress), false)

  const staticSite = getCatalogEntry('static-site')
  if (!staticSite) throw new TypeError('missing static-site')
  assertEquals(isManagedEngineCatalogEntry(staticSite), false)
})

test('readManagedEngineOptions returns validated engine metadata', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    const options = readManagedEngineOptions(entry)
    if (!options) throw new TypeError(`expected engine options for ${code}`)
    assertEquals(options.engine, code)
    assertEquals(options.port > 0, true, `${code} port must be positive`)
    assertEquals(options.rootUsername.length > 0, true)
    assertEquals(
      PRINCIPAL_PROVIDERS.has(options.provider),
      true,
      `${code} provider ${options.provider} not in principal check set`,
    )
  }

  const wordpress = getCatalogEntry('wordpress-mysql')
  if (!wordpress) throw new TypeError('missing wordpress-mysql')
  assertEquals(wordpress.kind, 'template')
  assertEquals(readManagedEngineOptions(wordpress), null)
})

test('each managed engine declares one environment with one secret and no plaintext default', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    assertEquals(entry.environments.length, 1, `${code} environment count`)
    const variables = entry.environments[0]?.variables ?? []
    assertEquals(variables.length, 1, `${code} variable count`)
    const variable = variables[0]!
    assertEquals(variable.isSecret, true)
    assertEquals(variable.value, undefined)
  }
})

test('PRINCIPAL_PROVIDERS includes clickhouse and ClickHouse catalog uses it', () => {
  assertEquals(PRINCIPAL_PROVIDERS.has('clickhouse'), true)
  const entry = getCatalogEntry('clickhouse')
  if (!entry) throw new TypeError('missing clickhouse')
  const options = readManagedEngineOptions(entry)
  if (!options) throw new TypeError('expected clickhouse options')
  assertEquals(options.provider, 'clickhouse')
})

test('postgres catalog image equals managed engine spec default', () => {
  const spec = getManagedEngineSpec('postgres')
  if (!spec) throw new TypeError('postgres spec missing')
  const entry = getCatalogEntry('postgres')
  if (!entry) throw new TypeError('missing postgres')
  const services = entry.compose.data.services as Record<string, { image?: string }>
  assertEquals(services.postgres?.image, spec.defaultImage)
})
