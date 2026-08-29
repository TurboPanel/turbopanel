import { assert, assertEquals } from '@std/assert'
import {
  defaultManagedImage,
  defaultManagedRelease,
  describeManagedImage,
  isSameManagedSeries,
  MANAGED_ENGINE_RELEASES,
  managedAllowedImagesForEngine,
  managedCreatableReleasesForEngine,
  managedReleasesForEngine,
  requireDefaultManagedImage,
  resolveManagedImage,
} from './releases.ts'
import { MANAGED_ENGINE_SPECS } from './index.ts'
import {
  MARIADB_ALLOWED_IMAGES,
  MYSQL_ALLOWED_IMAGES,
  POSTGRES_ALLOWED_IMAGES,
} from './settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('catalog pins the catalogued series per engine', () => {
  assertEquals(
    managedReleasesForEngine('postgres').map((release) => release.series),
    ['18', '17', '16', '15'],
  )
  assertEquals(
    managedReleasesForEngine('mysql').map((release) => release.series),
    ['9.7', '8.4'],
  )
  assertEquals(
    managedReleasesForEngine('mariadb').map((release) => release.series),
    ['12.3', '11.8', '11.4', '10.11'],
  )
  // Engines with no shipped spec have no catalog.
  assertEquals(managedReleasesForEngine('redis'), [])
  assertEquals(managedReleasesForEngine('unknown'), [])
})

test('only the three verified series are creatable', () => {
  assertEquals(
    managedCreatableReleasesForEngine('postgres').map((r) => r.series),
    ['18'],
  )
  assertEquals(
    managedCreatableReleasesForEngine('mysql').map((r) => r.series),
    ['9.7'],
  )
  assertEquals(
    managedCreatableReleasesForEngine('mariadb').map((r) => r.series),
    ['12.3'],
  )
  assertEquals(managedCreatableReleasesForEngine('redis'), [])
})

test('the explicit gate is the only way to reach an untested series', () => {
  assertEquals(
    managedCreatableReleasesForEngine('postgres', { includeUntested: true }).map(
      (r) => r.series,
    ),
    ['18', '17', '16', '15'],
  )
  assertEquals(resolveManagedImage('postgres', '17'), undefined)
  assertEquals(
    resolveManagedImage('postgres', '17', undefined, { includeUntested: true }),
    'docker.io/library/postgres:17-alpine',
  )
  assertEquals(
    managedAllowedImagesForEngine('postgres', { includeUntested: true })?.length,
    8,
  )
})

test('exactly one default release per engine', () => {
  for (const engine of ['postgres', 'mysql', 'mariadb']) {
    const defaults = managedReleasesForEngine(engine).filter(
      (release) => release.isDefault,
    )
    assertEquals(defaults.length, 1)
  }
  assertEquals(defaultManagedRelease('postgres')?.series, '18')
  assertEquals(defaultManagedRelease('mysql')?.series, '9.7')
  assertEquals(defaultManagedRelease('mariadb')?.series, '12.3')
  assertEquals(defaultManagedRelease('redis'), undefined)
})

test('every release has a unique, non-empty variant list', () => {
  const seen = new Set<string>()
  for (const release of MANAGED_ENGINE_RELEASES) {
    assert(release.variants.length > 0)
    for (const variant of release.variants) {
      assert(
        !seen.has(variant.image),
        `duplicate catalog image: ${variant.image}`,
      )
      seen.add(variant.image)
    }
  }
})

test('engine specs resolve their default image from the catalog', () => {
  for (const [engine, spec] of Object.entries(MANAGED_ENGINE_SPECS)) {
    if (!spec) continue
    assertEquals(spec.defaultImage, defaultManagedImage(engine))
    assertEquals(requireDefaultManagedImage(spec.engine), spec.defaultImage)
  }
})

test('requireDefaultManagedImage throws for engines without a catalog', () => {
  try {
    requireDefaultManagedImage('redis' as 'postgres')
    throw new TypeError('expected requireDefaultManagedImage to throw')
  } catch (error) {
    assertEquals(error instanceof Error, true)
    assertEquals(
      (error as Error).message,
      'no managed release catalog entry for engine: redis',
    )
  }
})

