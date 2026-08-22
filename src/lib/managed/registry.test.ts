import { assertEquals } from '@std/assert'
import {
  getCatalogEntry,
  MANAGED_ENGINE_CODES,
  readManagedEngineOptions,
} from '../../client/projects/catalog/index.ts'
import {
  getManagedBackupDescriptor,
  getManagedEngineSpec,
  isManagedEngineAvailable,
  listManagedEngineSpecs,
  MANAGED_ENGINE_STATUS,
  type ManagedEngineCode,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('MANAGED_ENGINE_STATUS covers every engine code', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    assertEquals(
      MANAGED_ENGINE_STATUS[code] === 'available' ||
        MANAGED_ENGINE_STATUS[code] === 'coming-soon',
      true,
      `missing status for ${code}`,
    )
  }
  assertEquals(Object.keys(MANAGED_ENGINE_STATUS).sort((a, b) => a.localeCompare(b)), [
    ...MANAGED_ENGINE_CODES,
  ].sort((a, b) => a.localeCompare(b)))
})

test('MANAGED_ENGINE_STATUS drives availability and specs', () => {
  for (const code of MANAGED_ENGINE_CODES) {
    const status = MANAGED_ENGINE_STATUS[code]
    const available = status === 'available'
    assertEquals(isManagedEngineAvailable(code), available)
    if (available) {
      assertEquals(getManagedEngineSpec(code)?.engine, code)
    } else {
      assertEquals(getManagedEngineSpec(code), null, code)
    }
  }
  assertEquals(getManagedEngineSpec('not-an-engine'), null)
  const listed = listManagedEngineSpecs().map((s) => s.engine).sort((a, b) =>
    a.localeCompare(b)
  )
  const expected = MANAGED_ENGINE_CODES.filter(
    (code) => MANAGED_ENGINE_STATUS[code] === 'available',
  ).sort((a, b) => a.localeCompare(b))
  assertEquals(listed, expected)
})

test('getManagedBackupDescriptor returns dump/sql for available engines or null', () => {
  const backup = getManagedBackupDescriptor('postgres')
  if (!backup) throw new TypeError('expected postgres backup descriptor')
  assertEquals(backup.artifactExtension, 'dump')
  assertEquals(getManagedBackupDescriptor('mysql')?.artifactExtension, 'sql')
  assertEquals(getManagedBackupDescriptor('mariadb')?.artifactExtension, 'sql')
  assertEquals(getManagedBackupDescriptor('redis'), null)
  assertEquals(getManagedBackupDescriptor('nope'), null)
})

test('catalog and spec agree for every code that has a spec', () => {
  for (const code of MANAGED_ENGINE_CODES as readonly ManagedEngineCode[]) {
    const spec = getManagedEngineSpec(code)
    if (!spec) continue
    const entry = getCatalogEntry(code)
    if (!entry) throw new TypeError(`missing catalog entry ${code}`)
    const options = readManagedEngineOptions(entry)
    if (!options) throw new TypeError(`missing options for ${code}`)
    assertEquals(options.engine, spec.engine)
    assertEquals(options.port, spec.defaultPort)
    assertEquals(options.rootUsername, spec.rootUsername)
    assertEquals(options.provider, spec.principalProvider)
    const services = entry.compose.data.services as Record<
      string,
      { image?: string }
    >
    assertEquals(services[code]?.image, spec.defaultImage)
  }
})
