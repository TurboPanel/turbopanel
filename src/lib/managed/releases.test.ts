import { assert, assertEquals } from '@std/assert'
import {
  defaultManagedImage,
  defaultManagedRelease,
  describeManagedImage,
  isSameManagedSeries,
  MANAGED_ENGINE_RELEASES,
  managedAllowedImagesForEngine,
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

test('catalog pins the supported series per engine', () => {
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

test('settings allowlists are derived from the catalog', () => {
  assertEquals(
    POSTGRES_ALLOWED_IMAGES,
    managedAllowedImagesForEngine('postgres'),
  )
  assertEquals(MYSQL_ALLOWED_IMAGES, managedAllowedImagesForEngine('mysql'))
  assertEquals(
    MARIADB_ALLOWED_IMAGES,
    managedAllowedImagesForEngine('mariadb'),
  )
  // Default series + default variant is the head of the derived list.
  assertEquals(
    POSTGRES_ALLOWED_IMAGES[0],
    'docker.io/library/postgres:18-alpine',
  )
  assertEquals(MYSQL_ALLOWED_IMAGES[0], 'docker.io/library/mysql:9.7')
  assertEquals(MARIADB_ALLOWED_IMAGES[0], 'docker.io/library/mariadb:12.3')
  assertEquals(managedAllowedImagesForEngine('redis'), undefined)
})

test('resolveManagedImage maps series + variant to an image', () => {
  assertEquals(
    resolveManagedImage('postgres', '16'),
    'docker.io/library/postgres:16-alpine',
  )
  assertEquals(
    resolveManagedImage('postgres', '16', 'debian'),
    'docker.io/library/postgres:16',
  )
  assertEquals(
    resolveManagedImage('mysql', '8.4', 'oraclelinux9'),
    'docker.io/library/mysql:8.4-oraclelinux9',
  )
  assertEquals(
    resolveManagedImage('mariadb', '11.4', 'ubi'),
    'docker.io/library/mariadb:11.4-ubi',
  )
  // Unknown series / variant / engine → undefined (caller returns 422).
  assertEquals(resolveManagedImage('postgres', '14'), undefined)
  assertEquals(resolveManagedImage('postgres', '16', 'ubi'), undefined)
  assertEquals(resolveManagedImage('redis', '7'), undefined)
})

test('describeManagedImage round-trips every catalog image', () => {
  for (const release of MANAGED_ENGINE_RELEASES) {
    for (const variant of release.variants) {
      assertEquals(describeManagedImage(variant.image), {
        engine: release.engine,
        series: release.series,
        lifecycle: release.lifecycle,
        variantId: variant.id,
      })
    }
  }
  assertEquals(
    describeManagedImage('docker.io/library/postgres:14'),
    undefined,
  )
  assertEquals(describeManagedImage('docker.io/library/redis:7'), undefined)
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