test('settings allowlists are derived from the tested catalog only', () => {
  assertEquals(
    POSTGRES_ALLOWED_IMAGES,
    managedAllowedImagesForEngine('postgres'),
  )
  assertEquals(MYSQL_ALLOWED_IMAGES, managedAllowedImagesForEngine('mysql'))
  assertEquals(
    MARIADB_ALLOWED_IMAGES,
    managedAllowedImagesForEngine('mariadb'),
  )
  // Tested series only — both variants of each, catalog order.
  assertEquals(POSTGRES_ALLOWED_IMAGES, [
    'docker.io/library/postgres:18-alpine',
    'docker.io/library/postgres:18',
  ])
  assertEquals(MYSQL_ALLOWED_IMAGES, [
    'docker.io/library/mysql:9.7',
    'docker.io/library/mysql:9.7-oraclelinux9',
  ])
  assertEquals(MARIADB_ALLOWED_IMAGES, [
    'docker.io/library/mariadb:12.3',
    'docker.io/library/mariadb:12.3-ubi',
  ])
  // An untested series' image is not accepted anywhere.
  assert(!POSTGRES_ALLOWED_IMAGES.includes('docker.io/library/postgres:17'))
  assert(!MYSQL_ALLOWED_IMAGES.includes('docker.io/library/mysql:8.4'))
  assert(!MARIADB_ALLOWED_IMAGES.includes('docker.io/library/mariadb:11.8'))
  assertEquals(managedAllowedImagesForEngine('redis'), undefined)
})

test('resolveManagedImage maps series + variant to an image', () => {
  assertEquals(
    resolveManagedImage('postgres', '18'),
    'docker.io/library/postgres:18-alpine',
  )
  assertEquals(
    resolveManagedImage('postgres', '18', 'debian'),
    'docker.io/library/postgres:18',
  )
  assertEquals(
    resolveManagedImage('mysql', '9.7', 'oraclelinux9'),
    'docker.io/library/mysql:9.7-oraclelinux9',
  )
  assertEquals(
    resolveManagedImage('mariadb', '12.3', 'ubi'),
    'docker.io/library/mariadb:12.3-ubi',
  )
  // Unknown series / variant / engine → undefined (caller returns 422).
  assertEquals(resolveManagedImage('postgres', '14'), undefined)
  assertEquals(resolveManagedImage('postgres', '18', 'ubi'), undefined)
  assertEquals(resolveManagedImage('redis', '7'), undefined)
  // Untested but catalogued → also undefined without the gate.
  assertEquals(resolveManagedImage('postgres', '16'), undefined)
  assertEquals(resolveManagedImage('mysql', '8.4', 'oraclelinux9'), undefined)
  assertEquals(resolveManagedImage('mariadb', '11.4', 'ubi'), undefined)
})

test('describeManagedImage round-trips every catalog image', () => {
  for (const release of MANAGED_ENGINE_RELEASES) {
    for (const variant of release.variants) {
      assertEquals(describeManagedImage(variant.image), {
        engine: release.engine,
        series: release.series,
        lifecycle: release.lifecycle,
        tested: release.tested,
        variantId: variant.id,
      })
    }
  }
  assertEquals(
    describeManagedImage('docker.io/library/postgres:14'),
    undefined,
  )
  assertEquals(describeManagedImage('docker.io/library/redis:7'), undefined)
  // An untested series still resolves — an existing row must render its version.
  assertEquals(describeManagedImage('docker.io/library/mysql:8.4'), {
    engine: 'mysql',
    series: '8.4',
    lifecycle: 'lts',
    tested: false,
    variantId: 'debian',
  })
})

test('isSameManagedSeries allows variant swaps and blocks series changes', () => {
  assertEquals(
    isSameManagedSeries(
      'docker.io/library/postgres:18-alpine',
      'docker.io/library/postgres:18',
    ),
    true,
  )
  assertEquals(
    isSameManagedSeries(
      'docker.io/library/postgres:18-alpine',
      'docker.io/library/postgres:17-alpine',
    ),
    false,
  )
  // Cross-engine is never the same series.
  assertEquals(
    isSameManagedSeries(
      'docker.io/library/mysql:9.7',
      'docker.io/library/mariadb:12.3',
    ),
    false,
  )
  // Identical strings pass even outside the catalog; an uncatalogued change does not.
  assertEquals(
    isSameManagedSeries(
      'docker.io/library/redis:7',
      'docker.io/library/redis:7',
    ),
    true,
  )
  assertEquals(
    isSameManagedSeries(
      'docker.io/library/redis:7',
      'docker.io/library/redis:8',
    ),
    false,
  )
  // Nothing to compare (settings without an explicit image) is not a change.
  assertEquals(
    isSameManagedSeries(undefined, 'docker.io/library/mysql:9.7'),
    true,
  )
  assertEquals(
    isSameManagedSeries('docker.io/library/mysql:9.7', undefined),
    true,
  )
})
