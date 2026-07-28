import { assertEquals } from 'jsr:@std/assert'
import { renameComposeVolumes } from './rename-volumes.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('renameComposeVolumes rewrites top-level keys and short/long refs', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          volumes: [
            'cache:/var/cache',
            { type: 'volume', source: 'data', target: '/data' },
            './local:/app',
          ],
        },
      },
      volumes: {
        cache: {},
        data: { driver: 'local' },
      },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }

  const renames = new Map([
    ['cache', '01936b3e-aaaa-bbbb-cccc-123456789abc'],
    ['data', '01936b3e-dddd-eeee-ffff-123456789abc'],
  ])
  const result = renameComposeVolumes(document, renames)
  const volumes = result.data.volumes as Record<string, unknown>
  const web = (result.data.services as Record<string, Record<string, unknown>>).web!

  assertEquals(Object.keys(volumes).sort((a, b) => a.localeCompare(b)), [
    '01936b3e-aaaa-bbbb-cccc-123456789abc',
    '01936b3e-dddd-eeee-ffff-123456789abc',
  ])
  assertEquals(web.volumes, [
    '01936b3e-aaaa-bbbb-cccc-123456789abc:/var/cache',
    {
      type: 'volume',
      source: '01936b3e-dddd-eeee-ffff-123456789abc',
      target: '/data',
    },
    './local:/app',
  ])
})

test('renameComposeVolumes leaves bind mounts and unlisted keys alone', () => {
  const document: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          volumes: ['/host/path:/data', '../rel:/rel', 'keep:/keep'],
        },
      },
      volumes: { keep: {}, other: {} },
    },
    presentation: { keyOrder: ['services', 'volumes'], comments: {} },
  }
  const result = renameComposeVolumes(document, new Map([['missing', 'x']]))
  assertEquals(result.data.volumes, { keep: {}, other: {} })
  assertEquals(
    (result.data.services as Record<string, Record<string, unknown>>).web!.volumes,
    ['/host/path:/data', '../rel:/rel', 'keep:/keep'],
  )
})
